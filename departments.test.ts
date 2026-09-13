import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import mongoose from "mongoose";
import { Department, User } from "./models";
import {
  canActOnUser,
  createDepartment,
  departmentsLedBy,
  getDepartmentOf,
  listDepartments,
  renameDepartment,
  setDepartmentHead,
  setUserDepartment,
} from "./departments";
import { describeWithDb } from "./test-utils";

/**
 *   TEST_MONGODB_URI="mongodb://.../hrms_test" npx vitest run departments.test.ts
 */
describeWithDb("Departments", () => {
  const stamp = Date.now();
  let adminId: string;
  let headId: string;
  let memberId: string;
  let outsiderId: string;
  let deptId: string;
  let otherDeptId: string;

  beforeAll(async () => {
    await mongoose.connect(process.env.MONGODB_URI as string);
    const [admin, head, member, outsider] = await User.create([
      { openId: `dep-adm-${stamp}`, name: "Dept Admin", role: "admin", employeeId: `DADM${stamp}` },
      { openId: `dep-hd-${stamp}`, name: "Dept Head", role: "user", employeeId: `DHD${stamp}` },
      { openId: `dep-mem-${stamp}`, name: "Dept Member", role: "user", employeeId: `DMEM${stamp}` },
      { openId: `dep-out-${stamp}`, name: "Other Dept", role: "user", employeeId: `DOUT${stamp}` },
    ]);
    adminId = String(admin._id);
    headId = String(head._id);
    memberId = String(member._id);
    outsiderId = String(outsider._id);
  });

  afterAll(async () => {
    const ids = [adminId, headId, memberId, outsiderId];
    await Department.deleteMany({ name: new RegExp(`^T${stamp}`) });
    await User.deleteMany({ _id: { $in: ids } });
    await mongoose.connection.close();
  });

  beforeEach(async () => {
    await Department.deleteMany({ name: new RegExp(`^T${stamp}`) });
    await User.updateMany(
      { _id: { $in: [headId, memberId, outsiderId] } },
      { role: "user", $unset: { departmentId: "" }, department: "" }
    );

    const main = await createDepartment(`T${stamp} Main`);
    const other = await createDepartment(`T${stamp} Other`);
    deptId = main.id;
    otherDeptId = other.id;

    await setUserDepartment(headId, deptId);
    await setUserDepartment(memberId, deptId);
    await setUserDepartment(outsiderId, otherDeptId);
  });

  it("refuses a second department with the same name, whatever the casing", async () => {
    // Two spellings of one department would each hold a head, and then nobody
    // could say who approves for the people in it.
    await expect(createDepartment(`t${stamp} main`)).rejects.toThrow(/already exists/i);
    await expect(createDepartment(`  T${stamp} Main  `)).rejects.toThrow(/already exists/i);
  });

  it("makes someone the head and gives them the role in one step", async () => {
    await setDepartmentHead(deptId, headId);

    const saved = await User.findById(headId).lean();
    expect(saved!.role).toBe("dept_head");
    expect(await departmentsLedBy(headId)).toEqual([deptId]);
  });

  it("does not demote an admin who takes over a department", async () => {
    await setDepartmentHead(deptId, adminId);

    const saved = await User.findById(adminId).lean();
    // Promote, never demote - otherwise putting an admin in charge of a team
    // quietly strips their access to everything else.
    expect(saved!.role).toBe("admin");
  });

  it("clears the post without touching the person", async () => {
    await setDepartmentHead(deptId, headId);
    await setDepartmentHead(deptId, null);

    const department = await Department.findById(deptId).lean();
    expect(department!.headUserId).toBeUndefined();
    expect(await departmentsLedBy(headId)).toEqual([]);
  });

  it("resolves an employee to their department and its head", async () => {
    await setDepartmentHead(deptId, headId);

    const chain = await getDepartmentOf(memberId);
    expect(chain.departmentId).toBe(deptId);
    expect(chain.headUserId).toBe(headId);
  });

  it("answers with nothing for someone in no department", async () => {
    await setUserDepartment(memberId, null);

    const chain = await getDepartmentOf(memberId);
    expect(chain).toEqual({ departmentId: null, departmentName: null, headUserId: null });
  });

  it("carries a rename onto the display name each user still shows", async () => {
    await renameDepartment(deptId, `T${stamp} Renamed`);

    const saved = await User.findById(memberId).lean();
    // Reports group by this string; leaving it stale splits one department in
    // two on every report.
    expect(saved!.department).toBe(`T${stamp} Renamed`);
  });

  it("counts the people in each department", async () => {
    const all = await listDepartments();
    const main = all.find(d => d.id === deptId);
    expect(main!.memberCount).toBe(2);
  });

  // ----------------------------------------------------------- who acts on whom

  it("lets a head act on their own department only", async () => {
    await setDepartmentHead(deptId, headId);
    const head = { id: headId, role: "dept_head" };

    expect(await canActOnUser(head, memberId)).toBe(true);
    // Someone else's department is not theirs to touch.
    expect(await canActOnUser(head, outsiderId)).toBe(false);
  });

  it("lets org-wide roles act on anyone", async () => {
    expect(await canActOnUser({ id: adminId, role: "admin" }, outsiderId)).toBe(true);
    expect(await canActOnUser({ id: adminId, role: "head_of_ops" }, outsiderId)).toBe(true);
  });

  it("lets an ordinary employee act only on themselves", async () => {
    const member = { id: memberId, role: "user" };
    expect(await canActOnUser(member, memberId)).toBe(true);
    expect(await canActOnUser(member, outsiderId)).toBe(false);
  });

  it("gives a head no reach once the post is taken from them", async () => {
    await setDepartmentHead(deptId, headId);
    const head = { id: headId, role: "dept_head" };
    expect(await canActOnUser(head, memberId)).toBe(true);

    await setDepartmentHead(deptId, null);

    // The role alone must not be enough; it is leading the department that
    // grants the reach.
    expect(await canActOnUser(head, memberId)).toBe(false);
  });
});
