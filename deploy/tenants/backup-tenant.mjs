/**
 * Copies every collection of a tenant's database to JSON files on the droplet,
 * before an upgrade or a migration. Only reads the database.
 *
 *   cd /srv/tenants/<tenant>/backend
 *   sudo node deploy/tenants/backup-tenant.mjs
 *
 * Writes /var/backups/hrms/<database>-<date-time>/<collection>.json in
 * Extended JSON, which keeps ObjectIds and dates exactly, so a collection can
 * be put back with mongoimport or a short script if it is ever needed.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import mongoose from "mongoose";

for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
  if (match && process.env[match[1]] === undefined) {
    process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
}

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error("MONGODB_URI is not set. Run this from the tenant's backend folder.");
  process.exit(1);
}

await mongoose.connect(uri);
const db = mongoose.connection.db;
const { EJSON } = mongoose.mongo.BSON;
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const folder = join("/var/backups/hrms", `${db.databaseName}-${stamp}`);
mkdirSync(folder, { recursive: true, mode: 0o700 });

let total = 0;
for (const { name } of await db.listCollections().toArray()) {
  const docs = await db.collection(name).find({}).toArray();
  writeFileSync(join(folder, `${name}.json`), EJSON.stringify(docs, { relaxed: false }), { mode: 0o600 });
  total += docs.length;
  if (docs.length > 0) console.log(`  ${name}: ${docs.length}`);
}
console.log(`Backed up ${total} records to ${folder}`);
await mongoose.disconnect();
