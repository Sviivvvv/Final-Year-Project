/**
 * db.js — MongoDB Atlas connection (PoC scope).
 *
 * One MongoClient, one database, one collection: "reports".
 * getDb() returns the database handle; the collection is accessed per-call
 * via db.collection('reports') so there's no extra indirection.
 *
 * Requires MONGODB_URI in .env — get it from:
 *   Atlas UI → your cluster → Connect → Drivers → copy the connection string
 *   then replace <password> with your Atlas user's password.
 *
 * Optional MONGODB_DB_NAME (default: "fyp_poc") lets you point at a
 * different database without touching code.
 */

const { MongoClient } = require('mongodb');

let client = null;
let dbHandle = null;

/**
 * Returns the singleton MongoDB database handle, connecting on first call.
 * @returns {Promise<import('mongodb').Db>}
 */
async function getDb() {
  if (dbHandle) return dbHandle;

  if (!process.env.MONGODB_URI) {
    throw new Error(
      'MONGODB_URI is not set. Add it to your .env file.\n' +
      'Get it from: Atlas UI → your cluster → Connect → Drivers.'
    );
  }

  client = new MongoClient(process.env.MONGODB_URI);
  try {
    await client.connect();
  } catch (err) {
    // Some home / campus DNS servers cannot answer the SRV lookup that mongodb+srv:// URIs need
    // (error code ESERVFAIL / ECONNREFUSED from querySrv). Retry once through public resolvers.
    if (!/querySrv|ESERVFAIL|ENOTFOUND/.test(String(err?.message) + String(err?.code))) throw err;
    console.warn('[DB] System DNS could not resolve the Atlas address; retrying with public DNS (8.8.8.8, 1.1.1.1).');
    require('dns').setServers(['8.8.8.8', '1.1.1.1']);
    await client.close().catch(() => {});
    client = new MongoClient(process.env.MONGODB_URI);
    await client.connect();
  }

  const dbName = process.env.MONGODB_DB_NAME || 'fyp_poc';
  dbHandle = client.db(dbName);

  console.log(`[DB] Connected to MongoDB Atlas — database: "${dbName}"`);
  await ensureIndexes(dbHandle);
  return dbHandle;
}

/**
 * The unique (thread_id, attempt_number) index is the cross-process guard
 * against two simultaneous resubmissions both claiming the same attempt
 * number (see routes/reports.js). If legacy data already violates it the
 * index build fails; we warn and carry on rather than refusing to start.
 */
async function ensureIndexes(db) {
  const specs = [
    // Partial: reports saved before the resubmission loop existed have no thread_id.
    ['reports', { thread_id: 1, attempt_number: 1 }, { unique: true, partialFilterExpression: { thread_id: { $type: 'string' } } }],
    ['reports', { user_email: 1, submitted_at: -1 }, {}],
    ['users',   { email: 1 }, { unique: true }],
  ];
  for (const [coll, keys, opts] of specs) {
    try {
      await db.collection(coll).createIndex(keys, opts);
    } catch (err) {
      console.warn(`[DB] Index warning on ${coll}:`, err.message);
    }
  }
}

/**
 * Gracefully close the connection (called on process exit).
 */
async function closeDb() {
  if (client) {
    await client.close();
    client    = null;
    dbHandle  = null;
  }
}

module.exports = { getDb, closeDb };
