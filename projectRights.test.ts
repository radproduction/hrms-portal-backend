import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import mongoose from "mongoose";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { Department, User } from "./models";
import { FpbProject } from "./fpbModels";
import { canOpenProjects, setDepartmentHead, setUserDepartment } from "./departments";
import { describeWithDb } from "./test-utils";

/**
 * Opening a project used to be open to everyone. It is now a grant a super
 * admin gives to a department head.
 *
 *   TEST_MONGODB_URI="mongodb://.../hrms_test" npx vitest run projectRights.test.ts
 */
describeWithDb("Project creation rights", () => {
  const stamp = Date.now();
  let adminId: string;
  let hooId: string;
  let headId: string;
  let memberId: string;
  let deptId: string;

  const ctxFor = (id: string, role: string) =>
    ({
      user: { id, role, name: "Someone" },
      req: { protocol: "https", headers: {} },
      res: { cookie: () => {}, clearCookie: () => {} },
    }) as unknown as TrpcContext;

  const caller = (id: string, role: string) => appRouter.createCaller(ctxFor(id, role));

  beforeAll(async () => {
    await mongoose.connect(process.env.MONGODB_URI as string);
    const [admin, hoo, head, member] = await User.create([
      { openId: `pr-adm-${stamp}`, name: "PR Admin", role: "admin", employeeId: `PRA${stamp}` },
      { openId: `pr-hoo-${stamp}`, name: "PR Ops", role: "head_of_ops", employeeId: `PRO${stamp}` },
      { openId: `pr-hd-${stamp}`, name: "PR Head", role: "user", employeeId: `PRH${stamp}` },
      { openId: `pr-mem-${stamp}`, name: "PR Member", role: "user", employeeId: `PRM${stamp}` },
    ]);
    adminId = String(admin._id);
    hooId = String(hoo._id);
    headId = String(head._id);
    memberId = String(member._id);

    const dept = await Department.create({ name: `P${stamp} Dept` });
    deptId = String(dept._id);
    await setUserDepartment(headId, deptId);
    await setUserDepartment(memberId, deptId);
    await setDepartmentHead(deptId, headId);
  });

  afterAll(async () => {
    const ids = [adminId, hooId, headId, memberId];
    await FpbProject.deleteMany({ createdBy: { $in: ids } });
    await Department.deleteMany({ name: new RegExp(`^P${stamp}`) });
    await User.deleteMany({ _id: { $in: ids } });
    await mongoose.connection.close();
  });

  beforeEach(async () => {
    await FpbProject.deleteMany({ createdBy: { $in: [adminId, hooId, headId, memberId] } });
    await Department.findByIdAndUpdate(deptId, { canCreateProjects: false });
  });

  const makeProject = (id: string, role: string) =>
    caller(id, role).fpb.createProject({ title: `P${stamp}`, projectType: "dev" });

  it("refuses an ordinary employee", async () => {
    await expect(makeProject(memberId, "user")).rejects.toThrow(/do not have permission/i);
  });

  it("refuses a head whose department has not been granted it", async () => {
    // Leading a team is not on its own a licence to open projects.
    await expect(makeProject(headId, "dept_head")).rejects.toThrow(/do not have permission/i);
  });

  it("lets that same head through once a super admin grants it", async () => {
    await caller(adminId, "admin").admin.setDepartmentProjectRights({
      departmentId: deptId,
      allowed: true,
    });

    const project = await makeProject(headId, "dept_head");
    expect(project.title).toBe(`P${stamp}`);
  });

  it("takes the right away again when the grant is withdrawn", async () => {
    await caller(adminId, "admin").admin.setDepartmentProjectRights({
      departmentId: deptId,
      allowed: true,
    });
    expect(await canOpenProjects({ id: headId, role: "dept_head" })).toBe(true);

    await caller(adminId, "admin").admin.setDepartmentProjectRights({
      departmentId: deptId,
      allowed: false,
    });
    expect(await canOpenProjects({ id: headId, role: "dept_head" })).toBe(false);
  });

  it("always lets org-wide roles through, grant or no grant", async () => {
    await expect(makeProject(adminId, "admin")).resolves.toBeTruthy();
    await expect(makeProject(hooId, "head_of_ops")).resolves.toBeTruthy();
  });

  it("keeps the grant to a super admin", async () => {
    // A head of operations reaches everything else, but handing out rights is
    // how the hierarchy is set, and that stays one level up.
    await expect(
      caller(hooId, "head_of_ops").admin.setDepartmentProjectRights({
        departmentId: deptId,
        allowed: true,
      })
    ).rejects.toThrow(/super admin/i);

    await expect(
      caller(headId, "dept_head").admin.setDepartmentProjectRights({
        departmentId: deptId,
        allowed: true,
      })
    ).rejects.toThrow(/super admin/i);
  });

  it("reports the same answer to the UI as the mutation enforces", async () => {
    // The button is hidden using this; if the two disagreed, people would be
    // offered something that then refuses them.
    expect(await caller(headId, "dept_head").fpb.canCreateProjects()).toBe(false);

    await caller(adminId, "admin").admin.setDepartmentProjectRights({
      departmentId: deptId,
      allowed: true,
    });

    expect(await caller(headId, "dept_head").fpb.canCreateProjects()).toBe(true);
    expect(await caller(memberId, "user").fpb.canCreateProjects()).toBe(false);
  });

  it("grants the head, not everyone in the department", async () => {
    await caller(adminId, "admin").admin.setDepartmentProjectRights({
      departmentId: deptId,
      allowed: true,
    });

    await expect(makeProject(memberId, "user")).rejects.toThrow(/do not have permission/i);
  });
});
