import { afterAll, beforeAll, expect, it } from "vitest";
import mongoose from "mongoose";
import { TimeEntry, User } from "./models";
import { getAttendanceReportData } from "./db";
import { describeWithDb } from "./test-utils";

/**
 * The monthly attendance report (admin.getMonthlyAttendance) is built from
 * getAttendanceReportData. It used to list only role "user", so a department
 * head had no report in any month and could not be picked in the employee filter.
 *
 *   TEST_MONGODB_URI="mongodb://.../hrms_test" npx vitest run attendanceReport.test.ts
 */
describeWithDb("getAttendanceReportData", () => {
  const stamp = Date.now();
  const H = 3600 * 1000;
  let headId: string;
  let userId: string;
  let adminId: string;

  beforeAll(async () => {
    await mongoose.connect(process.env.MONGODB_URI as string);
    const [head, user, admin] = await User.create([
      { openId: `ar-head-${stamp}`, name: "Dept Head", role: "dept_head", employeeId: `ARH${stamp}` },
      { openId: `ar-user-${stamp}`, name: "Worker", role: "user", employeeId: `ARU${stamp}` },
      { openId: `ar-adm-${stamp}`, name: "Boss", role: "admin", employeeId: `ARA${stamp}` },
    ]);
    headId = String(head._id);
    userId = String(user._id);
    adminId = String(admin._id);

    const base = new Date();
    await TimeEntry.create([
      { userId: headId, timeIn: base, timeOut: new Date(base.getTime() + 8 * H), totalHours: 8, status: "completed" },
      { userId: userId, timeIn: base, timeOut: new Date(base.getTime() + 8 * H), totalHours: 8, status: "completed" },
      { userId: adminId, timeIn: base, timeOut: new Date(base.getTime() + 8 * H), totalHours: 8, status: "completed" },
    ]);
  });

  afterAll(async () => {
    const ids = [headId, userId, adminId];
    await TimeEntry.deleteMany({ userId: { $in: ids } });
    await User.deleteMany({ _id: { $in: ids } });
    await mongoose.connection.close();
  });

  it("includes a department head's data, and leaves admins out", async () => {
    const start = new Date(Date.now() - 2 * H);
    const end = new Date(Date.now() + 2 * H);
    const { users, entries } = await getAttendanceReportData(start, end);

    const ids = new Set(users.map(u => u.id));
    expect(ids.has(headId)).toBe(true);
    expect(ids.has(userId)).toBe(true);
    expect(ids.has(adminId)).toBe(false);

    expect(entries.some(e => e.userId === headId)).toBe(true);
  });

  it("returns a single head's month when filtered to them", async () => {
    const start = new Date(Date.now() - 2 * H);
    const end = new Date(Date.now() + 2 * H);
    const { users } = await getAttendanceReportData(start, end, headId);
    expect(users.map(u => u.id)).toEqual([headId]);
  });
});
