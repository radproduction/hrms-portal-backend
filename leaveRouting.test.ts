import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import mongoose from "mongoose";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { Department, LeaveApplication, Notification, User } from "./models";
import { setDepartmentHead, setUserDepartment } from "./departments";
import { resolveApprover } from "./leaveRouting";
import { describeWithDb } from "./test-utils";

/** The branching, with no database in the way. */
describe("resolveApprover", () => {
  const base = { applicantId: "emp", escalation: ["hoo", "admin"] };

  it("sends an ordinary request to the department head", () => {
    expect(resolveApprover({ ...base, departmentHeadId: "head" })).toEqual({
      approverId: "head",
      reason: "department_head",
    });
  });

  it("escalates a head's own request instead of handing it back to them", () => {
    // Approving your own leave is not an approval.
    expect(resolveApprover({ ...base, applicantId: "head", departmentHeadId: "head" })).toEqual({
      approverId: "hoo",
      reason: "escalated_self",
    });
  });

  it("escalates when the department has no head", () => {
    expect(resolveApprover({ ...base, departmentHeadId: null })).toEqual({
      approverId: "hoo",
      reason: "escalated_no_head",
    });
  });

  it("prefers the first escalation candidate", () => {
    // head_of_ops before admin: the smallest step up that still has the reach.
    const result = resolveApprover({ ...base, departmentHeadId: null });
    expect(result.approverId).toBe("hoo");
  });

  it("never escalates a request back to the person who made it", () => {
    const result = resolveApprover({
      applicantId: "hoo",
      departmentHeadId: null,
      escalation: ["hoo", "admin"],
    });
    expect(result.approverId).toBe("admin");
  });

  it("records the request unassigned when there is nobody at all", () => {
    // Still a real outcome: it is saved, and anyone org-wide can act on it.
    expect(resolveApprover({ applicantId: "emp", departmentHeadId: null, escalation: [] })).toEqual({
      approverId: null,
      reason: "unassigned",
    });
  });
});

/**
 *   TEST_MONGODB_URI="mongodb://.../hrms_test" npx vitest run leaveRouting.test.ts
 */
describeWithDb("Leave approval chain", () => {
  const stamp = Date.now();
  let adminId: string;
  let headId: string;
  let memberId: string;
  let otherHeadId: string;
  let otherMemberId: string;
  let deptId: string;
  let otherDeptId: string;

  const ctxFor = (id: string, role: string, name = "Someone") =>
    ({
      user: { id, role, name },
      req: { protocol: "https", headers: {} },
      res: { cookie: () => {}, clearCookie: () => {} },
    }) as unknown as TrpcContext;

  const caller = (id: string, role: string) => appRouter.createCaller(ctxFor(id, role));

  beforeAll(async () => {
    await mongoose.connect(process.env.MONGODB_URI as string);
    const [admin, head, member, otherHead, otherMember] = await User.create([
      { openId: `lv-adm-${stamp}`, name: "Leave Admin", role: "admin", employeeId: `LADM${stamp}` },
      { openId: `lv-hd-${stamp}`, name: "Head A", role: "user", employeeId: `LHDA${stamp}` },
      { openId: `lv-mem-${stamp}`, name: "Member A", role: "user", employeeId: `LMEM${stamp}` },
      { openId: `lv-hd2-${stamp}`, name: "Head B", role: "user", employeeId: `LHDB${stamp}` },
      { openId: `lv-mem2-${stamp}`, name: "Member B", role: "user", employeeId: `LMB${stamp}` },
    ]);
    adminId = String(admin._id);
    headId = String(head._id);
    memberId = String(member._id);
    otherHeadId = String(otherHead._id);
    otherMemberId = String(otherMember._id);

    const a = await Department.create({ name: `L${stamp} A` });
    const b = await Department.create({ name: `L${stamp} B` });
    deptId = String(a._id);
    otherDeptId = String(b._id);

    await setUserDepartment(headId, deptId);
    await setUserDepartment(memberId, deptId);
    await setUserDepartment(otherHeadId, otherDeptId);
    await setUserDepartment(otherMemberId, otherDeptId);
    await setDepartmentHead(deptId, headId);
    await setDepartmentHead(otherDeptId, otherHeadId);
  });

  afterAll(async () => {
    const ids = [adminId, headId, memberId, otherHeadId, otherMemberId];
    await LeaveApplication.deleteMany({ userId: { $in: ids } });
    await Notification.deleteMany({ userId: { $in: ids } });
    await Department.deleteMany({ name: new RegExp(`^L${stamp}`) });
    await User.deleteMany({ _id: { $in: ids } });
    await mongoose.connection.close();
  });

  beforeEach(async () => {
    const ids = [adminId, headId, memberId, otherHeadId, otherMemberId];
    await LeaveApplication.deleteMany({ userId: { $in: ids } });
    await Notification.deleteMany({ userId: { $in: ids } });
  });

  const submitAs = (id: string, role = "user") =>
    caller(id, role).leaves.submit({
      leaveType: "casual",
      startDate: new Date("2026-10-05"),
      endDate: new Date("2026-10-06"),
      reason: "Family",
    });

  it("sends an employee's request to their own department head", async () => {
    const result = await submitAs(memberId);
    expect(result.routedTo).toBe("department_head");

    const saved = await LeaveApplication.findOne({ userId: memberId }).lean();
    expect(String(saved!.approverUserId)).toBe(headId);
  });

  it("tells the head there is something to review", async () => {
    await submitAs(memberId);
    const notified = await Notification.countDocuments({ userId: headId });
    expect(notified).toBe(1);
  });

  it("sends a head's own request upwards, not to themselves", async () => {
    const result = await submitAs(headId, "dept_head");
    expect(result.routedTo).toBe("escalated_self");

    const saved = await LeaveApplication.findOne({ userId: headId }).lean();
    // Which senior person it lands on is not fixed - any org-wide role can
    // act. What matters is that it did not go back to the applicant.
    expect(saved!.approverUserId).toBeTruthy();
    expect(String(saved!.approverUserId)).not.toBe(headId);
  });

  it("shows a head only the requests sent to them", async () => {
    await submitAs(memberId);
    await submitAs(otherMemberId);

    const queue = await caller(headId, "dept_head").admin.getLeaveRequests();
    expect(queue).toHaveLength(1);
    // The applicant comes back populated, under `user`.
    expect(String((queue[0] as any).user.id)).toBe(memberId);
  });

  it("shows every request to an admin", async () => {
    await submitAs(memberId);
    await submitAs(otherMemberId);

    const queue = await caller(adminId, "admin").admin.getLeaveRequests();
    expect(queue.length).toBeGreaterThanOrEqual(2);
  });

  it("refuses the queue to an ordinary employee", async () => {
    await expect(
      caller(memberId, "user").admin.getLeaveRequests()
    ).rejects.toThrow(/not permitted/i);
  });

  it("lets the assigned head approve, and tells the applicant", async () => {
    await submitAs(memberId);
    const leave = await LeaveApplication.findOne({ userId: memberId }).lean();
    await Notification.deleteMany({ userId: memberId });

    await caller(headId, "dept_head").admin.updateLeaveRequest({
      id: String(leave!._id),
      status: "approved",
    });

    const saved = await LeaveApplication.findById(leave!._id).lean();
    expect(saved!.status).toBe("approved");
    expect(String(saved!.approvedBy)).toBe(headId);

    const told = await Notification.findOne({ userId: memberId, type: "leave_approved" }).lean();
    expect(told).toBeTruthy();
  });

  it("stops a head deciding another department's request", async () => {
    await submitAs(otherMemberId);
    const leave = await LeaveApplication.findOne({ userId: otherMemberId }).lean();

    await expect(
      caller(headId, "dept_head").admin.updateLeaveRequest({
        id: String(leave!._id),
        status: "approved",
      })
    ).rejects.toThrow(/not sent to you/i);
  });

  it("stops anyone approving their own request, admin included", async () => {
    await submitAs(adminId, "admin");
    const leave = await LeaveApplication.findOne({ userId: adminId }).lean();

    // The routing already escalates a head's own request; this is the backstop
    // for one that reached them another way.
    await expect(
      caller(adminId, "admin").admin.updateLeaveRequest({
        id: String(leave!._id),
        status: "approved",
      })
    ).rejects.toThrow(/your own leave/i);
  });

  it("lets an admin step in on a request routed to someone else", async () => {
    await submitAs(memberId);
    const leave = await LeaveApplication.findOne({ userId: memberId }).lean();

    // The escape hatch for an approver who has left or is away.
    await caller(adminId, "admin").admin.updateLeaveRequest({
      id: String(leave!._id),
      status: "rejected",
      rejectionReason: "Covered elsewhere",
    });

    const saved = await LeaveApplication.findById(leave!._id).lean();
    expect(saved!.status).toBe("rejected");
    expect(String(saved!.approvedBy)).toBe(adminId);
  });

  it("keeps a pending request with the head it was sent to when the applicant moves team", async () => {
    await submitAs(memberId);
    const leave = await LeaveApplication.findOne({ userId: memberId }).lean();

    await setUserDepartment(memberId, otherDeptId);

    // Recomputing the route on read would hand it to Head B, who was never
    // asked; Head A must keep it.
    const queue = await caller(headId, "dept_head").admin.getLeaveRequests();
    expect(queue.map((l: any) => String(l.id))).toContain(String(leave!._id));

    await setUserDepartment(memberId, deptId);
  });
});
