import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import mongoose from "mongoose";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { Notification, ProjectTask, User } from "./models";
import { describeWithDb } from "./test-utils";

/**
 * Phase 1's core: assigning a legacy project task must tell the assignee. It
 * did not before - the two task-creation procedures wrote the task and stopped.
 *
 *   TEST_MONGODB_URI="mongodb://.../hrms_test" npx vitest run taskNotify.test.ts
 */
describeWithDb("Project task assignment notifies the assignee", () => {
  const stamp = Date.now();
  let adminId: string;
  let alice: string;
  let bob: string;
  const projectId = new mongoose.Types.ObjectId().toString();

  const ctxFor = (id: string, role: string) =>
    ({
      user: { id, role, name: "Actor" },
      req: { protocol: "https", headers: {} },
      res: { cookie: () => {}, clearCookie: () => {} },
    }) as unknown as TrpcContext;
  const caller = (id: string, role: string) => appRouter.createCaller(ctxFor(id, role));

  const taskAssignedFor = (userId: string) =>
    Notification.countDocuments({ userId, type: "task_assigned" });

  beforeAll(async () => {
    await mongoose.connect(process.env.MONGODB_URI as string);
    const [admin, a, b] = await User.create([
      { openId: `tn-adm-${stamp}`, name: "Task Admin", role: "admin", employeeId: `TNADM${stamp}` },
      { openId: `tn-a-${stamp}`, name: "Alice", role: "user", employeeId: `TNA${stamp}`, email: `alice.${stamp}@radflow.local` },
      { openId: `tn-b-${stamp}`, name: "Bob", role: "user", employeeId: `TNB${stamp}`, email: `bob.${stamp}@radflow.local` },
    ]);
    adminId = String(admin._id);
    alice = String(a._id);
    bob = String(b._id);
  });

  afterAll(async () => {
    const ids = [adminId, alice, bob];
    await Notification.deleteMany({ userId: { $in: ids } });
    await ProjectTask.deleteMany({ userId: { $in: ids } });
    await User.deleteMany({ _id: { $in: ids } });
    await mongoose.connection.close();
  });

  beforeEach(async () => {
    await Notification.deleteMany({ userId: { $in: [adminId, alice, bob] } });
    await ProjectTask.deleteMany({ userId: { $in: [adminId, alice, bob] } });
  });

  it("notifies every assignee when an admin creates a task for a project", async () => {
    await caller(adminId, "admin").admin.createTaskForProject({
      projectId,
      title: "Wire up the export",
      assigneeIds: [alice, bob],
    });

    expect(await taskAssignedFor(alice)).toBe(1);
    expect(await taskAssignedFor(bob)).toBe(1);
    // The admin created it and was not an assignee, so gets nothing.
    expect(await taskAssignedFor(adminId)).toBe(0);
  });

  it("writes a message naming the task", async () => {
    await caller(adminId, "admin").admin.createTaskForProject({
      projectId,
      title: "Ship the newsletter",
      assigneeIds: [alice],
    });

    const note = await Notification.findOne({ userId: alice, type: "task_assigned" }).lean();
    expect(note!.message).toContain("Ship the newsletter");
    expect(String(note!.relatedType)).toBe("task");
  });

  it("does not notify the creator when they assign a task to themselves", async () => {
    // projects.createTask with no assignees falls back to the creator; pinging
    // someone about their own action is noise.
    await caller(alice, "user").projects.createTask({
      projectId,
      title: "My own note",
    });

    expect(await taskAssignedFor(alice)).toBe(0);
  });

  it("notifies the others but not the creator when the creator is among the assignees", async () => {
    await caller(alice, "user").projects.createTask({
      projectId,
      title: "Shared task",
      assigneeIds: [alice, bob],
    });

    expect(await taskAssignedFor(alice)).toBe(0);
    expect(await taskAssignedFor(bob)).toBe(1);
  });
});
