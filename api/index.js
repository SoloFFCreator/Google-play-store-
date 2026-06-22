const express = require('express');
const gplay = require('google-play-scraper');

const app = express();

// 1. Global Middleware & Security Configuration
app.use(express.json());

// Cross-Origin Resource Sharing (CORS) safe handling
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

// Async wrapper to prevent unhandled promise rejections from killing the serverless container
const asyncHandler = (fn) => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
};

// 2. API Routes

/**
 * GET /
 * Health check endpoint
 */
app.get('/', (req, res) => {
    res.status(200).json({
        status: 'success',
        message: 'Google Play Store Scraper API is active and running.'
    });
});

/**
 * GET /app
 * Fetches thorough metadata and media assets for a unique package ID.
 */
app.get('/app', asyncHandler(async (req, res) => {
    const { appId, lang = 'en', country = 'us' } = req.query;

    if (!appId || typeof appId !== 'string' || !appId.trim()) {
        return res.status(400).json({
            status: 'fail',
            error: "Missing or invalid required query string parameter: 'appId'."
        });
    }

    try {
        const data = await gplay.app({ appId: appId.trim(), lang, country });
        
        // Defensive date conversion to prevent parsing crashes if Google changes format
        let safeUpdatedDate = null;
        if (data.updated) {
            try {
                safeUpdatedDate = new Date(data.updated).toISOString();
            } catch (e) {
                safeUpdatedDate = String(data.updated);
            }
        }

        // Return perfectly structured, type-safe data payload
        return res.status(200).json({
            status: 'success',
            data: {
                appId: data.appId || appId.trim(),
                title: data.title || 'Unknown Title',
                summary: data.summary ?? '',
                description: data.description ?? '',
                developer: {
                    name: data.developer ?? 'Unknown Developer',
                    id: data.developerId ?? null,
                    email: data.developerEmail ?? null,
                    website: data.developerWebsite ?? null,
                    address: data.developerAddress ?? null
                },
                metrics: {
                    score: data.score ?? 0,
                    scoreText: data.scoreText ?? "0",
                    ratings: data.ratings ?? 0,
                    reviews: data.reviews ?? 0,
                    installs: data.installs ?? "0+",
                    price: data.price ?? 0,
                    free: data.free ?? true,
                    currency: data.currency ?? "USD"
                },
                metadata: {
                    genre: data.genre ?? 'Unknown',
                    genreId: data.genreId ?? 'Unknown',
                    contentRating: data.contentRating ?? 'Everyone',
                    released: data.released ?? null,
                    updated: safeUpdatedDate,
                    version: data.version ?? 'Varies with device'
                },
                media: {
                    icon: data.icon ?? null,
                    headerImage: data.headerImage ?? null,
                    screenshots: data.screenshots ?? [],
                    video: data.video ?? null,
                    videoImage: data.videoImage ?? null
                }
            }
        });
    } catch (error) {
        const errorMsg = error.message ? error.message.toLowerCase() : '';
        const isNotFound = errorMsg.includes('not found') || errorMsg.includes('404');
        const statusCode = isNotFound ? 404 : 500;
        
        return res.status(statusCode).json({
            status: 'error',
            message: isNotFound ? `App with package ID '${appId}' could not be located.` : 'Failed to communicate with downstream Google Play servers.',
            debug_details: process.env.NODE_ENV !== 'production' ? error.message : undefined
        });
    }
}));

/**
 * GET /search
 * Searches the store catalog using keywords.
 */
app.get('/search', asyncHandler(async (req, res) => {
    const { query, lang = 'en', country = 'us', limit = '20' } = req.query;

    if (!query || typeof query !== 'string' || !query.trim()) {
        return res.status(400).json({
            status: 'fail',
            error: "Missing or invalid required query string parameter: 'query'."
        });
    }

    const parsedLimit = parseInt(limit, 10);
    if (isNaN(parsedLimit) || parsedLimit <= 0) {
        return res.status(400).json({
            status: 'fail',
            error: "Query parameter 'limit' must be a valid positive integer."
        });
    }

    // Safety ceiling limit to optimize lambda function execution times
    const finalLimit = Math.min(parsedLimit, 100);

    try {
        const results = await gplay.search({
            term: query.trim(),
            lang,
            country,
            num: finalLimit
        });

        const formattedResults = (results || []).map(appItem => ({
            appId: appItem.appId,
            title: appItem.title || 'Unknown Title',
            developer: appItem.developer ?? 'Unknown Developer',
            score: appItem.score ?? 0,
            price: appItem.price ?? 0,
            free: appItem.free ?? true,
            icon: appItem.icon ?? null,
            screenshots: appItem.screenshots ?? []
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
            debug_details: process.env.NODE_ENV !== 'production' ? error.message : undefined
        });
    }
}));

// 3. Centralized Fallback Error Handler Middleware
app.use((err, req, res, next) => {
    console.error('Captured Critical Exception:', err.stack || err);
    
    // Always return a valid JSON payload to prevent Vercel's blank HTML 500 page crash
    res.status(500).json({
        status: 'error',
        message: 'A critical internal server-side exception occurred.'
    });
});

// Export the configured Express app context for the Vercel serverless environment
module.exports = app;
