const IndexFactory = require('@tryghost/algolia-indexer');
const transforms = require('@tryghost/algolia-fragmenter'); // still imported for consistency

// --- byte-safe helpers ---
const MAX_RECORD_BYTES = 8000; // each chunk under 10k
const JSON_SOFT_LIMIT = 9500;  // safety margin for full record

function byteLen(str) {
    if (!str) return 0;
    return Buffer.byteLength(String(str), 'utf8');
}

function clampByBytes(str, limit = MAX_RECORD_BYTES) {
    if (!str) return str;
    str = String(str);
    if (byteLen(str) <= limit) return str;
    let lo = 0, hi = str.length, ans = '';
    while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        const slice = str.slice(0, mid);
        if (byteLen(slice) <= limit) {
            ans = slice;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return ans;
}

// --- new helper: chunk by bytes for long posts ---
function chunkByBytes(str, bytesLimit = MAX_RECORD_BYTES) {
    const out = [];
    let start = 0;
    str = String(str || '');
    while (start < str.length) {
        let lo = start, hi = str.length, best = start;
        while (lo <= hi) {
            const mid = Math.min(start + Math.floor((lo + hi) / 2), str.length);
            const slice = str.slice(start, mid);
            if (byteLen(slice) <= bytesLimit) {
                best = mid;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }
        if (best === start) break; // prevent infinite loop
        out.push(str.slice(start, best));
        start = best;
    }
    return out;
}

exports.handler = async (event) => {
    // Allow POST only
    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            body: 'Method Not Allowed'
        };
    }

    const { key } = event.queryStringParameters || {};

    // Optional key check
    if (key && key !== process.env.NETLIFY_KEY) {
        return {
            statusCode: 401,
            body: 'Unauthorized'
        };
    }

    if (process.env.ALGOLIA_ACTIVE !== 'TRUE') {
        return {
            statusCode: 200,
            body: 'Algolia is not activated'
        };
    }

    console.log('Starting Algolia indexing for post-published...');

    const algoliaSettings = {
        appId: process.env.ALGOLIA_APP_ID,
        apiKey: process.env.ALGOLIA_ADMIN_API_KEY,
        index: process.env.ALGOLIA_INDEX_NAME
    };

    try {
        let { post } = JSON.parse(event.body);
        post = (post && post.current && Object.keys(post.current).length > 0 && post.current) || {};

        if (!post || Object.keys(post).length < 1) {
            console.log('No valid post data found in request. Exiting.');
            return {
                statusCode: 200,
                body: 'No valid request body detected'
            };
        }

        console.log(`Processing post: "${post.title}" (slug: ${post.slug})`);

        // prefer plaintext
        let content = post.plaintext || post.custom_excerpt || post.html || post.title || '';
        if (!content || content.trim().length === 0) {
            console.log('No content to index for this post.');
            return {
                statusCode: 200,
                body: `Post "${post.title}" has no content to index.`
            };
        }

        // Clamp extremely long content to a sane total length before chunking
        const safeText = clampByBytes(content, 600000); // allow ~600k bytes total before chunking
        const chunks = chunkByBytes(safeText, MAX_RECORD_BYTES);

        console.log(`Generated ${chunks.length} chunks for indexing.`);

        if (chunks.length === 0) {
            return {
                statusCode: 200,
                body: `Post "${post.title}" had no valid chunks to index.`
            };
        }

        const base = {
            postId: post.id,
            title: post.title,
            slug: post.slug,
            url: post.url,
            published_at: post.published_at,
            primary_tag: post.primary_tag || null,
            tags: post.tags || [],
            authors: post.authors || [],
            feature_image: post.feature_image || null
        };

        const records = chunks.map((text, i) => ({
            ...base,
            objectID: `${post.id}_${i}`,
            chunkIndex: i,
            plaintext: text
        }));

        // Double-check record sizes
        for (const rec of records) {
            const size = byteLen(JSON.stringify(rec));
            if (size > JSON_SOFT_LIMIT) {
                console.warn(
                    `⚠️ Record ${rec.objectID} is ${size} bytes — trimming excerpt.`
                );
                rec.plaintext = clampByBytes(rec.plaintext, MAX_RECORD_BYTES);
            }
        }

        const index = new IndexFactory(algoliaSettings);
        await index.setSettingsForIndex();
        await index.save(records);

        console.log(`Saved ${records.length} records for "${post.title}".`);
        return {
            statusCode: 200,
            body: `Post "${post.title}" has been indexed into ${records.length} chunks.`
        };
    } catch (error) {
        console.error('ALGOLIA_ERROR: An error occurred during indexing.');
        console.error(error);
        return {
            statusCode: 500,
            body: JSON.stringify({
                msg: 'An error occurred during indexing.',
                error: error.message
            })
        };
    }
};