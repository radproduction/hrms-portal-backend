// One-off: creates a fresh ADMIN account on the Heard portal (heard.nowhrms.com).
// 2FA starts OFF, so the first login shows a new QR to enrol your own
// authenticator. Run from the backend folder:  node __add-admin.mjs
// Delete this file afterwards (the password is printed to the screen).

// ---- edit these if you want ----
const NAME = "Aamir Younus";
const EMAIL = "itsaamiryounus@gmail.com"; // optional; login is by Employee ID
// --------------------------------

import "dotenv/config";
import crypto from "node:crypto";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";

// Retry the connection — Atlas failover and flaky Wi-Fi often drop the first
// one or two attempts with a TLS "socket disconnected" / ReplicaSetNoPrimary.
async function connectWithRetry(tries = 5) {
  for (let i = 1; i <= tries; i++) {
    try {
      await mongoose.connect(process.env.MONGODB_URI, {
        serverSelectionTimeoutMS: 30000,
        connectTimeoutMS: 30000,
        socketTimeoutMS: 45000,
      });
      return;
    } catch (err) {
      console.log(`Connect attempt ${i}/${tries} failed: ${err.message}`);
      if (i === tries) throw err;
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}
await connectWithRetry();
const db = mongoose.connection.db;
const users = db.collection("users");
console.log("Database:", db.databaseName);

// Next ADMIN00x, following the existing admin pattern.
const adminIds = (await users.find({ employeeId: /^ADMIN\d+$/i }, { projection: { employeeId: 1 } }).toArray())
  .map(u => u.employeeId.match(/^ADMIN(\d+)$/i))
  .filter(Boolean);
const width = Math.max(3, ...adminIds.map(m => m[1].length));
let next = (adminIds.length ? Math.max(...adminIds.map(m => Number(m[1]))) : 0) + 1;
let employeeId = `ADMIN${String(next).padStart(width, "0")}`;
while (await users.findOne({ employeeId })) {
  next += 1;
  employeeId = `ADMIN${String(next).padStart(width, "0")}`;
}

// Strong random password.
const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
const password =
  Array.from(crypto.randomBytes(8), b => alphabet[b % alphabet.length]).join("") + "@" + crypto.randomInt(10, 99);

const now = new Date();
await users.insertOne({
  openId: `emp-${employeeId.toLowerCase()}`,
  name: NAME,
  ...(EMAIL ? { email: EMAIL } : {}),
  loginMethod: "custom",
  role: "admin",
  employeeId,
  password: await bcrypt.hash(password, 10),
  twoFactorEnabled: false, // first login will prompt to set up a fresh authenticator
  lastSignedIn: new Date(0),
  createdAt: now,
  updatedAt: now,
});

console.log("\n==== New admin created ====");
console.log("Portal      : https://heard.nowhrms.com");
console.log("Name        :", NAME);
console.log("Employee ID :", employeeId);
console.log("Password    :", password);
console.log("Role        : admin");
console.log("2FA         : off — first login shows a new QR to scan");
await mongoose.disconnect();
