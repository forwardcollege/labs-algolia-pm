const IndexFactory = require('@tryghost/algolia-indexer');
const transforms = require('@tryghost/algolia-fragmenter');

exports.handler = async (event) => {
    // We only support POST
    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            body: 'Method Not Allowed'
        };
    }

    const { key } = event.queryStringParameters;

    // Optional key check
    if (key && key !== process.env.NETLIFY_KEY) {
        return {
            statusCode: 401,
            body: `Unauthorized`
        };
    }

    if (process.env.ALGOLIA_ACTIVE !== 'TRUE') {
        return {
            statusCode: 200,
            body: `Algolia is not activated`
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
                body: `No valid request body detected`
            };
        }

        // ✅ Use plaintext directly if html is not provided
        if (!post.html && post.plaintext) {
            post.html = `<p>${post.plaintext}</p>`;
            console.log('Using plaintext directly for indexing.');
        }

        console.log(`Processing post: "${post.title}" (slug: ${post.slug})`);

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

        const index = new IndexFactory(algoliaSettings);
        await index.setSettingsForIndex();
        await index.save(fragments);

        console.log('Fragments successfully saved to Algolia index');
        return {
            statusCode: 200,
            body: `Post "${post.title}" has been added to the index.`
        };
    } catch (error) {
        console.error('ALGOLIA_ERROR: An error occurred during indexing.');
        console.error(error);
        return {
            statusCode: 500,
            body: JSON.stringify({ msg: 'An error occurred during indexing.', error: error.message })
        };
    }
};