const express = require('express');
const gplay = require('google-play-scraper');

const app = express();

// 1. Global Middleware & Security Configuration
app.use(express.json());

// Built-in CORS handler for smooth cross-origin consumption
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

// 2. Async Handler Wrapper to eliminate unhandled code rejections cleanly
const asyncHandler = (fn) => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
};

// 3. API Routes

/**
 * GET /
 * Health Check Endpoint
 */
app.get('/', (req, res) => {
    res.status(200).json({
        status: 'success',
        message: 'Google Play Store Scraper API is online.'
    });
});

/**
 * GET /app
 * Fetches and structures deep data/metadata for a single package identifier.
 */
app.get('/app', asyncHandler(async (req, res) => {
    const { appId, lang = 'en', country = 'us' } = req.query;

    // Strict validation check for input parameters
    if (!appId || typeof appId !== 'string' || !appId.trim()) {
        return res.status(400).json({
            status: 'fail',
            error: "Missing or invalid required query string: 'appId'."
        });
    }

    try {
        const data = await gplay.app({ appId: appId.trim(), lang, country });
        
        // Return structured, type-safe data payload
        return res.status(200).json({
            status: 'success',
            data: {
                appId: data.appId,
                title: data.title,
                summary: data.summary || '',
                description: data.description || '',
                developer: {
                    name: data.developer,
                    id: data.developerId,
                    email: data.developerEmail || null,
                    website: data.developerWebsite || null,
                    address: data.developerAddress || null
                },
                metrics: {
                    score: data.score || 0,
                    scoreText: data.scoreText || "0",
                    ratings: data.ratings || 0,
                    reviews: data.reviews || 0,
                    installs: data.installs || "0+",
                    price: data.price || 0,
                    free: data.free ?? true,
                    currency: data.currency || "USD"
                },
                metadata: {
                    genre: data.genre || 'Unknown',
                    genreId: data.genreId || 'Unknown',
                    contentRating: data.contentRating || 'Everyone',
                    released: data.released || null,
                    updated: data.updated ? new Date(data.updated).toISOString() : null,
                    version: data.version || 'Varies with device'
                },
                media: {
                    icon: data.icon || null,
                    headerImage: data.headerImage || null,
                    screenshots: data.screenshots || [],
                    video: data.video || null,
                    videoImage: data.videoImage || null
                }
            }
        });
    } catch (error) {
        // Differentiate between a clean 404 (Not Found) vs a 500 downstream network failure
        const isNotFound = error.message && error.message.toLowerCase().includes('not found');
        const statusCode = isNotFound ? 404 : 500;
        
        return res.status(statusCode).json({
            status: 'error',
            message: isNotFound ? `App with package ID '${appId}' could not be located.` : 'Downstream connection failure.',
            ...(process.env.NODE_ENV !== 'production' && { debug_details: error.message })
        });
    }
}));

/**
 * GET /search
 * Executes a scoped keyword search across global listings.
 */
app.get('/search', asyncHandler(async (req, res) => {
    const { query, lang = 'en', country = 'us', limit = '20' } = req.query;

    if (!query || typeof query !== 'string' || !query.trim()) {
        return res.status(400).json({
            status: 'fail',
            error: "Missing or invalid required query string: 'query'."
        });
    }

    const parsedLimit = parseInt(limit, 10);
    if (isNaN(parsedLimit) || parsedLimit <= 0) {
        return res.status(400).json({
            status: 'fail',
            error: "Query parameter 'limit' must be a valid positive integer."
        });
    }

    // Performance protection: limit maximum records processed per execution block
    const finalLimit = Math.min(parsedLimit, 100);

    try {
        const results = await gplay.search({
            term: query.trim(),
            lang,
            country,
            num: finalLimit
        });

        const formattedResults = results.map(appItem => ({
            appId: appItem.appId,
            title: appItem.title,
            developer: appItem.developer,
            score: appItem.score || 0,
            price: appItem.price || 0,
            free: appItem.free ?? true,
            icon: appItem.icon || null,
            screenshots: appItem.screenshots || []
        }));

        return res.status(200).json({
            status: 'success',
            resultsCount: formattedResults.length,
            data: formattedResults
        });
    } catch (error) {
        return res.status(500).json({
            status: 'error',
            message: 'Failed to complete store query search lookup operations.',
            ...(process.env.NODE_ENV !== 'production' && { debug_details: error.message })
        });
    }
}));

// 4. Centralized Global Fallback Error Handler Middleware
app.use((err, req, res, next) => {
    console.error('Unhandled Internal Engine Exception:', err.stack || err);
    
    res.status(500).json({
        status: 'error',
        message: 'A critical server-side operation exception occurred.'
    });
});

// Export configured runtime application context directly for Vercel
module.exports = app;
