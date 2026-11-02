// One-off: adds Reem Aman to the Heard/Rad portal (heard.nowhrms.com).
// Run from the backend folder:  node __add-employee-reem.mjs
// Delete this file afterwards.
import "dotenv/config";
import crypto from "node:crypto";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";

const NAME = "Reem Aman";
const POSITION = "Content & Social Executive";
const PHONE = "03363348097";
const CNIC = "42101-1382654-0";

await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
const db = mongoose.connection.db;
const users = db.collection("users");
console.log("Database:", db.databaseName);

// 1. Stop if she already exists.
const existing = await users.findOne({ name: /^\s*reem\s+aman\s*$/i });
if (existing) {
  console.log(`\nReem Aman already exists with Employee ID ${existing.employeeId}. Nothing changed.`);
  await mongoose.disconnect();
  process.exit(0);
}

// 2. Next Employee ID, following the most common existing pattern (e.g. RAD012 -> RAD013).
const ids = (await users.find({}, { projection: { employeeId: 1 } }).toArray())
  .map(u => u.employeeId)
  .filter(Boolean)
  .map(id => id.match(/^([A-Za-z-]+)(\d+)$/))
  .filter(Boolean);
const byPrefix = {};
for (const [, prefix, num] of ids) {
  (byPrefix[prefix] ??= []).push(num);
}
const [prefix, nums] = Object.entries(byPrefix).sort((a, b) => b[1].length - a[1].length)[0] ?? ["EMP", ["0"]];
const width = Math.max(...nums.map(n => n.length));
let next = Math.max(...nums.map(Number)) + 1;
let employeeId = `${prefix}${String(next).padStart(width, "0")}`;
while (await users.findOne({ employeeId })) {
  next += 1;
  employeeId = `${prefix}${String(next).padStart(width, "0")}`;
}

// 3. Department: use an existing one that fits, otherwise a plain name.
const dept = await db.collection("departments").findOne({ name: /content|social|marketing|creative/i });
const departmentName = dept?.name ?? "Content & Social";

// 4. Strong random password.
const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
const password =
  Array.from(crypto.randomBytes(8), b => alphabet[b % alphabet.length]).join("") + "@" + crypto.randomInt(10, 99);

// 5. Create the user exactly like the admin panel does (db.ts createEmployee).
const now = new Date();
await users.insertOne({
  openId: `emp-${employeeId.toLowerCase()}`,
  name: NAME,
  loginMethod: "custom",
  role: "user",
  employeeId,
  password: await bcrypt.hash(password, 10),
  department: departmentName,
  ...(dept ? { departmentId: dept._id } : {}),
  position: POSITION,
  twoFactorEnabled: false,
  lastSignedIn: new Date(0),
  createdAt: now,
  updatedAt: now,
});

console.log("\n==== Employee added ====");
console.log("Portal      : https://heard.nowhrms.com");
console.log("Name        :", NAME);
console.log("Employee ID :", employeeId);
console.log("Password    :", password);
console.log("Department  :", departmentName, dept ? "" : "(new name, no department head linked)");
console.log("Position    :", POSITION);
console.log("Phone/CNIC  :", PHONE, "/", CNIC, "(not stored - the portal has no field for these)");
await mongoose.disconnect();
