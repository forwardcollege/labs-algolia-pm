const IndexFactory = require('@tryghost/algolia-indexer');

// --- byte-safe helpers ---
const MAX_CHUNK_BYTES = 6000;  // <= 6 KB per text chunk to leave room for metadata
const JSON_HARD_LIMIT  = 10000; // Algolia hard limit (bytes)
const JSON_SOFT_LIMIT  = 9500;  // keep a buffer to avoid surprises

function bLen(str) {
  if (str == null) return 0;
  return Buffer.byteLength(String(str), 'utf8');
}

function clampByBytes(str, limit) {
  if (!str) return str;
  str = String(str);
  if (bLen(str) <= limit) return str;
  let lo = 0, hi = str.length, ans = '';
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const slice = str.slice(0, mid);
    if (bLen(slice) <= limit) { ans = slice; lo = mid + 1; }
    else { hi = mid - 1; }
  }
  return ans;
}

function chunkByBytes(str, bytesLimit) {
  const out = [];
  let start = 0;
  str = String(str || '');
  while (start < str.length) {
    let lo = start, hi = str.length, best = start;
    while (lo <= hi) {
      const mid = Math.min(start + Math.floor((lo + hi) / 2), str.length);
      const slice = str.slice(start, mid);
      if (bLen(slice) <= bytesLimit) { best = mid; lo = mid + 1; }
      else { hi = mid - 1; }
    }
    if (best === start) break; // safety
    out.push(str.slice(start, best));
    start = best;
  }
  return out;
}

// Iteratively slim a record until it's < JSON_SOFT_LIMIT
function slimRecord(rec) {
  // Never send html
  if (rec.html) delete rec.html;

  // Start with conservative trims
  if (rec.title) rec.title = clampByBytes(rec.title, 512);
  if (rec.slug) rec.slug = clampByBytes(rec.slug, 512);
  if (rec.url) rec.url = clampByBytes(rec.url, 1024);
  if (rec.excerpt) rec.excerpt = clampByBytes(rec.excerpt, 512);
  if (rec.feature_image) delete rec.feature_image; // often long URLs; drop from index

  // Flatten authors/tags to lightweight arrays of names/ids (short)
  if (Array.isArray(rec.authors)) {
    const names = rec.authors.map(a => (a && (a.name || a.slug || a.id)) || '').filter(Boolean);
    rec.authors = names.slice(0, 5); // keep up to 5
  }
  if (Array.isArray(rec.tags)) {
    const tags = rec.tags.map(t => (t && (t.name || t.slug || t.id)) || '').filter(Boolean);
    rec.tags = tags.slice(0, 10); // keep up to 10
  }

  // Primary tag -> short string
  if (rec.primary_tag && typeof rec.primary_tag === 'object') {
    rec.primary_tag = rec.primary_tag.name || rec.primary_tag.slug || rec.primary_tag.id || null;
  }

  // Now ensure JSON size
  let size = bLen(JSON.stringify(rec));
  if (size <= JSON_SOFT_LIMIT) return rec;

  // Progressive strategy:
  // 1) Trim plaintext down in steps
  // 2) Drop less critical fields if still too large
  const STEP = 512; // bytes to shave per iteration
  const MIN_TEXT = 2048; // don't go below ~2 KB unless necessary

  while (size > JSON_SOFT_LIMIT) {
    if (rec.plaintext && bLen(rec.plaintext) > MIN_TEXT) {
      rec.plaintext = clampByBytes(rec.plaintext, bLen(rec.plaintext) - STEP);
    } else if (rec.excerpt) {
      delete rec.excerpt;
    } else if (rec.tags && rec.tags.length) {
      rec.tags = rec.tags.slice(0, Math.max(0, rec.tags.length - 2));
    } else if (rec.authors && rec.authors.length) {
      rec.authors = rec.authors.slice(0, Math.max(0, rec.authors.length - 1));
    } else {
      // As a last resort, clamp plaintext further
      rec.plaintext = clampByBytes(rec.plaintext || '', Math.max(MIN_TEXT, bLen(rec.plaintext || '') - STEP));
    }

    size = bLen(JSON.stringify(rec));
    if (size <= JSON_SOFT_LIMIT) break;

    // Absolute safety: if still over hard limit, force trim plaintext to fit
    if (size > JSON_HARD_LIMIT) {
      const overhead = size - bLen(rec.plaintext || '');
      const budgetForText = Math.max(1024, JSON_SOFT_LIMIT - overhead);
      rec.plaintext = clampByBytes(rec.plaintext || '', budgetForText);
      size = bLen(JSON.stringify(rec));
      break;
    }
  }

  return rec;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const { key } = event.queryStringParameters || {};
  if (key && key !== process.env.NETLIFY_KEY) {
    return { statusCode: 401, body: 'Unauthorized' };
  }

  if (process.env.ALGOLIA_ACTIVE !== 'TRUE') {
    return { statusCode: 200, body: 'Algolia is not activated' };
  }

  const algoliaSettings = {
    appId: process.env.ALGOLIA_APP_ID,
    apiKey: process.env.ALGOLIA_ADMIN_API_KEY,
    index: process.env.ALGOLIA_INDEX_NAME
  };

  try {
    let { post } = JSON.parse(event.body || '{}');
    post = (post && post.current && Object.keys(post.current).length > 0 && post.current) || {};

    if (!post || Object.keys(post).length < 1) {
      return { statusCode: 200, body: 'No valid request body detected' };
    }

    // Prefer plaintext; fallback to excerpt/html/title
    let content = post.plaintext || post.custom_excerpt || post.html || post.title || '';
    if (!content || String(content).trim().length === 0) {
      return { statusCode: 200, body: `Post "${post.title || ''}" has no content to index.` };
    }

    // Allow big source, we’ll chunk it
    const safeSource = clampByBytes(content, 600000); // ~600 KB upper cap
    const chunks = chunkByBytes(safeSource, MAX_CHUNK_BYTES);
    if (!chunks.length) {
      return { statusCode: 200, body: `Post "${post.title || ''}" had no valid chunks to index.` };
    }

    const base = {
      postId: post.id,
      title: post.title || '',
      slug: post.slug || '',
      url: post.url || '',
      published_at: post.published_at || null,
      primary_tag: post.primary_tag || null,
      tags: post.tags || [],
      authors: post.authors || [],
      // NOTE: deliberately exclude feature_image to save bytes
    };

    // Build records + slim them to fit
    const records = chunks.map((text, i) => {
      const rec = {
        ...base,
        objectID: `${post.id}_${i}`,
        chunkIndex: i,
        plaintext: text
      };
      const slim = slimRecord(rec);
      const size = bLen(JSON.stringify(slim));
      console.log(`Record ${slim.objectID} size after slim: ${size} bytes`);
      return slim;
    });

    // Final guard: ensure ALL records < hard limit
    for (const r of records) {
      const size = bLen(JSON.stringify(r));
      if (size > JSON_HARD_LIMIT) {
        console.warn(`Record ${r.objectID} still exceeds ${JSON_HARD_LIMIT} (${size}). Forcing clamp.`);
        // last-resort clamp
        const overhead = size - bLen(r.plaintext || '');
        const budget = Math.max(1024, JSON_SOFT_LIMIT - overhead);
        r.plaintext = clampByBytes(r.plaintext || '', budget);
      }
    }

    const index = new IndexFactory(algoliaSettings);

    // Optional: enforce settings here so dashboard/manual changes aren't required
    await index.setSettingsForIndex({
      searchableAttributes: ['title', 'plaintext'],
      attributesForFaceting: ['primary_tag', 'tags', 'authors'],
      customRanking: ['desc(published_at)'],
      distinct: true,
      attributeForDistinct: 'postId'
    });

    await index.save(records);

    return {
      statusCode: 200,
      body: `Post "${post.title || ''}" indexed into ${records.length} chunk(s).`
    };
  } catch (error) {
    console.error('ALGOLIA_ERROR:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ msg: 'An error occurred during indexing.', error: error.message })
    };
  }
};