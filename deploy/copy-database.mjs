/**
 * Copies one portal's database from its current MongoDB (Atlas) to the
 * DigitalOcean managed cluster, checks every record arrived, and (only with
 * --switch, and only if everything matched) points the portal's .env at the
 * new database.
 *
 * Reads from the old database only. Writes only into the new one, and refuses
 * to write into a collection there that already has records, so it can never
 * overwrite anything. With --switch the old .env is kept as .env.atlas-backup,
 * so going back is one copy.
 *
 * Run from the portal's backend folder with the portal stopped (so nothing
 * changes mid-copy), with the cluster's private host and doadmin password in
 * the environment (the password is typed, never put in a file or the chat):
 *
 *   cd /srv/hrms/backend
 *   read -s -p "DO password: " DO_DB_PASSWORD; echo; export DO_DB_PASSWORD
 *   export DO_DB_HOST=private-nowhrms-db-a2e49749.mongo.ondigitalocean.com
 *   sudo -E node copy-database.mjs            # copy + check
 *   sudo -E node copy-database.mjs --check    # check only, writes nothing
 *   sudo -E node copy-database.mjs --switch   # copy + check, then switch .env
 *   sudo -E node copy-database.mjs --fresh --switch   # retry: empty the NEW db first
 */
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import mongoose from "mongoose";

const CHECK_ONLY = process.argv.includes("--check");
// Retry after a stopped run: empty the NEW database first. Never touches the old
// one, and cannot run once .env points at DigitalOcean (checked below).
const FRESH = process.argv.includes("--fresh");
const SWITCH = process.argv.includes("--switch");
const CA_FILE = process.env.DO_DB_CA_FILE || "/etc/hrms/do-mongo-ca.crt";
const REPLICA_SET = process.env.DO_DB_REPLICA_SET || "nowhrms-db";
const BATCH = 1000;

const envText = readFileSync(".env", "utf8");
const sourceUri = envText
  .split(/\r?\n/)
  .map(line => line.match(/^\s*MONGODB_URI\s*=\s*(.*)$/))
  .find(Boolean)?.[1]
  ?.replace(/^["']|["']$/g, "");

function fail(message) {
  console.error(`\nSTOPPED: ${message}`);
  process.exit(1);
}

if (!sourceUri) fail("No MONGODB_URI in .env. Run this from the portal's backend folder.");
if (sourceUri.includes("ondigitalocean.com")) fail("This .env already points at DigitalOcean. Nothing to copy.");
if (!process.env.DO_DB_HOST) fail("Set DO_DB_HOST (the private host from the cluster's VPC network tab).");
if (!process.env.DO_DB_PASSWORD) fail("Set DO_DB_PASSWORD with: read -s -p \"DO password: \" DO_DB_PASSWORD; export DO_DB_PASSWORD");

const source = await mongoose.createConnection(sourceUri).asPromise();
const dbName = source.db.databaseName;
if (!dbName || dbName === "test") fail(`The old connection string names no database (got "${dbName}").`);

const targetUri =
  `mongodb+srv://doadmin:${encodeURIComponent(process.env.DO_DB_PASSWORD)}@${process.env.DO_DB_HOST}/${dbName}` +
  `?tls=true&authSource=admin&replicaSet=${REPLICA_SET}&tlsCAFile=${CA_FILE}`;
const target = await mongoose.createConnection(targetUri).asPromise();

console.log(`Database: ${dbName}`);
console.log(`From: old database (read only)`);
console.log(`To:   DigitalOcean ${process.env.DO_DB_HOST}`);
console.log(CHECK_ONLY ? "Mode: check only, nothing is written\n" : "Mode: copy, then check\n");

const names = (await source.db.listCollections({}, { nameOnly: true }).toArray())
  .map(c => c.name)
  .filter(name => !name.startsWith("system."))
  .sort();

// 1. Copy (refusing to touch any collection that already holds records).
if (!CHECK_ONLY) {
  if (FRESH) {
    await target.db.dropDatabase();
    console.log(`  emptied ${dbName} on DigitalOcean (the old database is untouched)`);
  }
  for (const name of names) {
    const existing = await target.db.collection(name).estimatedDocumentCount();
    if (existing > 0) fail(`"${name}" on DigitalOcean already has ${existing} records. Nothing was overwritten.`);
  }
  for (const name of names) {
    const from = source.db.collection(name);
    const to = target.db.collection(name);
    await target.db.createCollection(name).catch(error => {
      if (error?.codeName !== "NamespaceExists") throw error;
    });
    const indexes = (await from.indexes()).filter(index => index.name !== "_id_");
    if (indexes.length > 0) {
      await to.createIndexes(
        indexes.map(({ v, ns, ...index }) => index)
      );
    }
    let copied = 0;
    let batch = [];
    for await (const doc of from.find({}, { batchSize: BATCH })) {
      batch.push(doc);
      if (batch.length === BATCH) {
        await to.insertMany(batch, { ordered: true });
        copied += batch.length;
        batch = [];
      }
    }
    if (batch.length > 0) {
      await to.insertMany(batch, { ordered: true });
      copied += batch.length;
    }
    console.log(`  copied ${name}: ${copied}`);
  }
  console.log("");
}

// 2. Check: same collections, same number of records, the very same records.
let problems = 0;
let total = 0;
const ejson = mongoose.mongo.BSON.EJSON;
for (const name of names) {
  const a = source.db.collection(name);
  const b = target.db.collection(name);
  const [countA, countB] = await Promise.all([a.countDocuments(), b.countDocuments()]);
  let mismatched = 0;
  if (countA === countB) {
    const cursorA = a.find({}).sort({ _id: 1 });
    const cursorB = b.find({}).sort({ _id: 1 });
    for await (const docA of cursorA) {
      const docB = await cursorB.next();
      if (ejson.stringify(docA, { relaxed: false }) !== ejson.stringify(docB, { relaxed: false })) mismatched += 1;
    }
    await cursorB.close();
  }
  const ok = countA === countB && mismatched === 0;
  if (!ok) problems += 1;
  total += countA;
  console.log(
    `  ${ok ? "OK  " : "DIFF"} ${name}: old ${countA}, new ${countB}` +
      (mismatched ? `, ${mismatched} records differ` : "")
  );
}
console.log(`\n${problems === 0 ? "All" : "NOT all"} ${names.length} collections match (${total} records).`);

// 3. Switch .env, only when everything matched and only when asked.
if (SWITCH) {
  if (problems > 0 || CHECK_ONLY) fail("Not switching: the copy does not match, or this was a check-only run.");
  copyFileSync(".env", ".env.atlas-backup");
  // A function, so "$" in the password is taken literally.
  const updated = envText.replace(/^(\s*MONGODB_URI\s*=).*$/m, (_, key) => `${key}${targetUri}`);
  writeFileSync(".env", updated, { mode: 0o600 });
  console.log("\n.env now points at DigitalOcean. The old one is saved as .env.atlas-backup.");
}

await Promise.all([source.close(), target.close()]);
process.exit(problems === 0 ? 0 : 1);
