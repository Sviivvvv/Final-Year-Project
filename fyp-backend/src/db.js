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
  await client.connect();

  const dbName = process.env.MONGODB_DB_NAME || 'fyp_poc';
  dbHandle = client.db(dbName);

  console.log(`[DB] Connected to MongoDB Atlas — database: "${dbName}"`);
  return dbHandle;
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
