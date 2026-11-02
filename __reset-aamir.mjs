// One-off: resets the password of the admin account "Aamir" on the Heard portal.
// Read-only first — it prints what it finds, and only resets a single clear
// admin match. Run from the backend folder:  node __reset-aamir.mjs
// Delete this file afterwards. The old password is gone for good once this runs.
import "dotenv/config";
import crypto from "node:crypto";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";

await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
const db = mongoose.connection.db;
const users = db.collection("users");
console.log("Database:", db.databaseName);

// Find everyone whose name looks like Aamir / Amir.
const matches = await users
  .find({ name: /a+mir/i }, { projection: { name: 1, employeeId: 1, email: 1, role: 1 } })
  .toArray();

console.log(`\nMatches for "Aamir" (${matches.length}):`);
for (const u of matches) {
  console.log(`  ${u.employeeId}  |  ${u.name}  |  ${u.email ?? "(no email)"}  |  role: ${u.role}`);
}

// Only reset when there is exactly one account that can see the whole org.
const admins = matches.filter(u => u.role === "admin" || u.role === "head_of_ops");
if (admins.length !== 1) {
  console.log(
    `\nFound ${admins.length} admin-level Aamir accounts, so nothing was changed.` +
      `\nTell me the exact Employee ID to reset and I'll target it directly.`
  );
  await mongoose.disconnect();
  process.exit(0);
}

const target = admins[0];
const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
const newPassword =
  Array.from(crypto.randomBytes(8), b => alphabet[b % alphabet.length]).join("") + "@" + crypto.randomInt(10, 99);

await users.updateOne(
  { _id: target._id },
  { $set: { password: await bcrypt.hash(newPassword, 10), updatedAt: new Date() } }
);

console.log("\n==== Password reset ====");
console.log("Portal      : https://heard.nowhrms.com");
console.log("Name        :", target.name);
console.log("Employee ID :", target.employeeId);
console.log("New password:", newPassword);
console.log("Role        :", target.role, "(2FA, if enabled, is unchanged)");
await mongoose.disconnect();
