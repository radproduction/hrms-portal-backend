import "dotenv/config";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";

const EMPLOYEE_ID = "TESTADMIN";
const PASSWORD = "TestAdmin@2026";

const User = mongoose.model("User", new mongoose.Schema({}, { strict: false, collection: "users" }));

try {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 12000 });
  console.log("DB:", mongoose.connection.name);

  const hash = await bcrypt.hash(PASSWORD, 10);
  await User.updateOne(
    { employeeId: EMPLOYEE_ID },            // match the EXISTING TESTADMIN, don't create a dup
    {
      $set: {
        name: "Test Admin",
        loginMethod: "custom",
        role: "head_of_ops",                // full admin panel, no 2FA
        password: hash,
        position: "Test Administrator",
        twoFactorEnabled: false,
      },
      $unset: { twoFactorSecret: "" },      // make sure no 2FA blocks login
      $setOnInsert: { openId: "test-admin" },
    },
    { upsert: true }
  );

  const check = await User.findOne({ employeeId: EMPLOYEE_ID }).lean();
  const ok = await bcrypt.compare(PASSWORD, check.password).catch(() => false);

  console.log("\n==== TEST ADMIN CREDENTIALS ====");
  console.log("  Employee ID:", check.employeeId);
  console.log("  Password:   ", PASSWORD);
  console.log("  Role:       ", check.role, "| 2FA:", !!check.twoFactorEnabled);
  console.log("  verified:   ", ok ? "YES \u2705" : "NO \u274c");
} catch (e) {
  console.error("ERROR:", e?.message);
} finally {
  await mongoose.connection.close().catch(() => {});
  process.exit(0);
}
