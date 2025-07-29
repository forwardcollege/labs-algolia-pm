const IndexFactory = require('@tryghost/algolia-indexer');

exports.handler = async (event) => {
    // Only allow POST
    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            body: 'Method Not Allowed'
        };
    }

    const { key } = event.queryStringParameters;

    // Optional API key check
    if (key && key !== process.env.NETLIFY_KEY) {
        return {
            statusCode: 401,
            body: 'Unauthorized'
        };
    }

    // Skip if Algolia integration isn't enabled
    if (process.env.ALGOLIA_ACTIVE !== 'TRUE') {
        return {
            statusCode: 200,
            body: 'Algolia is not activated'
        };
    }

    console.log('User-Agent:', event.headers['user-agent']);
    console.log('Starting Algolia deletion for post-unpublished...');

    const algoliaSettings = {
        appId: process.env.ALGOLIA_APP_ID,
        apiKey: process.env.ALGOLIA_ADMIN_API_KEY,
        index: process.env.ALGOLIA_INDEX_NAME
    };

    const { apiKey, ...safeSettings } = algoliaSettings;
    console.log('Using Algolia settings:', safeSettings);

    try {
        console.log('Received body from Ghost:', event.body);
        const { post } = JSON.parse(event.body);

        // Look for post data in current or previous (deleted) versions
        const postData =
            (post.current && Object.keys(post.current).length && post.current) ||
            (post.previous && Object.keys(post.previous).length && post.previous) ||
            null;

        if (!postData || !postData.slug) {
            console.log('No valid slug found in post data. Exiting.');
            return {
                statusCode: 200,
                body: 'No valid request body detected'
            };
        }

        const { slug, title } = postData;

        console.log(`Processing deletion for slug: "${slug}" (title: "${title}")`);

        const index = new IndexFactory(algoliaSettings);
        await index.initIndex();
        await index.delete(slug);

        console.log(`Fragments for slug "${slug}" successfully removed from Algolia index`);
        return {
            statusCode: 200,
            body: `Post "${slug}" has been removed from the index.`
        };
    } catch (error) {
        console.error('ALGOLIA_ERROR: An error occurred during deletion.');
        console.error(error);
        return {
            statusCode: 500,
            body: JSON.stringify({
                msg: 'An error occurred during deletion.',
                error: error.message
            })
        };
    }
};
