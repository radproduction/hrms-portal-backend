import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import mongoose from "mongoose";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { Notification, User } from "./models";
import {
  FpbActivity,
  FpbAnnotation,
  FpbColumn,
  FpbProject,
  FpbProjectMember,
  FpbSubtask,
  FpbTask,
  FpbTaskComment,
  FpbTaskMember,
} from "./fpbModels";
import { describeWithDb } from "./test-utils";

/**
 * The board is shaped like Jira: a project is a workspace that owns its own
 * columns, and tasks are the cards that move between them. An earlier cut had
 * projects themselves moving across one global board, which is what these tests
 * now guard against regressing to.
 *
 * Needs a throwaway database:
 *   TEST_MONGODB_URI="mongodb://.../hrms_test" npm test
 */
describeWithDb("Flow Project Board", () => {
  let adminId: string;
  let memberId: string;
  let outsiderId: string;

  const ctxFor = (id: string, role: "admin" | "user") =>
    ({
      user: { id, role },
      req: { protocol: "https", headers: {} },
      res: { cookie: () => {}, clearCookie: () => {} },
    }) as unknown as TrpcContext;

  const asAdmin = () => appRouter.createCaller(ctxFor(adminId, "admin"));
  const asMember = () => appRouter.createCaller(ctxFor(memberId, "user"));
  const asOutsider = () => appRouter.createCaller(ctxFor(outsiderId, "user"));

  beforeAll(async () => {
    await mongoose.connect(process.env.MONGODB_URI as string);
    const stamp = Date.now();
    const [admin, member, outsider] = await User.create([
      { openId: `fpb-adm-${stamp}`, name: "Board Admin", role: "admin", employeeId: `FADM${stamp}` },
      { openId: `fpb-mem-${stamp}`, name: "Board Member", role: "user", employeeId: `FMEM${stamp}` },
      { openId: `fpb-out-${stamp}`, name: "Outsider", role: "user", employeeId: `FOUT${stamp}` },
    ]);
    adminId = String(admin._id);
    memberId = String(member._id);
    outsiderId = String(outsider._id);
  });

  afterAll(async () => {
    if (!adminId) return;
    const ids = [adminId, memberId, outsiderId];
    await Promise.all([
      FpbSubtask.deleteMany({}), FpbTaskComment.deleteMany({}), FpbTaskMember.deleteMany({}),
      FpbTask.deleteMany({}), FpbColumn.deleteMany({}), FpbProjectMember.deleteMany({}),
      FpbActivity.deleteMany({}), FpbAnnotation.deleteMany({}),
    ]);
    await Promise.all([
      FpbProject.deleteMany({}),
      Notification.deleteMany({ userId: { $in: ids } }),
      User.deleteMany({ _id: { $in: ids } }),
    ]);
    await mongoose.connection.close();
  });

  beforeEach(async () => {
    await Promise.all([
      FpbProject.deleteMany({}), FpbColumn.deleteMany({}), FpbTask.deleteMany({}),
      FpbProjectMember.deleteMany({}), FpbTaskMember.deleteMany({}), FpbSubtask.deleteMany({}),
    ]);
  });

  /** Creates a project and returns it together with its seeded columns. */
  async function newProject(title = "Project", memberIds: string[] = []) {
    const project = await asAdmin().fpb.createProject({
      title, projectType: "dev", memberIds,
    });
    const board = await asAdmin().fpb.getBoard({ projectId: project.id });
    return { project, columns: board.columns };
  }

  // -------------------------------------------------------------- structure

  it("gives each new project its own board with default columns", async () => {
    const { project, columns } = await newProject("Alpha");

    expect(columns.map((c: any) => c.name)).toEqual([
      "Backlog", "To Do", "In Progress", "In Review", "Done",
    ]);
    // Columns belong to the project, not to anything global.
    expect(columns.every((c: any) => c.projectId === project.id)).toBe(true);
  });

  it("keeps one project's columns out of another's", async () => {
    const a = await newProject("Alpha");
    const b = await newProject("Beta");

    await asAdmin().fpb.createColumn({ projectId: a.project.id, name: "QA only in Alpha" });

    const boardA = await asAdmin().fpb.getBoard({ projectId: a.project.id });
    const boardB = await asAdmin().fpb.getBoard({ projectId: b.project.id });

    expect(boardA.columns.map((c: any) => c.name)).toContain("QA only in Alpha");
    expect(boardB.columns.map((c: any) => c.name)).not.toContain("QA only in Alpha");
  });

  it("accepts a custom set of columns at creation", async () => {
    const project = await asAdmin().fpb.createProject({
      title: "Marketing push",
      projectType: "management",
      columns: [
        { name: "Marketing", color: "#ec4899" },
        { name: "Design", color: "#8b5cf6" },
        { name: "Review", color: "#10b981" },
      ],
    });
    const board = await asAdmin().fpb.getBoard({ projectId: project.id });
    expect(board.columns.map((c: any) => c.name)).toEqual(["Marketing", "Design", "Review"]);
  });

  it("has no notion of a project sitting in a column", async () => {
    const { project } = await newProject();
    const stored = await FpbProject.findById(project.id).lean();
    // The old shape had columnId/position on the project itself.
    expect((stored as any).columnId).toBeUndefined();
    expect((stored as any).position).toBeUndefined();
  });

  // ------------------------------------------------------------ task cards

  it("drops a new task into the first column", async () => {
    const { project, columns } = await newProject();
    const task = await asAdmin().fpb.createTask({ projectId: project.id, title: "First" });
    expect(task.columnId).toBe(columns[0].id);
  });

  it("puts a task straight into a chosen column", async () => {
    const { project, columns } = await newProject();
    const task = await asAdmin().fpb.createTask({
      projectId: project.id, columnId: columns[2].id, title: "Straight to work",
    });
    expect(task.columnId).toBe(columns[2].id);
  });

  it("moves a task between columns and keeps positions dense", async () => {
    const { project, columns } = await newProject();
    const a = await asAdmin().fpb.createTask({ projectId: project.id, title: "A" });
    const b = await asAdmin().fpb.createTask({ projectId: project.id, title: "B" });
    await asAdmin().fpb.createTask({ projectId: project.id, title: "C" });

    await asAdmin().fpb.moveTask({ id: b.id, columnId: columns[2].id, position: 0 });

    const board = await asAdmin().fpb.getBoard({ projectId: project.id });
    const first = board.tasks.filter((t: any) => t.columnId === columns[0].id)
      .sort((x: any, y: any) => x.position - y.position);
    const third = board.tasks.filter((t: any) => t.columnId === columns[2].id);

    expect(first.map((t: any) => t.title)).toEqual(["A", "C"]);
    // The gap B left behind is closed rather than left as 0,2.
    expect(first.map((t: any) => t.position)).toEqual([0, 1]);
    expect(third.map((t: any) => t.title)).toEqual(["B"]);
    expect(third[0].position).toBe(0);
    expect(a.id).toBeTruthy();
  });

  it("reorders within one column", async () => {
    const { project, columns } = await newProject();
    await asAdmin().fpb.createTask({ projectId: project.id, title: "A" });
    await asAdmin().fpb.createTask({ projectId: project.id, title: "B" });
    const c = await asAdmin().fpb.createTask({ projectId: project.id, title: "C" });

    await asAdmin().fpb.moveTask({ id: c.id, columnId: columns[0].id, position: 0 });

    const board = await asAdmin().fpb.getBoard({ projectId: project.id });
    const ordered = board.tasks.sort((x: any, y: any) => x.position - y.position);
    expect(ordered.map((t: any) => t.title)).toEqual(["C", "A", "B"]);
    expect(ordered.map((t: any) => t.position)).toEqual([0, 1, 2]);
  });

  it("refuses to move a task into another project's column", async () => {
    const a = await newProject("Alpha");
    const b = await newProject("Beta");
    const task = await asAdmin().fpb.createTask({ projectId: a.project.id, title: "stay put" });

    await expect(
      asAdmin().fpb.moveTask({ id: task.id, columnId: b.columns[0].id, position: 0 })
    ).rejects.toThrow(/does not belong to this project/);
  });

  it("clamps an out-of-range drop index", async () => {
    const { project, columns } = await newProject();
    const t = await asAdmin().fpb.createTask({ projectId: project.id, title: "A" });
    await asAdmin().fpb.moveTask({ id: t.id, columnId: columns[1].id, position: 99 });

    const board = await asAdmin().fpb.getBoard({ projectId: project.id });
    expect(board.tasks[0].position).toBe(0);
  });

  // ------------------------------------------------------ column deletion

  it("rehomes tasks when their column is deleted", async () => {
    const { project, columns } = await newProject();
    const task = await asAdmin().fpb.createTask({
      projectId: project.id, columnId: columns[2].id, title: "Needs a home",
    });

    const result = await asAdmin().fpb.deleteColumn({ id: columns[2].id });
    expect(result.moved).toBe(1);

    const board = await asAdmin().fpb.getBoard({ projectId: project.id });
    const moved = board.tasks.find((t: any) => t.id === task.id);
    expect(moved).toBeDefined();
    expect(moved!.columnId).toBe(columns[1].id);
  });

  it("refuses to delete a project's last column", async () => {
    const { project, columns } = await newProject();
    for (const col of columns.slice(1)) {
      await asAdmin().fpb.deleteColumn({ id: col.id });
    }
    await expect(
      asAdmin().fpb.deleteColumn({ id: columns[0].id })
    ).rejects.toThrow(/Cannot delete the last column/);
  });

  it("removes a project's columns along with the project", async () => {
    const { project } = await newProject();
    await asAdmin().fpb.createTask({ projectId: project.id, title: "t" });

    await asAdmin().fpb.deleteProject({ id: project.id });

    expect(await FpbColumn.countDocuments({ projectId: project.id })).toBe(0);
    expect(await FpbTask.countDocuments({ projectId: project.id })).toBe(0);
  });

  // ------------------------------------------------------------- task work

  it("rolls task progress up onto the project", async () => {
    const { project } = await newProject();
    const a = await asAdmin().fpb.createTask({ projectId: project.id, title: "one" });
    await asAdmin().fpb.createTask({ projectId: project.id, title: "two" });
    await asAdmin().fpb.updateTask({ id: a.id, completed: true });

    const listed = (await asAdmin().fpb.getProjects()).find((p: any) => p.id === project.id);
    expect(listed!.taskCount).toBe(2);
    expect(listed!.completedTasks).toBe(1);
    expect(listed!.progress).toBe(50);
  });

  it("keeps completed and status in agreement", async () => {
    const { project } = await newProject();
    const task = await asAdmin().fpb.createTask({ projectId: project.id, title: "t" });

    const done = await asAdmin().fpb.updateTask({ id: task.id, completed: true });
    expect(done!.status).toBe("done");
    expect(done!.progress).toBe(100);

    const reopened = await asAdmin().fpb.updateTask({ id: task.id, completed: false });
    expect(reopened!.status).not.toBe("done");
  });

  it("carries subtasks and members on the board payload", async () => {
    const { project } = await newProject("Deep", [memberId]);
    const task = await asAdmin().fpb.createTask({
      projectId: project.id, title: "parent", memberIds: [memberId],
    });
    await asAdmin().fpb.createSubtask({ taskId: task.id, title: "child" });

    const board = await asAdmin().fpb.getBoard({ projectId: project.id });
    expect((board.tasks[0].subtasks as any[])[0].title).toBe("child");
    expect(board.tasks[0].memberIds).toEqual([memberId]);
  });

  // --------------------------------------------------------- access control

  it("keeps non-members out of a project", async () => {
    const { project } = await newProject("Private", [memberId]);

    await expect(
      asOutsider().fpb.createTask({ projectId: project.id, title: "nope" })
    ).rejects.toThrow(/not on this project/);

    const task = await asMember().fpb.createTask({ projectId: project.id, title: "fine" });
    expect(task.title).toBe("fine");
  });

  it("lets any employee open their own space and pick who is in it", async () => {
    const space = await asMember().fpb.createProject({
      title: "Member's own space",
      projectType: "dev",
      memberIds: [outsiderId],
    });

    // The creator is on it whether or not they listed themselves, and the
    // board is seeded the same way an admin's would be.
    const board = await asMember().fpb.getBoard({ projectId: space.id });
    expect((board.project as any).memberIds.sort()).toEqual([memberId, outsiderId].sort());
    expect(board.columns.length).toBe(5);

    // The person they invited is in, and can work in it.
    const task = await asOutsider().fpb.createTask({ projectId: space.id, title: "invited" });
    expect(task.title).toBe("invited");
  });

  it("shows a space only to the people in it", async () => {
    const mine = await asMember().fpb.createProject({ title: "Mine", projectType: "dev" });
    const theirs = await asOutsider().fpb.createProject({ title: "Theirs", projectType: "dev" });

    const memberSees = (await asMember().fpb.getProjects()).map((p: any) => p.title);
    expect(memberSees).toContain("Mine");
    expect(memberSees).not.toContain("Theirs");

    // Not merely hidden from the list — it cannot be opened by guessing the id.
    await expect(
      asMember().fpb.getBoard({ projectId: theirs.id })
    ).rejects.toThrow(/not on this project/);
    await expect(
      asMember().fpb.getActivity({ projectId: theirs.id })
    ).rejects.toThrow(/not on this project/);

    // An admin still oversees everything.
    const adminSees = (await asAdmin().fpb.getProjects()).map((p: any) => p.title);
    expect(adminSees).toEqual(expect.arrayContaining(["Mine", "Theirs"]));
  });

  it("lets only the space's owner or an admin delete it", async () => {
    const space = await asMember().fpb.createProject({
      title: "Owned", projectType: "dev", memberIds: [outsiderId],
    });

    // Being invited into a space is not licence to destroy it.
    await expect(
      asOutsider().fpb.deleteProject({ id: space.id })
    ).rejects.toThrow(/created this project, or an admin/);

    await asMember().fpb.deleteProject({ id: space.id });
    expect(await FpbProject.findById(space.id).lean()).toBeNull();
  });

  it("gates column edits on the column's own project", async () => {
    const theirs = await asOutsider().fpb.createProject({ title: "Theirs", projectType: "dev" });
    const board = await asOutsider().fpb.getBoard({ projectId: theirs.id });
    const columnId = (board.columns[0] as any).id;

    // The id alone must not be enough — these took no project into account.
    await expect(
      asMember().fpb.updateColumn({ id: columnId, name: "hijacked" })
    ).rejects.toThrow(/not on this project/);
    await expect(
      asMember().fpb.deleteColumn({ id: columnId })
    ).rejects.toThrow(/not on this project/);
    await expect(
      asMember().fpb.reorderColumns([{ id: columnId, position: 3 }])
    ).rejects.toThrow(/not on this project/);
  });

  it("lets a member shape their own project's columns", async () => {
    const { project } = await newProject("Shared", [memberId]);
    // Columns are per project now, so a member can adjust their own workflow.
    const col = await asMember().fpb.createColumn({ projectId: project.id, name: "QA" });
    expect(col.name).toBe("QA");

    const other = await newProject("Not theirs");
    await expect(
      asMember().fpb.createColumn({ projectId: other.project.id, name: "nope" })
    ).rejects.toThrow(/not on this project/);
  });

  // ------------------------------------------------------------ notifications

  it("notifies the assignee when a task is created for them", async () => {
    const { project } = await newProject("Notify", [memberId]);
    await Notification.deleteMany({ userId: memberId });

    await asAdmin().fpb.createTask({
      projectId: project.id, title: "Course Details Api", assignedTo: memberId,
    });

    const hit = (await asMember().notifications.getAll())
      .find((n: any) => n.type === "task_assigned");
    expect(hit).toBeDefined();
    expect((hit as any).message).toContain("Course Details Api");
  });

  it("notifies on reassignment but not on an unrelated edit", async () => {
    const { project } = await newProject("Reassign", [memberId]);
    const task = await asAdmin().fpb.createTask({ projectId: project.id, title: "t" });
    await Notification.deleteMany({ userId: memberId });

    await asAdmin().fpb.updateTask({ id: task.id, assignedTo: memberId });
    expect(await Notification.countDocuments({ userId: memberId, type: "task_assigned" })).toBe(1);

    await asAdmin().fpb.updateTask({ id: task.id, title: "renamed" });
    expect(await Notification.countDocuments({ userId: memberId, type: "task_assigned" })).toBe(1);
  });

  it("notifies only the newly added team members", async () => {
    const { project } = await newProject("Team", [memberId]);
    await Notification.deleteMany({ userId: { $in: [memberId, outsiderId] } });

    await asAdmin().fpb.updateProjectMembers({
      projectId: project.id, memberIds: [adminId, memberId, outsiderId],
    });

    expect(await Notification.countDocuments({ userId: outsiderId, type: "task_assigned" })).toBe(1);
    expect(await Notification.countDocuments({ userId: memberId, type: "task_assigned" })).toBe(0);
  });

  it("never notifies the person who acted", async () => {
    const { project } = await newProject();
    await Notification.deleteMany({ userId: adminId });
    await asAdmin().fpb.createTask({
      projectId: project.id, title: "mine", assignedTo: adminId,
    });
    expect(await Notification.countDocuments({ userId: adminId, type: "task_assigned" })).toBe(0);
  });

  // ------------------------------------------------------------------ misc

  it("records activity for the actions that change a board", async () => {
    const { project, columns } = await newProject("Audited");
    const task = await asAdmin().fpb.createTask({ projectId: project.id, title: "t" });
    await asAdmin().fpb.moveTask({ id: task.id, columnId: columns[1].id, position: 0 });

    const actions = (await asAdmin().fpb.getActivity({ projectId: project.id }))
      .map((a: any) => a.action);
    expect(actions).toContain("created project");
    expect(actions).toContain("added task");
    expect(actions).toContain("moved task");
  });

  it("rejects a malformed id rather than throwing a cast error", async () => {
    await expect(
      asAdmin().fpb.getProject({ id: "not-an-id" })
    ).rejects.toThrow(/Invalid id/);
  });
});
