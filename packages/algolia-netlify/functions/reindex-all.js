// --- top of file ---
const IndexFactory = require('@tryghost/algolia-indexer');
console.log("🚀 reindex-all function loaded!");


// ---- copy these from your post-published.js for consistency ----
const MAX_CHUNK_BYTES = 5500;
const JSON_SOFT_LIMIT = 9500;
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
  const bytes = Buffer.from(String(str || ''), 'utf8');
  for (let offset = 0; offset < bytes.length; offset += limit) {
    const slice = bytes.subarray(offset, Math.min(offset + limit, bytes.length));
    out.push(slice.toString('utf8'));
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

exports.handler = async () => {
  console.log('🚀 Starting full reindex…');

  const GHOST_URL = process.env.GHOST_URL;
  const GHOST_CONTENT_KEY = process.env.GHOST_CONTENT_KEY;
  if (!GHOST_URL || !GHOST_CONTENT_KEY) {
    console.error('❌ Missing GHOST_URL or GHOST_CONTENT_KEY env vars.');
    return { statusCode: 500, body: 'Missing Ghost config.' };
  }

  const api = `${GHOST_URL}/ghost/api/content/posts/?key=${GHOST_CONTENT_KEY}&limit=all&include=authors,tags`;
  const res = await fetch(api);
  if (!res.ok) {
    console.error('Ghost API error:', res.status, res.statusText);
    return { statusCode: 500, body: `Ghost API error ${res.status}` };
  }

  const { posts } = await res.json();
  console.log(`Fetched ${posts.length} posts from Ghost.`);

  const records = [];
  for (const post of posts) {
    const text =
      (post.plaintext && String(post.plaintext).trim()) ||
      (post.html && stripHtml(post.html)) ||
      post.custom_excerpt ||
      post.title ||
      '';
    if (!text) continue;

    const chunks = chunkByBytes(text, MAX_CHUNK_BYTES);
    const base = {
      postId: post.id,
      title: post.title || '',
      slug: post.slug || '',
      url: post.url || '',
      published_at: post.published_at || null,
      primary_tag: (post.primary_tag && (post.primary_tag.name || post.primary_tag.slug)) || null,
      tags: flattenTags(post.tags),
      authors: flattenAuthors(post.authors)
    };

    chunks.forEach((txt, i) => {
      let rec = { ...base, objectID: `${post.id}_${i}`, chunkIndex: i, plaintext: txt };
      if (bLen(JSON.stringify(rec)) > JSON_SOFT_LIMIT) {
        rec.plaintext = clampByBytes(rec.plaintext, MAX_CHUNK_BYTES - 1200);
      }
      records.push(rec);
    });
  }

  console.log(`Prepared ${records.length} records. Uploading to Algolia…`);

  const index = new IndexFactory({
    appId: process.env.ALGOLIA_APP_ID,
    apiKey: process.env.ALGOLIA_ADMIN_API_KEY,
    index: process.env.ALGOLIA_INDEX_NAME
  });

  // clear old data first
  await index.clearIndex();

  await index.setSettingsForIndex({
    searchableAttributes: ['title', 'unordered(plaintext)'],
    attributesToSnippet: ['plaintext:30'],
    snippetEllipsisText: '…',
    attributesToHighlight: ['title', 'plaintext'],
    restrictHighlightAndSnippetArrays: true,
    distinct: true,
    attributeForDistinct: 'postId',
    customRanking: ['desc(published_at)']
  });

  await index.save(records);
  console.log(`✅ Reindex complete. ${records.length} total records saved.`);

  return { statusCode: 200, body: `Reindexed ${records.length} records` };
};
