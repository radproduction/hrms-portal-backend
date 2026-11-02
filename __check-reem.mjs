// One-off diagnostic: why can't Reem log in? Read-only. Delete afterwards.
// Run from the backend folder:  node __check-reem.mjs
import "dotenv/config";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";

const PASSWORD = "Ph5jqP3c@76";

await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
const db = mongoose.connection.db;
const users = db.collection("users");
const host = (process.env.MONGODB_URI.match(/@([^/,:]+)/) || [])[1];
console.log("Cluster host :", host);
console.log("Database     :", db.databaseName);
console.log("Total users  :", await users.countDocuments());

const reem = await users.findOne({ name: /reem/i });
if (!reem) {
  console.log("\nReem NOT found in this database.");
} else {
  console.log("\nReem found:");
  console.log("  Employee ID     :", JSON.stringify(reem.employeeId));
  console.log("  Password matches:", await bcrypt.compare(PASSWORD, reem.password || ""));
  console.log("  Role            :", reem.role);
}

const recent = await users.find({}, { projection: { name: 1, employeeId: 1 } }).sort({ createdAt: -1 }).limit(8).toArray();
console.log("\nNewest 8 users in this database:");
for (const u of recent) console.log("  ", u.employeeId, "-", u.name);
await mongoose.disconnect();
