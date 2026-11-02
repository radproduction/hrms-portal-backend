// One-off: changes Reem Aman's Employee ID from ADMIN003 to "Reem Aman",
// matching the other employees (their ID is their name). Delete afterwards.
// Run from the backend folder:  node __fix-reem-id.mjs
import "dotenv/config";
import mongoose from "mongoose";

const NEW_ID = "Reem Aman";

await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
const users = mongoose.connection.db.collection("users");

console.log("Existing Employee IDs (for reference):");
const all = await users.find({}, { projection: { employeeId: 1 } }).sort({ createdAt: 1 }).toArray();
console.log("  " + all.map(u => u.employeeId).filter(Boolean).join(" | "));

const reem = await users.findOne({ name: "Reem Aman", employeeId: "ADMIN003" });
if (!reem) {
  console.log("\nNo 'Reem Aman' with ID ADMIN003 found. Nothing changed.");
} else if (await users.findOne({ employeeId: NEW_ID })) {
  console.log(`\nEmployee ID "${NEW_ID}" is already taken. Nothing changed.`);
} else {
  await users.updateOne(
    { _id: reem._id },
    { $set: { employeeId: NEW_ID, openId: `emp-${NEW_ID.toLowerCase()}`, updatedAt: new Date() } }
  );
  console.log("\n==== Updated ====");
  console.log("Employee ID : ADMIN003  ->", NEW_ID);
  console.log("Password    : unchanged");
}
await mongoose.disconnect();
