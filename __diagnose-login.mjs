// READ-ONLY diagnostic: why can nobody log in? Changes nothing in the database.
// Run from the backend folder:
//   node __diagnose-login.mjs "Fayyaz" "the-password-you-are-typing"
// Delete this file afterwards.
import "dotenv/config";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";

const [, , loginId = "Fayyaz", password = ""] = process.argv;

const uri = process.env.MONGODB_URI || "";
console.log("Target       :", uri.replace(/\/\/[^@]*@/, "//****@").replace(/\?.*$/, ""));

try {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
} catch (error) {
  console.log("\n>>> CANNOT CONNECT TO MONGODB:", error.message);
  console.log(">>> If the live backend has the same problem, EVERY login returns");
  console.log(">>> 'Invalid employee ID or password'. Check the Atlas IP access list / cluster status.");
  process.exit(1);
}

const db = mongoose.connection.db;
const users = db.collection("users");
console.log("Database     :", db.databaseName);
console.log("Total users  :", await users.countDocuments());
console.log("By role      :", JSON.stringify(
  await users.aggregate([{ $group: { _id: "$role", n: { $sum: 1 } } }]).toArray()
));

const all = await users
  .find({}, { projection: { name: 1, employeeId: 1, role: 1, createdAt: 1, updatedAt: 1 } })
  .sort({ createdAt: 1 })
  .toArray();
console.log("\nAll users (employeeId shown in quotes so stray spaces are visible):");
for (const u of all) {
  console.log(
    `  ${JSON.stringify(u.employeeId)}  | ${u.name}  | ${u.role}  | created ${u.createdAt?.toISOString?.() ?? "?"}  | updated ${u.updatedAt?.toISOString?.() ?? "?"}`
  );
}

const exact = await users.findOne({ employeeId: loginId });
const loose = await users.findOne({
  employeeId: { $regex: `^\\s*${loginId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, $options: "i" },
});
console.log(`\nExact match for ${JSON.stringify(loginId)} :`, exact ? "FOUND" : "not found");
console.log("Case/space-insensitive match :", loose ? JSON.stringify(loose.employeeId) : "not found");

const target = exact || loose;
if (target && password) {
  const ok = await bcrypt.compare(password, target.password || "").catch(() => false);
  console.log("Password matches             :", ok);
}

// Activity history survives only if the seed's purge did NOT run.
const counts = {};
for (const c of ["timeentries", "payslips", "leaveapplications", "notifications"]) {
  counts[c] = await db.collection(c).countDocuments().catch(() => "n/a");
}
console.log("\nHistory collections          :", JSON.stringify(counts));

await mongoose.disconnect();
