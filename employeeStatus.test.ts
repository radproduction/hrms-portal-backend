import { afterAll, beforeAll, expect, it } from "vitest";
import mongoose from "mongoose";
import { TimeEntry, User } from "./models";
import { getEmployeeStatusSnapshot } from "./db";
import { describeWithDb } from "./test-utils";

/**
 * The admin "Currently Online" board is built from getEmployeeStatusSnapshot. It
 * used to list only role "user", so a clocked-in department head never showed -
 * which is exactly who the finance admin was asking about.
 *
 *   TEST_MONGODB_URI="mongodb://.../hrms_test" npx vitest run employeeStatus.test.ts
 */
describeWithDb("getEmployeeStatusSnapshot", () => {
  const stamp = Date.now();
  let headId: string;
  let userId: string;
  let adminId: string;

  beforeAll(async () => {
    await mongoose.connect(process.env.MONGODB_URI as string);
    const [head, user, admin] = await User.create([
      { openId: `es-head-${stamp}`, name: "Dept Head", role: "dept_head", employeeId: `ESH${stamp}`, position: "Brand Manager" },
      { openId: `es-user-${stamp}`, name: "Worker", role: "user", employeeId: `ESU${stamp}` },
      { openId: `es-adm-${stamp}`, name: "Boss", role: "admin", employeeId: `ESA${stamp}` },
    ]);
    headId = String(head._id);
    userId = String(user._id);
    adminId = String(admin._id);

    const now = new Date();
    await TimeEntry.create([
      { userId: headId, timeIn: now, status: "active" },
      { userId: userId, timeIn: now, status: "active" },
      { userId: adminId, timeIn: now, status: "active" },
    ]);
  });

  afterAll(async () => {
    const ids = [headId, userId, adminId];
    await TimeEntry.deleteMany({ userId: { $in: ids } });
    await User.deleteMany({ _id: { $in: ids } });
    await mongoose.connection.close();
  });

  it("includes a clocked-in department head, and the plain employee", async () => {
    const snap = await getEmployeeStatusSnapshot();
    const byId = new Map(snap.map(s => [s.id, s]));

    expect(byId.get(headId)?.status).toBe("timed_in");
    expect(byId.get(userId)?.status).toBe("timed_in");
  });

  it("still leaves top-level admins out of the board", async () => {
    const snap = await getEmployeeStatusSnapshot();
    expect(snap.some(s => s.id === adminId)).toBe(false);
  });
});
