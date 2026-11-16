/**
 * One-time, additive move of an older tenant's data onto the current portal.
 *
 * skntheory and movement ran the August code. Two things there do not show up
 * in the current portal on their own:
 *
 *  1. Departments were free text on each person ("Doctors", "Factory Team").
 *     The portal now works off Department records (heads, the department
 *     board, leave and request routing). This creates one record per text and
 *     links the people who carry that text and have no department yet.
 *
 *  2. The old project system (projects / projectassignments / projecttasks)
 *     was removed. This copies each old project onto the Work board, with its
 *     people and its tasks in the column matching their status.
 *
 * Nothing is deleted or overwritten. The old collections are only read and
 * stay exactly as they are; each person's department text stays as it is;
 * a department link is only added where there was none. Every copied project
 * is recorded in `legacymigrations`, so running this twice does not copy twice.
 *
 * It only looks by default. Nothing is written without --apply.
 *
 *   cd /srv/tenants/<tenant>/backend
 *   npx esbuild deploy/tenants/migrate-tenant.ts --bundle --platform=node \
 *     --packages=external --format=esm --outfile=dist/migrate-tenant.mjs
 *   sudo -u hrms node dist/migrate-tenant.mjs            # look only
 *   sudo -u hrms node dist/migrate-tenant.mjs --apply    # write
 */
import { readFileSync } from "node:fs";
import mongoose, { Types } from "mongoose";
import { Department, User } from "../../models";
import {
  FpbColumn,
  FpbProject,
  FpbProjectMember,
  FpbSubproject,
  FpbTask,
  FpbTaskMember,
} from "../../fpbModels";
import { planLegacyTask, projectStatusFor, priorityFor, BOARD_COLUMNS } from "./migrateRules";

// The tenant's settings, read the way systemd does: KEY=value per line.
for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
  if (match && process.env[match[1]] === undefined) {
    process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
}
const APPLY = process.argv.includes("--apply");

const say = (line: string) => console.log(line);
const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function departments() {
  say("\n== Departments (from each person's department text)");
  const texts = Array.from(
    new Set(((await User.distinct("department")) as unknown[]).map(t => String(t ?? "").trim()).filter(Boolean))
  );
  if (texts.length === 0) return say("  No department texts. Nothing to do.");

  for (const text of texts) {
    const sameName = new RegExp(`^\\s*${escapeRegex(text)}\\s*$`, "i");
    let department = await Department.findOne({ name: sameName });
    const people = await User.find(
      { department: sameName, departmentId: { $exists: false } },
      { _id: 1, name: 1 }
    ).lean();

    say(
      `  "${text}": ${department ? "department already exists" : "will create the department"}, ` +
        `link ${people.length} ${people.length === 1 ? "person" : "people"} with no department yet`
    );
    if (!APPLY) continue;

    if (!department) department = await Department.create({ name: text });
    if (people.length > 0) {
      await User.updateMany(
        { _id: { $in: people.map(p => p._id) }, departmentId: { $exists: false } },
        { $set: { departmentId: department._id } }
      );
    }
  }
}

async function legacyProjects() {
  say("\n== Old projects (copied onto the Work board)");
  const db = mongoose.connection.db!;
  const done = db.collection("legacymigrations");
  const projects = await db.collection("projects").find({}).sort({ createdAt: 1 }).toArray();
  if (projects.length === 0) return say("  No old projects. Nothing to do.");

  const userIds = new Set((await User.find({}, { _id: 1 }).lean()).map(u => String(u._id)));
  const known = (id: unknown) => (id && userIds.has(String(id)) ? String(id) : null);

  for (const old of projects) {
    if (await done.findOne({ kind: "project", legacyId: old._id })) {
      say(`  "${old.name}": already copied earlier, skipped`);
      continue;
    }
    const creator = known(old.createdBy);
    if (!creator) {
      say(`  "${old.name}": skipped, the person who created it no longer exists`);
      continue;
    }
    const assignments = await db.collection("projectassignments").find({ projectId: old._id }).toArray();
    const members = Array.from(
      new Set([creator, ...assignments.map(a => known(a.userId)).filter((id): id is string => Boolean(id))])
    );
    const tasks = await db.collection("projecttasks").find({ projectId: old._id }).sort({ createdAt: 1 }).toArray();

    say(
      `  "${old.name}": ${members.length} ${members.length === 1 ? "member" : "members"}, ` +
        `${tasks.length} ${tasks.length === 1 ? "task" : "tasks"} (${old.status ?? "active"})`
    );
    for (const task of tasks) {
      const plan = planLegacyTask(task as any, known);
      say(`      - "${task.title}" → ${plan.column}${plan.assignedTo ? "" : ", nobody assigned"}`);
    }
    if (!APPLY) continue;

    const project = await FpbProject.create({
      title: String(old.name ?? "Untitled project"),
      description: old.description,
      projectType: "other",
      scopes: [],
      priority: priorityFor(old.priority),
      status: projectStatusFor(old.status),
      startDate: old.startDate,
      dueDate: old.endDate,
      createdBy: new Types.ObjectId(creator),
    });
    const columns = await FpbColumn.insertMany(
      BOARD_COLUMNS.map((column, position) => ({ projectId: project._id, name: column.name, color: column.color, position }))
    );
    const columnId = new Map(columns.map(c => [c.name, c._id]));
    const sub = await FpbSubproject.create({
      projectId: project._id,
      name: "General",
      color: "#6366f1",
      position: 0,
      createdBy: new Types.ObjectId(creator),
    });
    await FpbProjectMember.insertMany(
      members.map(userId => ({ projectId: project._id, userId: new Types.ObjectId(userId) }))
    );

    const positions = new Map<string, number>();
    for (const task of tasks) {
      const plan = planLegacyTask(task as any, known);
      const position = positions.get(plan.column) ?? 0;
      positions.set(plan.column, position + 1);
      const saved = await FpbTask.create({
        projectId: project._id,
        subprojectId: sub._id,
        columnId: columnId.get(plan.column),
        title: String(task.title ?? "Untitled task"),
        description: task.description,
        status: plan.status,
        completed: plan.completed,
        progress: plan.completed ? 100 : 0,
        priority: priorityFor(task.priority),
        dueDate: task.completionDate,
        position,
        assignedTo: plan.assignedTo ? new Types.ObjectId(plan.assignedTo) : undefined,
        createdBy: new Types.ObjectId(plan.createdBy ?? creator),
        completedAt: plan.completed ? task.completedAt ?? task.updatedAt : undefined,
        completedBy: plan.completed && plan.assignedTo ? new Types.ObjectId(plan.assignedTo) : undefined,
      });
      if (plan.memberIds.length > 0) {
        await FpbTaskMember.insertMany(
          plan.memberIds.map(userId => ({ taskId: saved._id, userId: new Types.ObjectId(userId) }))
        );
      }
    }
    await done.insertOne({
      kind: "project",
      legacyId: old._id,
      newProjectId: project._id,
      tasks: tasks.length,
      copiedAt: new Date(),
    });
  }
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set. Run this from the tenant's backend folder.");
  await mongoose.connect(uri);
  say(`Database: ${mongoose.connection.db!.databaseName}`);
  say(APPLY ? "Mode: WRITING (--apply)" : "Mode: looking only. Nothing is written. Add --apply to write.");

  await departments();
  await legacyProjects();

  say(APPLY ? "\nDone." : "\nNothing was written. If this looks right, run it again with --apply.");
  await mongoose.disconnect();
}

main().catch(async error => {
  console.error("Migration stopped:", error?.message ?? error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
