const IndexFactory = require('@tryghost/algolia-indexer');

// -------- helpers ------------------------------------------------
const MAX_CHUNK_BYTES = 5500;  // smaller chunks to keep JSON < 10KB incl. metadata
const JSON_SOFT_LIMIT  = 9500;

const bLen = (s) => Buffer.byteLength(String(s || ''), 'utf8');

function clampByBytes(str, limit) {
  if (!str) return str;
  str = String(str);
  if (bLen(str) <= limit) return str;
  let lo = 0, hi = str.length, ans = '';
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const slice = str.slice(0, mid);
    if (bLen(slice) <= limit) { ans = slice; lo = mid + 1; } else { hi = mid - 1; }
  }
  return ans;
}

function chunkByBytes(str, limit = MAX_CHUNK_BYTES) {
  const out = [];
  let start = 0;
  str = String(str || '');
  while (start < str.length) {
    let lo = start, hi = str.length, best = start;
    while (lo <= hi) {
      const mid = Math.min(start + Math.floor((lo + hi) / 2), str.length);
      const slice = str.slice(start, mid);
      if (bLen(slice) <= limit) { best = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    if (best === start) break;
    out.push(str.slice(start, best));
    start = best;
  }
  return out;
}

function stripHtml(html = '') {
  return String(html)
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function flattenAuthors(authors) {
  if (!Array.isArray(authors)) return [];
  return authors.map(a => (a && (a.name || a.slug || a.id)) || '').filter(Boolean).slice(0, 5);
}

function flattenTags(tags) {
  if (!Array.isArray(tags)) return [];
  return tags.map(t => (t && (t.name || t.slug || t.id)) || '').filter(Boolean).slice(0, 10);
}
// ----------------------------------------------------------------

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }
  const { key } = event.queryStringParameters || {};
  if (key && key !== process.env.NETLIFY_KEY) {
    return { statusCode: 401, body: 'Unauthorized' };
  }
  if (process.env.ALGOLIA_ACTIVE !== 'TRUE') {
    return { statusCode: 200, body: 'Algolia inactive' };
  }

  console.log('🚀 post-published: start');
  console.log('Headers UA:', event.headers && event.headers['user-agent']);
  console.log('Body length:', event.body ? bLen(event.body) : 0, 'isBase64:', !!event.isBase64Encoded);

  // --- decode body safely (handle base64) -----------------------
  let raw = event.body || '{}';
  if (event.isBase64Encoded) {
    try {
      raw = Buffer.from(event.body, 'base64').toString('utf8');
      console.log('Decoded base64 body. New length:', bLen(raw));
    } catch (e) {
      console.warn('Failed to decode base64 body:', e.message);
    }
  }

  // --- parse JSON with diagnostics --------------------------------
  let payload = {};
  try {
    payload = JSON.parse(raw);
  } catch (e) {
    console.error('JSON parse error:', e.message);
    return { statusCode: 200, body: 'Invalid JSON body' };
  }

  // Ghost can send various shapes; normalize them:
  // - { post: { current: {...} } }
  // - { post: {...} }
  // - { posts: [ {...} ] }
  // - or raw post object itself
  let post =
    (payload.post && payload.post.current) ||
    payload.post ||
    (Array.isArray(payload.posts) && payload.posts[0]) ||
    (payload.current) ||
    payload;

  if (!post || typeof post !== 'object' || !Object.keys(post).length) {
    console.log('No valid post object resolved from payload keys:', Object.keys(payload || {}));
    return { statusCode: 200, body: 'No valid post found' };
  }

  console.log('Post keys:', Object.keys(post));
  console.log('Post id:', post.id, 'slug:', post.slug, 'title:', post.title);

  // --- build text ---------------------------------------------------
  // Prefer plaintext; if missing, derive from HTML; else fall back to excerpt/title
  let text = '';
  if (post.plaintext && String(post.plaintext).trim().length) {
    text = String(post.plaintext);
    console.log('Using post.plaintext');
  } else if (post.html && String(post.html).trim().length) {
    text = stripHtml(post.html);
    console.log('Using stripped post.html');
  } else if (post.custom_excerpt) {
    text = String(post.custom_excerpt);
    console.log('Using post.custom_excerpt');
  } else if (post.title) {
    text = String(post.title);
    console.log('Using post.title only');
  }

if (!text.trim().length) {
    console.log('No content to index after normalization.');
    return { statusCode: 200, body: 'No content to index' };
  }

  // ---- safer linear chunker ----
  const bytes = Buffer.from(text, 'utf8');
  const total = bytes.length;
  const chunks = [];
  for (let offset = 0; offset < total; offset += MAX_CHUNK_BYTES) {
    const slice = bytes.subarray(offset, Math.min(offset + MAX_CHUNK_BYTES, total));
    chunks.push(slice.toString('utf8'));
  }
  console.log(`Chunks generated: ${chunks.length} (total ${total} bytes)`);

  if (!chunks.length) {
    return { statusCode: 200, body: 'No chunks to index' };
  }

  // --- construct records --------------------------------------------
  const base = {
    postId: post.id || (post.uuid || ''),
    title: post.title || '',
    slug: post.slug || '',
    url: post.url || '',
    published_at: post.published_at || null,
    primary_tag: (post.primary_tag && (post.primary_tag.name || post.primary_tag.slug || post.primary_tag.id)) || null,
    tags: flattenTags(post.tags),
    authors: flattenAuthors(post.authors)
    // exclude feature_image to save bytes
  };

  const records = chunks.map((txt, i) => {
    let rec = {
      ...base,
      objectID: `${base.postId || 'post'}_${i}`,
      chunkIndex: i,
      plaintext: txt
    };
    // ensure full JSON stays under soft limit
    if (bLen(JSON.stringify(rec)) > JSON_SOFT_LIMIT) {
      rec.plaintext = clampByBytes(rec.plaintext, MAX_CHUNK_BYTES - 1200); // aggressive trim for metadata room
    }
    return rec;
  });

  console.log('Record[0] size:', bLen(JSON.stringify(records[0] || {})));
  if (records[1]) console.log('Record[1] size:', bLen(JSON.stringify(records[1])));

  try {
    const index = new IndexFactory({
      appId: process.env.ALGOLIA_APP_ID,
      apiKey: process.env.ALGOLIA_ADMIN_API_KEY,
      index: process.env.ALGOLIA_INDEX_NAME
    });

    // Keep settings in code so they don’t drift
    await index.setSettingsForIndex({
      searchableAttributes: ['title', 'plaintext'],
      customRanking: ['desc(published_at)'],
      distinct: true,
      attributeForDistinct: 'postId'
    });

    await index.save(records);
    console.log(`✅ Saved ${records.length} records for "${post.title}"`);
    return { statusCode: 200, body: `Indexed ${records.length} chunk(s)` };
  } catch (e) {
    console.error('ALGOLIA_ERROR:', e && e.message);
    return { statusCode: 500, body: JSON.stringify({ error: e && e.message }) };
  }
};
