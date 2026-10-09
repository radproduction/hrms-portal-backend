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
    { employeeId: EMPLOYEE_ID },
    {
      $set: {
        role: "admin",             // admin => login par fresh 2FA QR aayega
        password: hash,
        twoFactorEnabled: false,   // purana authenticator hata do
      },
      $unset: { twoFactorSecret: "" },
    }
  );

  const check = await User.findOne({ employeeId: EMPLOYEE_ID }).lean();
  const ok = await bcrypt.compare(PASSWORD, check.password).catch(() => false);

  console.log("\n==== TEST ADMIN ====");
  console.log("  Employee ID:", check.employeeId);
  console.log("  Password:   ", PASSWORD);
  console.log("  Role:       ", check.role);
  console.log("  2FA enabled:", !!check.twoFactorEnabled, "| has secret:", !!check.twoFactorSecret);
  console.log("  verified:   ", ok ? "YES \u2705" : "NO \u274c");
} catch (e) {
  console.error("ERROR:", e?.message);
} finally {
  await mongoose.connection.close().catch(() => {});
  process.exit(0);
}
