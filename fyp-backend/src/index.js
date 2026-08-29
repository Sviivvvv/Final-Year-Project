/**
 * index.js — FYP PoC backend entry point.
 *
 * Improvements over v1:
 *   - Validates required env vars on startup (fail fast, not mid-request)
 *   - Connects to MongoDB before accepting any requests
 *   - Morgan request logging (method / path / status / response time)
 *   - CORS enabled (ready for frontend)
 *   - Graceful shutdown on SIGINT / SIGTERM (closes MongoDB connection cleanly)
 *
 * Mid-Point addition:
 *   - /auth router mounted (unified email/password login -> bearer token,
 *     role determined server-side by which account matched). QA_EMAIL,
 *     QA_PASSWORD, MANAGER_EMAIL, MANAGER_PASSWORD must be set in .env;
 *     requests to protected /reports routes without a valid token are
 *     rejected by requireRole() in routes/reports.js, not here.
 */

require('dotenv').config();

const express      = require('express');
const cors         = require('cors');
const morgan       = require('morgan');
const { getDb, closeDb } = require('./db');
const reportsRoute = require('./routes/reports');
const authRoute     = require('./routes/auth');

// ---------------------------------------------------------------------------
// 1. Validate required env vars before doing anything else
// ---------------------------------------------------------------------------
const REQUIRED_ENV = ['MONGODB_URI', 'QA_EMAIL', 'QA_PASSWORD', 'MANAGER_EMAIL', 'MANAGER_PASSWORD'];
const missingEnv = REQUIRED_ENV.filter(k => !process.env[k]);
if (missingEnv.length > 0) {
  console.error(`\n[Startup error] Missing required environment variables: ${missingEnv.join(', ')}`);
  console.error('Add them to your .env file and restart.\n');
  process.exit(1);
}

const app  = express();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// 2. Middleware
// ---------------------------------------------------------------------------
app.use(cors());                          // allow all origins for PoC
app.use(express.json());
app.use(morgan('[:date[iso]] :method :url :status :response-time ms'));

// ---------------------------------------------------------------------------
// 3. Routes
// ---------------------------------------------------------------------------
app.get('/health', (req, res) => {
  res.json({
    status:  'ok',
    service: 'fyp-poc-backend',
    upstreams: {
      component1: process.env.COMPONENT1_URL || 'http://127.0.0.1:8000',
      component2: process.env.COMPONENT2_URL || 'http://127.0.0.1:8002',
    },
  });
});

app.use('/auth',    authRoute);
app.use('/reports', reportsRoute);

// ---------------------------------------------------------------------------
// 4. Catch-all 404
// ---------------------------------------------------------------------------
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found.` });
});

// ---------------------------------------------------------------------------
// 5. Global error handler
// ---------------------------------------------------------------------------
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[Unhandled error]', err);
  res.status(500).json({ error: 'Internal server error.', detail: err.message });
});

// ---------------------------------------------------------------------------
// 6. Connect to MongoDB first, then start listening
// ---------------------------------------------------------------------------
(async () => {
  try {
    await getDb();  // fail fast — exits with clear error if URI is wrong
  } catch (err) {
    console.error('\n[Startup error] Could not connect to MongoDB Atlas:', err.message);
    console.error('Check your MONGODB_URI in .env and that your IP is whitelisted in Atlas.\n');
    process.exit(1);
  }

  const server = app.listen(PORT, () => {
    console.log(`\nFYP PoC backend running on http://localhost:${PORT}`);
    console.log(`  Component 1 → ${process.env.COMPONENT1_URL || 'http://127.0.0.1:8000'}`);
    console.log(`  Component 2 → ${process.env.COMPONENT2_URL || 'http://127.0.0.1:8002'}`);
    console.log(`  MongoDB     → ${process.env.MONGODB_DB_NAME || 'fyp_poc'} (Atlas)\n`);
  });

  // -------------------------------------------------------------------------
  // 7. Graceful shutdown — close MongoDB connection cleanly on Ctrl+C / kill
  // -------------------------------------------------------------------------
  const shutdown = async (signal) => {
    console.log(`\n[${signal}] Shutting down gracefully...`);
    server.close(async () => {
      await closeDb();
      console.log('[Shutdown] MongoDB connection closed. Bye.\n');
      process.exit(0);
    });
  };

  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
})();
