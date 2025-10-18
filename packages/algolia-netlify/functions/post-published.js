const IndexFactory = require('@tryghost/algolia-indexer');
const transforms = require('@tryghost/algolia-fragmenter');

// --- byte-safe clamp helpers (Node/Lambda friendly) ---
const MAX_RECORD_BYTES = 8000; // stay well under Algolia's 10k hard limit
const JSON_SOFT_LIMIT = 9500;  // soft ceiling for full record

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

    console.log('User-Agent:', event.headers['user-agent']);
    console.log('Starting Algolia indexing for post-published...');

    const algoliaSettings = {
        appId: process.env.ALGOLIA_APP_ID,
        apiKey: process.env.ALGOLIA_ADMIN_API_KEY,
        index: process.env.ALGOLIA_INDEX_NAME
    };

    const { apiKey, ...safeSettings } = algoliaSettings;
    console.log('Using Algolia settings:', safeSettings);

    try {
        console.log('Received body from Ghost:', event.body);
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

        const hasTextInHtml = post.html && post.html.replace(/<[^>]*>/g, '').trim().length > 0;

        // Prefer plaintext; avoid inflating size by wrapping into HTML
        if (!hasTextInHtml) {
            if (post.custom_excerpt) {
                post.plaintext = clampByBytes(post.custom_excerpt, MAX_RECORD_BYTES);
            } else if (post.plaintext) {
                post.plaintext = clampByBytes(post.plaintext, MAX_RECORD_BYTES);
            } else if (post.title) {
                post.plaintext = clampByBytes(post.title, MAX_RECORD_BYTES);
            }
            delete post.html;
            console.log('Using plaintext-based content for indexing.');
        } else {
            // html exists; still prefer trimmed plaintext if available
            if (post.plaintext) {
    const safeText = clampByBytes(post.plaintext, MAX_RECORD_BYTES);
    post.plaintext = safeText;
    post.html = `<p>${safeText}</p>`; // small, safe HTML wrapper for fragmenter
    console.log('HTML replaced with safe, truncated plaintext wrapper.');
}
        }

        // Convert Ghost post → Algolia fragments
        const node = [post];
        const algoliaObject = transforms.transformToAlgoliaObject(node);
        console.log('Transformed to Algolia object.');

        const fragments = algoliaObject.reduce(transforms.fragmentTransformer, []);
        console.log(`Created ${fragments.length} fragments to be indexed.`);

        if (fragments.length === 0) {
            console.log('No fragments were created, nothing to index. Exiting.');
            return {
                statusCode: 200,
                body: `Post "${post.title}" did not generate any fragments for indexing.`
            };
        }

        // Final safeguard: clamp any oversized fragment fields
        const safeFragments = fragments.map((frag) => {
            if (frag.plaintext) frag.plaintext = clampByBytes(frag.plaintext, MAX_RECORD_BYTES);
            if (frag.html) delete frag.html; // never send html to Algolia

            let bytes = byteLen(JSON.stringify(frag));
            if (bytes > JSON_SOFT_LIMIT && frag.excerpt) {
                frag.excerpt = clampByBytes(frag.excerpt, 600);
            }

            return frag;
        });

        const index = new IndexFactory(algoliaSettings);
        await index.setSettingsForIndex();
        await index.save(safeFragments);

        console.log('Fragments successfully saved to Algolia index.');
        return {
            statusCode: 200,
            body: `Post "${post.title}" has been added to the index.`
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