import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import mongoose from "mongoose";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { Department, LeaveApplication, TimeEntry, User } from "./models";
import { setDepartmentHead, setUserDepartment } from "./departments";
import { describeWithDb } from "./test-utils";

/**
 * A department head can finally see their own team - who is clocked in, hours,
 * and outstanding leave - and only their own team.
 *
 *   TEST_MONGODB_URI="mongodb://.../hrms_test" npx vitest run teamOverview.test.ts
 */
describeWithDb("team.getOverview", () => {
  const stamp = Date.now();
  const H = 3600 * 1000;
  let adminId: string;
  let headAId: string;
  let memberAId: string;
  let headBId: string;
  let memberBId: string;
  let deptAId: string;
  let deptBId: string;

  const ctxFor = (id: string, role: string) =>
    ({ user: { id, role, name: "x" }, req: { protocol: "https", headers: {} }, res: { cookie() {}, clearCookie() {} } }) as unknown as TrpcContext;
  const caller = (id: string, role: string) => appRouter.createCaller(ctxFor(id, role));

  beforeAll(async () => {
    await mongoose.connect(process.env.MONGODB_URI as string);
    const [admin, ha, ma, hb, mb] = await User.create([
      { openId: `to-adm-${stamp}`, name: "Ops", role: "admin", employeeId: `TOADM${stamp}` },
      { openId: `to-ha-${stamp}`, name: "Head A", role: "user", employeeId: `TOHA${stamp}` },
      { openId: `to-ma-${stamp}`, name: "Member A", role: "user", employeeId: `TOMA${stamp}` },
      { openId: `to-hb-${stamp}`, name: "Head B", role: "user", employeeId: `TOHB${stamp}` },
      { openId: `to-mb-${stamp}`, name: "Member B", role: "user", employeeId: `TOMB${stamp}` },
    ]);
    adminId = String(admin._id); headAId = String(ha._id); memberAId = String(ma._id);
    headBId = String(hb._id); memberBId = String(mb._id);

    const a = await Department.create({ name: `TO A ${stamp}` });
    const b = await Department.create({ name: `TO B ${stamp}` });
    deptAId = String(a._id); deptBId = String(b._id);
    await setUserDepartment(headAId, deptAId);
    await setUserDepartment(memberAId, deptAId);
    await setUserDepartment(headBId, deptBId);
    await setUserDepartment(memberBId, deptBId);
    await setDepartmentHead(deptAId, headAId);
    await setDepartmentHead(deptBId, headBId);
  });

  afterAll(async () => {
    const ids = [adminId, headAId, memberAId, headBId, memberBId];
    await TimeEntry.deleteMany({ userId: { $in: ids } });
    await LeaveApplication.deleteMany({ userId: { $in: ids } });
    await Department.deleteMany({ name: new RegExp(`^TO [AB] ${stamp}`) });
    await User.deleteMany({ _id: { $in: ids } });
    await mongoose.connection.close();
  });

  beforeEach(async () => {
    const ids = [adminId, headAId, memberAId, headBId, memberBId];
    await TimeEntry.deleteMany({ userId: { $in: ids } });
    await LeaveApplication.deleteMany({ userId: { $in: ids } });
  });

  const asHeadA = () => caller(headAId, "dept_head");

  it("shows a head only their own department's people", async () => {
    const res = await asHeadA().team.getOverview();
    const names = res.members.map(m => m.name).sort();
    expect(names).toEqual(["Head A", "Member A"]);
    // Never the other department.
    expect(names).not.toContain("Member B");
  });

  it("reports who is clocked in right now, and since when", async () => {
    const since = new Date(Date.now() - 3 * H);
    await TimeEntry.create({ userId: memberAId, timeIn: since, status: "active" });

    const res = await asHeadA().team.getOverview();
    const member = res.members.find(m => m.id === memberAId)!;
    expect(member.clockedInSince).not.toBeNull();
    expect(new Date(member.clockedInSince!).getTime()).toBe(since.getTime());

    // Head A is not clocked in.
    expect(res.members.find(m => m.id === headAId)!.clockedInSince).toBeNull();
  });

  it("counts this month's hours and present days", async () => {
    const key = new Date().toISOString().slice(0, 10);
    const base = new Date(`${key}T04:00:00.000Z`);
    await TimeEntry.create({
      userId: memberAId, timeIn: base, timeOut: new Date(base.getTime() + 8 * H),
      totalHours: 8, status: "completed",
    });

    const member = (await asHeadA().team.getOverview()).members.find(m => m.id === memberAId)!;
    expect(member.presentDays).toBeGreaterThanOrEqual(1);
    expect(member.totalHours).toBeGreaterThanOrEqual(8);
  });

  it("surfaces a member's pending leave count", async () => {
    await LeaveApplication.create({
      userId: memberAId, leaveType: "casual", reason: "x", status: "pending",
      startDate: new Date(), endDate: new Date(),
    });
    const member = (await asHeadA().team.getOverview()).members.find(m => m.id === memberAId)!;
    expect(member.pendingLeaveCount).toBe(1);
  });

  it("flags a forgotten clock-out that the sweep closed", async () => {
    const key = new Date().toISOString().slice(0, 10);
    const base = new Date(`${key}T04:00:00.000Z`);
    await TimeEntry.create({
      userId: memberAId, timeIn: base, timeOut: new Date(base.getTime() + 12 * H),
      totalHours: 12, status: "completed", autoClockedOut: true,
    });
    const member = (await asHeadA().team.getOverview()).members.find(m => m.id === memberAId)!;
    expect(member.missingClockOuts).toBe(1);
  });

  it("refuses an ordinary employee", async () => {
    await expect(caller(memberAId, "user").team.getOverview()).rejects.toThrow(/not permitted/i);
  });

  it("stops a head peeking at a department they do not lead", async () => {
    await expect(
      asHeadA().team.getOverview({ departmentId: deptBId })
    ).rejects.toThrow(/not your department/i);
  });

  it("lets an org-wide role see every department", async () => {
    const res = await caller(adminId, "admin").team.getOverview();
    const names = res.members.map(m => m.name);
    expect(names).toEqual(expect.arrayContaining(["Member A", "Member B"]));
  });
});
