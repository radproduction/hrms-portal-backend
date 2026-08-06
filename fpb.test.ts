import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import mongoose from "mongoose";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { User } from "./models";
import {
  FpbActivity,
  FpbAnnotation,
  FpbBoard,
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
 * Covers the board mechanics and the three behaviours that differ from the
 * Manus reference: dense card positions after a move, cards being rehomed when
 * a column is deleted, and completed/status staying in agreement.
 *
 * Needs a throwaway database:
 *   TEST_MONGODB_URI="mongodb://.../hrms_test" npm test
 */
describeWithDb("Flow Project Board", () => {
  let adminId: string;
  let memberId: string;
  let outsiderId: string;
  let columns: any[] = [];

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
    const projects = await FpbProject.find({}, { _id: 1 }).lean();
    const projectIds = projects.map(p => p._id);
    const tasks = await FpbTask.find({}, { _id: 1 }).lean();
    await Promise.all([
      FpbSubtask.deleteMany({ taskId: { $in: tasks.map(t => t._id) } }),
      FpbTaskComment.deleteMany({}),
      FpbTaskMember.deleteMany({}),
      FpbTask.deleteMany({}),
      FpbProjectMember.deleteMany({ projectId: { $in: projectIds } }),
      FpbActivity.deleteMany({}),
      FpbAnnotation.deleteMany({}),
    ]);
    await Promise.all([
      FpbProject.deleteMany({}),
      FpbColumn.deleteMany({}),
      FpbBoard.deleteMany({}),
      User.deleteMany({ _id: { $in: ids } }),
    ]);
    await mongoose.connection.close();
  });

  beforeEach(async () => {
    // Clean slate for cards between tests; the board and columns are reused.
    await Promise.all([
      FpbProject.deleteMany({}),
      FpbProjectMember.deleteMany({}),
      FpbTask.deleteMany({}),
      FpbTaskMember.deleteMany({}),
    ]);
    const board = await asAdmin().fpb.getBoard();
    columns = board.columns;
  });

  const newProject = (title: string, columnIndex = 0, memberIds: string[] = []) =>
    asAdmin().fpb.createProject({
      columnId: columns[columnIndex].id,
      title,
      projectType: "dev",
      memberIds,
    });

  // ---------------------------------------------------------------- board

  it("seeds a board with the five default columns", async () => {
    const { board, columns: cols } = await asAdmin().fpb.getBoard();
    expect(board.name).toBe("Flow Project Board");
    expect(cols.map((c: any) => c.name)).toEqual([
      "Backlog", "To Do", "In Progress", "In Review", "Done",
    ]);
    expect(cols.map((c: any) => c.position)).toEqual([0, 1, 2, 3, 4]);
  });

  it("returns the same board on a second call rather than seeding again", async () => {
    const first = await asAdmin().fpb.getBoard();
    const second = await asMember().fpb.getBoard();
    expect(second.board.id).toBe(first.board.id);
    expect(second.columns).toHaveLength(first.columns.length);
  });

  it("only lets an admin add or delete columns", async () => {
    await expect(
      asMember().fpb.createColumn({ name: "Sneaky" })
    ).rejects.toThrow(/Admin access required/);
    await expect(
      asMember().fpb.deleteColumn({ id: columns[0].id })
    ).rejects.toThrow(/Admin access required/);
  });

  // ---------------------------------------------------------------- cards

  it("creates a card and puts the creator plus picked members on it", async () => {
    const project = await newProject("Website revamp", 1, [memberId]);
    expect(project.title).toBe("Website revamp");

    const full = await asAdmin().fpb.getProject({ id: project.id });
    expect((full.memberIds as string[]).sort()).toEqual([adminId, memberId].sort());
  });

  it("rolls up task progress onto the card", async () => {
    const project = await newProject("With tasks");
    const a = await asAdmin().fpb.createTask({ projectId: project.id, title: "one" });
    await asAdmin().fpb.createTask({ projectId: project.id, title: "two" });
    await asAdmin().fpb.updateTask({ id: a.id, completed: true });

    const [card] = (await asAdmin().fpb.getProjects()).filter((p: any) => p.id === project.id);
    expect(card.taskCount).toBe(2);
    expect(card.completedTasks).toBe(1);
    expect(card.progress).toBe(50);
  });

  it("filters cards by project type", async () => {
    await newProject("A dev one");
    await asAdmin().fpb.createProject({
      columnId: columns[0].id, title: "An accounting one", projectType: "accounting",
    });

    const dev = await asAdmin().fpb.getProjects({ projectType: "dev" });
    expect(dev.map((p: any) => p.title)).toEqual(["A dev one"]);
  });

  // ------------------------------------------------------------ moving

  it("keeps positions dense and unique after a move between columns", async () => {
    const a = await newProject("A", 0);
    const b = await newProject("B", 0);
    const c = await newProject("C", 0);

    // Drop B at the top of column 1.
    await asAdmin().fpb.moveProject({ id: b.id, columnId: columns[1].id, position: 0 });

    const all = await asAdmin().fpb.getProjects();
    const source = all.filter((p: any) => p.columnId === columns[0].id)
      .sort((x: any, y: any) => x.position - y.position);
    const dest = all.filter((p: any) => p.columnId === columns[1].id);

    expect(source.map((p: any) => p.title)).toEqual(["A", "C"]);
    // The gap B left behind is closed, not left as 0,2.
    expect(source.map((p: any) => p.position)).toEqual([0, 1]);
    expect(dest.map((p: any) => p.title)).toEqual(["B"]);
    expect(dest[0].position).toBe(0);
    expect([a.id, c.id]).toHaveLength(2);
  });

  it("reorders correctly when moving within one column", async () => {
    await newProject("A", 0);
    await newProject("B", 0);
    const c = await newProject("C", 0);

    // Pull C to the front.
    await asAdmin().fpb.moveProject({ id: c.id, columnId: columns[0].id, position: 0 });

    const ordered = (await asAdmin().fpb.getProjects())
      .filter((p: any) => p.columnId === columns[0].id)
      .sort((x: any, y: any) => x.position - y.position);

    expect(ordered.map((p: any) => p.title)).toEqual(["C", "A", "B"]);
    expect(ordered.map((p: any) => p.position)).toEqual([0, 1, 2]);
  });

  it("clamps an out-of-range drop index instead of leaving a hole", async () => {
    await newProject("A", 0);
    const b = await newProject("B", 0);

    await asAdmin().fpb.moveProject({ id: b.id, columnId: columns[1].id, position: 99 });

    const dest = (await asAdmin().fpb.getProjects())
      .filter((p: any) => p.columnId === columns[1].id);
    expect(dest[0].position).toBe(0);
  });

  // ------------------------------------------------------ column deletion

  it("rehomes cards to the previous column when a column is deleted", async () => {
    const project = await newProject("Needs a home", 2);

    const result = await asAdmin().fpb.deleteColumn({ id: columns[2].id });
    expect(result.moved).toBe(1);

    const all = await asAdmin().fpb.getProjects();
    const moved = all.find((p: any) => p.id === project.id);
    // Still on the board rather than pointing at a column that no longer exists.
    expect(moved).toBeDefined();
    expect(moved!.columnId).toBe(columns[1].id);

    // Put the column back for the remaining tests.
    await asAdmin().fpb.createColumn({ name: "In Progress", color: "#f59e0b" });
  });

  it("refuses to delete the last remaining column", async () => {
    const { columns: cols } = await asAdmin().fpb.getBoard();
    for (const col of cols.slice(1)) {
      await asAdmin().fpb.deleteColumn({ id: col.id });
    }
    await expect(
      asAdmin().fpb.deleteColumn({ id: cols[0].id })
    ).rejects.toThrow(/Cannot delete the last column/);

    for (const c of ["To Do", "In Progress", "In Review", "Done"]) {
      await asAdmin().fpb.createColumn({ name: c });
    }
  });

  // ------------------------------------------------------------- tasks

  it("keeps completed and status in agreement", async () => {
    const project = await newProject("Sync check");
    const task = await asAdmin().fpb.createTask({ projectId: project.id, title: "t" });

    const done = await asAdmin().fpb.updateTask({ id: task.id, completed: true });
    expect(done!.status).toBe("done");
    expect(done!.progress).toBe(100);

    const reopened = await asAdmin().fpb.updateTask({ id: task.id, completed: false });
    expect(reopened!.status).not.toBe("done");
    expect(reopened!.completed).toBe(false);

    const viaStatus = await asAdmin().fpb.updateTask({ id: task.id, status: "done" });
    expect(viaStatus!.completed).toBe(true);
  });

  it("leaves an unfinished task's status alone when completed is set false", async () => {
    const project = await newProject("Still todo");
    const task = await asAdmin().fpb.createTask({ projectId: project.id, title: "t" });

    const saved = await asAdmin().fpb.updateTask({ id: task.id, completed: false });
    // Nothing to demote, so it stays where it was rather than jumping forward.
    expect(saved!.status).toBe("todo");
  });

  it("carries subtasks and members on the task list", async () => {
    const project = await newProject("Deep", 0, [memberId]);
    const task = await asAdmin().fpb.createTask({
      projectId: project.id, title: "parent", memberIds: [memberId],
    });
    await asAdmin().fpb.createSubtask({ taskId: task.id, title: "child" });

    const [loaded] = await asAdmin().fpb.getTasks({ projectId: project.id });
    expect(loaded.subtasks).toHaveLength(1);
    expect((loaded.subtasks as any[])[0].title).toBe("child");
    expect(loaded.memberIds).toEqual([memberId]);
  });

  it("removes subtasks and comments with the task", async () => {
    const project = await newProject("Cascade");
    const task = await asAdmin().fpb.createTask({ projectId: project.id, title: "doomed" });
    await asAdmin().fpb.createSubtask({ taskId: task.id, title: "child" });
    await asAdmin().fpb.addTaskComment({ taskId: task.id, comment: "hi" });

    await asAdmin().fpb.deleteTask({ id: task.id });

    expect(await FpbSubtask.countDocuments({ taskId: task.id })).toBe(0);
    expect(await FpbTaskComment.countDocuments({ taskId: task.id })).toBe(0);
  });

  it("removes everything belonging to a deleted card", async () => {
    const project = await newProject("Doomed");
    const task = await asAdmin().fpb.createTask({ projectId: project.id, title: "t" });
    await asAdmin().fpb.createSubtask({ taskId: task.id, title: "s" });

    await asAdmin().fpb.deleteProject({ id: project.id });

    expect(await FpbTask.countDocuments({ projectId: project.id })).toBe(0);
    expect(await FpbProjectMember.countDocuments({ projectId: project.id })).toBe(0);
    expect(await FpbSubtask.countDocuments({ taskId: task.id })).toBe(0);
  });

  // --------------------------------------------------------- access control

  it("keeps non-members out of a project", async () => {
    const project = await newProject("Private", 0, [memberId]);

    await expect(
      asOutsider().fpb.createTask({ projectId: project.id, title: "nope" })
    ).rejects.toThrow(/not on this project/);

    // A member on the project can.
    const task = await asMember().fpb.createTask({ projectId: project.id, title: "fine" });
    expect(task.title).toBe("fine");
  });

  it("only lets an admin delete a card", async () => {
    const project = await newProject("Guarded", 0, [memberId]);
    await expect(
      asMember().fpb.deleteProject({ id: project.id })
    ).rejects.toThrow(/Admin access required/);
  });

  it("only lets the author delete their own comment", async () => {
    const project = await newProject("Comments", 0, [memberId]);
    const task = await asAdmin().fpb.createTask({ projectId: project.id, title: "t" });
    const comment = await asMember().fpb.addTaskComment({ taskId: task.id, comment: "mine" });

    await expect(
      asAdmin().fpb.deleteTaskComment({ id: comment.id })
    ).rejects.toThrow(/only delete your own/);

    await expect(asMember().fpb.deleteTaskComment({ id: comment.id })).resolves.toEqual({
      success: true,
    });
  });

  it("records activity for the actions that change a card", async () => {
    const project = await newProject("Audited");
    await asAdmin().fpb.moveProject({ id: project.id, columnId: columns[1].id, position: 0 });

    const activity = await asAdmin().fpb.getActivity({ projectId: project.id });
    const actions = activity.map((a: any) => a.action);
    expect(actions).toContain("created project");
    expect(actions).toContain("moved project");
    expect(activity[0].userName).toBe("Board Admin");
  });

  it("rejects a malformed id rather than throwing a cast error", async () => {
    await expect(
      asAdmin().fpb.getProject({ id: "not-an-id" })
    ).rejects.toThrow(/Invalid id/);
  });
});
