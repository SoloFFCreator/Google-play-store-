/**
 * api/index.js
 *
 * Google Play Store Scraper API
 * Serverless entry point for Vercel.
 *
 * ARCHITECTURAL DECISIONS FOR SERVERLESS / VERCEL:
 * ─────────────────────────────────────────────────
 * 1. ESM ("type": "module" in package.json) is required because
 *    google-play-scraper v9+ ships as a pure ESM package. Using
 *    CommonJS require() against it throws ERR_REQUIRE_ESM at cold-start,
 *    which Vercel surfaces as FUNCTION_INVOCATION_FAILED with no useful
 *    stack trace. Strict ESM throughout eliminates the mismatch entirely.
 *
 * 2. We export `app` as the ESM default export rather than calling
 *    app.listen(). Vercel's Node.js runtime detects the default export
 *    and wraps it automatically in its serverless handler. Calling
 *    listen() inside a serverless function wastes a port bind that is
 *    immediately torn down and can cause timeout errors in some runtimes.
 *
 * 3. All async route handlers are wrapped in `asyncHandler` so that any
 *    rejected Promise is forwarded to Express's centralized error
 *    middleware. Without this wrapper, unhandled async rejections silently
 *    kill the Lambda process, returning a blank Vercel 500 HTML page
 *    instead of a JSON error body.
 *
 * 4. Null-coalescing guards (??) on every scraper field protect against
 *    structural changes in Google Play's HTML layout. If the scraper
 *    returns undefined for a field, we fall back to a safe default rather
 *    than propagating undefined into the JSON response or, worse, throwing
 *    a TypeError mid-handler.
 */

import express from 'express';
import gplay from 'google-play-scraper';

const app = express();

// ─── MIDDLEWARE ────────────────────────────────────────────────────────────────

/**
 * Built-in JSON body parser.
 * Kept intentionally lightweight — serverless functions have strict CPU/memory
 * budgets and we don't need multipart or URL-encoded bodies here.
 */
app.use(express.json());

/**
 * Global CORS middleware.
 *
 * Why manual CORS instead of the `cors` npm package?
 *   - One fewer dependency = faster cold starts and a smaller deployment bundle.
 *   - Full control over headers without a black-box package.
 *
 * The OPTIONS pre-flight handler MUST respond synchronously (no async) and
 * MUST return 204 before Express tries to run any route handler, otherwise
 * browsers block the actual request and developers see cryptic network errors.
 */
app.use((req, res, next) => {
  // Allow any origin. Tighten this to a specific domain in production if needed.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // Handle OPTION pre-flight requests immediately and exit the middleware chain.
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  next();
});

// ─── HELPERS ───────────────────────────────────────────────────────────────────

/**
 * asyncHandler
 *
 * Higher-order wrapper that converts any async Express route handler into one
 * that catches rejected Promises and forwards the error to the next()
 * error-handling middleware.
 *
 * Without this, Express 4.x silently swallows async errors, the Lambda
 * process hangs until timeout, and Vercel eventually responds with a generic
 * 504 or 500 HTML page — not the clean JSON error we want.
 *
 * @param {Function} fn - An async (req, res, next) route handler.
 * @returns {Function} A standard Express route handler with error forwarding.
 */
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

// ─── ROUTES ────────────────────────────────────────────────────────────────────

/**
 * GET /
 * Health-check endpoint.
 *
 * Vercel and uptime monitors hit this to confirm the function is alive.
 * It intentionally does NO async work so it always responds in < 10 ms,
 * even when the scraper's upstream is degraded.
 */
app.get('/', (req, res) => {
  res.status(200).json({
    status: 'success',
    message: 'Google Play Scraper API is running.',
    version: '1.0.0',
    endpoints: {
      health: 'GET /',
      app: 'GET /app?appId=com.example.app&lang=en&country=us',
      search: 'GET /search?query=instagram&limit=10',
    },
  });
});

/**
 * GET /app
 * Fetches full metadata for a single Google Play app.
 *
 * Query parameters:
 *   appId   {string} required — e.g. "com.spotify.music"
 *   lang    {string} optional — BCP-47 language code, default "en"
 *   country {string} optional — ISO 3166-1 alpha-2 country code, default "us"
 *
 * Every field from the scraper result is read through the null-coalescing
 * operator (??) so that a structural change in the Play Store HTML (which
 * happens silently, without a semver bump in google-play-scraper) degrades
 * gracefully to null rather than throwing a TypeError that would crash the
 * Lambda and produce a blank 500 response.
 */
app.get(
  '/app',
  asyncHandler(async (req, res) => {
    const { appId, lang = 'en', country = 'us' } = req.query;

    // Validate required parameter before hitting the network.
    if (!appId || typeof appId !== 'string' || appId.trim() === '') {
      return res.status(400).json({
        status: 'error',
        message: 'Missing required query parameter: appId',
        example: '/app?appId=com.spotify.music&lang=en&country=us',
      });
    }

    const result = await gplay.app({ appId: appId.trim(), lang, country });

    /**
     * Null-coalescing guards on every field.
     *
     * Google Play's HTML is scraped, not returned via a versioned API, so the
     * scraper library can silently return undefined for any field when the page
     * layout changes. We normalise undefined → null for every field to:
     *   a) keep the JSON response shape stable for API consumers, and
     *   b) avoid TypeError crashes (e.g. `undefined.toFixed()`) mid-handler.
     */
    const safeApp = {
      // Core identity
      appId: result.appId ?? null,
      title: result.title ?? null,
      url: result.url ?? null,

      // Descriptions
      description: result.description ?? null,
      summary: result.summary ?? null,

      // Metrics — most crash-prone group; Play Store layout changes often hit numbers first
      score: result.score ?? null,
      scoreText: result.scoreText ?? null,
      ratings: result.ratings ?? null,
      reviews: result.reviews ?? null,
      histogram: result.histogram ?? null,
      installs: result.installs ?? null,
      minInstalls: result.minInstalls ?? null,
      maxInstalls: result.maxInstalls ?? null,

      // Pricing
      free: result.free ?? true,
      price: result.price ?? null,
      currency: result.currency ?? null,
      priceText: result.priceText ?? null,
      offersIAP: result.offersIAP ?? null,
      IAPRange: result.IAPRange ?? null,

      // Classification
      genre: result.genre ?? null,
      genreId: result.genreId ?? null,
      categories: result.categories ?? [],
      contentRating: result.contentRating ?? null,
      contentRatingDescription: result.contentRatingDescription ?? null,

      // Developer info — wrapped so a single undefined field doesn't cascade
      developer: result.developer ?? null,
      developerId: result.developerId ?? null,
      developerEmail: result.developerEmail ?? null,
      developerWebsite: result.developerWebsite ?? null,
      developerAddress: result.developerAddress ?? null,
      privacyPolicy: result.privacyPolicy ?? null,

      // Technical metadata
      version: result.version ?? null,
      androidVersion: result.androidVersion ?? null,
      androidVersionText: result.androidVersionText ?? null,
      updated: result.updated ?? null,
      released: result.released ?? null,
      size: result.size ?? null,

      // Media — arrays must default to [] not null so callers can safely .map()
      icon: result.icon ?? null,
      headerImage: result.headerImage ?? null,
      screenshots: result.screenshots ?? [],
      video: result.video ?? null,
      videoImage: result.videoImage ?? null,

      // Availability
      available: result.available ?? null,
      adSupported: result.adSupported ?? null,

      // Recent changes (what's new section)
      recentChanges: result.recentChanges ?? null,
    };

    res.status(200).json({ status: 'success', data: safeApp });
  })
);

/**
 * GET /search
 * Searches the Play Store and returns a list of matching apps.
 *
 * Query parameters:
 *   query   {string} required  — search term
 *   limit   {number} optional  — number of results, default 20, hard cap 100
 *
 * The hard cap on `limit` is critical for serverless deployments:
 *   - Each result requires HTTP round-trips to Play Store CDN servers.
 *   - Vercel's default function timeout is 10 s (Hobby) / 60 s (Pro).
 *   - Fetching > 100 results can easily exceed 10 s and trigger a 504,
 *     which Vercel surfaces to the browser as a blank 500 page.
 */
app.get(
  '/search',
  asyncHandler(async (req, res) => {
    const { query, lang = 'en', country = 'us' } = req.query;

    // Parse and clamp limit: default 20, minimum 1, maximum 100.
    const MAX_LIMIT = 100;
    const DEFAULT_LIMIT = 20;
    const rawLimit = parseInt(req.query.limit, 10);
    const limit = isNaN(rawLimit)
      ? DEFAULT_LIMIT
      : Math.min(Math.max(rawLimit, 1), MAX_LIMIT);

    // Validate required search query.
    if (!query || typeof query !== 'string' || query.trim() === '') {
      return res.status(400).json({
        status: 'error',
        message: 'Missing required query parameter: query',
        example: '/search?query=spotify&limit=10',
      });
    }

    const results = await gplay.search({
      term: query.trim(),
      num: limit,
      lang,
      country,
    });

    // Normalise each result in the list with the same null-coalescing pattern.
    // Search results have a subset of fields compared to full app details.
    const safeResults = (results ?? []).map((item) => ({
      appId: item.appId ?? null,
      title: item.title ?? null,
      url: item.url ?? null,
      icon: item.icon ?? null,
      developer: item.developer ?? null,
      developerId: item.developerId ?? null,
      currency: item.currency ?? null,
      price: item.price ?? null,
      free: item.free ?? true,
      summary: item.summary ?? null,
      scoreText: item.scoreText ?? null,
      score: item.score ?? null,
    }));

    res.status(200).json({
      status: 'success',
      query: query.trim(),
      limit,
      count: safeResults.length,
      data: safeResults,
    });
  })
);

// ─── 404 HANDLER ───────────────────────────────────────────────────────────────

/**
 * Catch-all for undefined routes.
 * Must be placed AFTER all valid route definitions.
 * Returns JSON (not HTML) so API clients can parse it programmatically.
 */
app.use((req, res) => {
  res.status(404).json({
    status: 'error',
    message: `Route not found: ${req.method} ${req.path}`,
    availableRoutes: ['GET /', 'GET /app', 'GET /search'],
  });
});

// ─── GLOBAL ERROR HANDLER ──────────────────────────────────────────────────────

/**
 * Centralised Express error-handling middleware.
 *
 * MUST be defined with exactly four parameters (err, req, res, next).
 * Express identifies error handlers by arity — if you omit `next`, Express
 * treats it as a normal route handler and errors will fall through uncaught.
 *
 * Why this is critical for Vercel:
 *   Without this, an unhandled error causes the Express app to emit an
 *   'uncaughtException' or 'unhandledRejection', which Node terminates the
 *   process on. Vercel captures the abrupt exit and returns a generic
 *   FUNCTION_INVOCATION_FAILED response with an empty body — impossible to
 *   debug from the client side. This middleware ensures every failure path
 *   produces a structured JSON payload with an appropriate HTTP status code.
 */
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // Log the full error server-side for Vercel's function log viewer.
  console.error('[ERROR]', {
    message: err.message,
    stack: err.stack,
    path: req.path,
    query: req.query,
    timestamp: new Date().toISOString(),
  });

  // Derive an appropriate HTTP status code.
  // Some libraries (e.g. google-play-scraper) attach a `status` or
  // `statusCode` property to their errors; fall back to 500 otherwise.
  const statusCode =
    typeof err.status === 'number'
      ? err.status
      : typeof err.statusCode === 'number'
        ? err.statusCode
        : 500;

  // Return a clean, machine-readable JSON error body.
  // Never expose raw stack traces in production responses.
  res.status(statusCode).json({
    status: 'error',
    message: err.message || 'An unexpected internal server error occurred.',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
});

// ─── EXPORT ────────────────────────────────────────────────────────────────────

/**
 * ESM default export — NOT app.listen().
 *
 * Vercel's Node.js serverless runtime expects the entry file to export the
 * Express `app` (or any http.Handler-compatible function) as the default
 * export. It wraps the export in its own http.createServer() lifecycle.
 *
 * Calling app.listen() here would:
 *   a) bind a port that Vercel immediately discards, wasting ~50 ms per cold start, and
 *   b) potentially cause EADDRINUSE errors in environments where the port
 *      is already occupied by the runtime's own server process.
 *
 * For local development, run: node api/index.js (see package.json start script).
 * The conditional listen() block below only fires outside of Vercel.
 */
if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`[DEV] Google Play Scraper API running at http://localhost:${PORT}`);
  });
}

export default app;
