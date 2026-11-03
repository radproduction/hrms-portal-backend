/**
 * Data access for the Flow Project Board.
 *
 * The reference build issued a query per card inside a loop to compute member
 * and task counts, which is O(cards) round trips on every board render. Here
 * the list queries batch with $in and join in memory, matching how the admin
 * report helpers in db.ts already work.
 */
import mongoose, { Types } from "mongoose";
import { connectToMongoDB } from "./mongodb";
import { User } from "./models";
import {
  FpbActivity,
  FpbAnnotation,
  FpbAttachment,
  FpbAnnotationComment,
  FpbColumn,
  FpbLabel,
  FpbProject,
  FpbProjectMember,
  FpbSubproject,
  FpbSubtask,
  FpbSubtaskComment,
  FpbTask,
  FpbTaskComment,
  FpbTaskMember,
} from "./fpbModels";
import { completionStamp, planColumnOrder } from "./fpbRules";
import { storageDelete } from "./storage";

async function requireDb() {
  const connected = await connectToMongoDB();
  if (!connected) throw new Error("Database not available");
}

/**
 * Validates an id and hands it back as a string. Mongoose casts strings to
 * ObjectIds on both queries and writes, so constructing one here buys nothing
 * and trips over the ObjectId constructor typings in mongoose 9 / bson 7.
 */
function toObjectId(id: string): string {
  if (!isValidId(id)) throw new Error("Invalid id");
  return id;
}

function isValidId(id: unknown): id is string {
  return typeof id === "string" && mongoose.isValidObjectId(id);
}

function normalizeValue(value: unknown): unknown {
  if (value instanceof Types.ObjectId) return value.toString();
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = normalizeValue(v);
    return out;
  }
  return value;
}

/**
 * Mongo doc -> plain object with a string `id`, matching the rest of the API.
 * The index signature keeps the spread fields visible to callers; without it
 * TypeScript narrows the result to just `{ id }` and every field access fails.
 */
type Normalized = { id: string } & Record<string, unknown>;

function normalize<T extends { _id?: Types.ObjectId }>(
  doc: T | null | undefined
): Normalized | undefined {
  if (!doc) return undefined;
  const raw = typeof (doc as any).toObject === "function" ? (doc as any).toObject() : doc;
  const { _id, __v, ...rest } = raw as any;
  return {
    id: _id ? String(_id) : "",
    ...(normalizeValue(rest) as Record<string, unknown>),
  };
}

const normalizeAll = <T extends { _id?: Types.ObjectId }>(docs: T[]) =>
  docs.map(d => normalize(d)!).filter(Boolean);

export const DEFAULT_COLUMNS = [
  { name: "Backlog", color: "#6b7280", position: 0 },
  { name: "To Do", color: "#3b82f6", position: 1 },
  { name: "In Progress", color: "#f59e0b", position: 2 },
  { name: "In Review", color: "#8b5cf6", position: 3 },
  { name: "Done", color: "#10b981", position: 4 },
];

// The sub-project every project starts with, and the one that existing projects'
// cards were filed under when the sub-project level was introduced.
export const DEFAULT_SUBPROJECT_NAME = "General";

// ==================== Columns ====================

export async function getColumns(projectId: string) {
  await requireDb();
  const columns = await FpbColumn.find({ projectId: toObjectId(projectId) })
    .sort({ position: 1 })
    .lean();
  return normalizeAll(columns);
}

export async function createColumn(projectId: string, name: string, color?: string) {
  await requireDb();
  const count = await FpbColumn.countDocuments({ projectId: toObjectId(projectId) });
  const created = await FpbColumn.create({
    projectId: toObjectId(projectId),
    name,
    color: color ?? "#6366f1",
    position: count,
  });
  return normalize(created)!;
}

export async function updateColumn(id: string, updates: { name?: string; color?: string }) {
  await requireDb();
  const payload: Record<string, unknown> = {};
  if (updates.name !== undefined) payload.name = updates.name;
  if (updates.color !== undefined) payload.color = updates.color;
  const saved = await FpbColumn.findByIdAndUpdate(toObjectId(id), payload, {
    returnDocument: "after",
  }).lean();
  return normalize(saved);
}

/**
 * Deleting a column would orphan its cards, so its tasks move to the column on
 * its left (or the first remaining one). The reference left them pointing at a
 * column that no longer existed, which made them vanish from the board.
 */
export async function deleteColumn(id: string) {
  await requireDb();
  const columnId = toObjectId(id);
  const column = await FpbColumn.findById(columnId).lean();
  if (!column) return { moved: 0, fallbackColumnId: null as string | null };

  const siblings = await FpbColumn.find({
    projectId: column.projectId,
    _id: { $ne: columnId },
  })
    .sort({ position: 1 })
    .lean();

  if (siblings.length === 0) {
    throw new Error("Cannot delete the last column");
  }

  const before = [...siblings].reverse().find(c => c.position < column.position);
  const fallback = before ?? siblings[0];

  const orphans = await FpbTask.countDocuments({ columnId });
  if (orphans > 0) {
    let next = await FpbTask.countDocuments({ columnId: fallback._id });
    const tasks = await FpbTask.find({ columnId }).sort({ position: 1 }).lean();
    await FpbTask.bulkWrite(
      tasks.map(t => ({
        updateOne: {
          filter: { _id: t._id },
          update: { columnId: fallback._id, position: next++ },
        },
      })) as any
    );
  }

  await FpbColumn.deleteOne({ _id: columnId });
  return { moved: orphans, fallbackColumnId: String(fallback._id) };
}

/**
 * The project a column belongs to, so the API can run the same access check on
 * a column mutation that it runs on the project itself. Null when unknown.
 */
export async function getColumnProjectId(id: string) {
  await requireDb();
  const column = await FpbColumn.findById(toObjectId(id), { projectId: 1 }).lean();
  return column ? String(column.projectId) : null;
}

/**
 * Puts a project's columns in the given order.
 *
 * Takes the whole order rather than individual positions: the request must name
 * every column of the project exactly once (see planColumnOrder), so the
 * positions always come out dense, 0..n-1, and a column of another project can
 * never be moved through this project.
 */
export async function reorderColumns(projectId: string, columnIds: string[]) {
  await requireDb();
  const pid = toObjectId(projectId);
  const existing = await FpbColumn.find({ projectId: pid }, { _id: 1 }).lean();
  const writes = planColumnOrder(
    existing.map(c => String(c._id)),
    columnIds
  );
  if (writes.length === 0) return [];
  await FpbColumn.bulkWrite(
    writes.map(w => ({
      updateOne: { filter: { _id: toObjectId(w.id), projectId: pid }, update: { position: w.position } },
    })) as any
  );
  return getColumns(projectId);
}

// ==================== Labels ====================

export async function getLabels(projectId: string) {
  await requireDb();
  const labels = await FpbLabel.find({ projectId: toObjectId(projectId) })
    .sort({ createdAt: 1 })
    .lean();
  return normalizeAll(labels);
}

export async function getLabelProjectId(id: string) {
  await requireDb();
  const label = await FpbLabel.findById(toObjectId(id), { projectId: 1 }).lean();
  return label ? String(label.projectId) : null;
}

export async function createLabel(projectId: string, name: string, color: string) {
  await requireDb();
  const created = await FpbLabel.create({ projectId: toObjectId(projectId), name, color });
  return normalize(created)!;
}

export async function updateLabel(id: string, updates: { name?: string; color?: string }) {
  await requireDb();
  const payload: Record<string, unknown> = {};
  if (updates.name !== undefined) payload.name = updates.name;
  if (updates.color !== undefined) payload.color = updates.color;
  const saved = await FpbLabel.findByIdAndUpdate(toObjectId(id), payload, {
    returnDocument: "after",
  }).lean();
  return normalize(saved);
}

/** Removes a label and takes it off every card that carried it. */
export async function deleteLabel(id: string) {
  await requireDb();
  const labelId = toObjectId(id);
  await FpbTask.updateMany({ labelIds: labelId }, { $pull: { labelIds: labelId } });
  await FpbLabel.deleteOne({ _id: labelId });
}

// ==================== Sub-projects ====================

export async function getSubprojects(projectId: string) {
  await requireDb();
  const subprojects = await FpbSubproject.find({ projectId: toObjectId(projectId) })
    .sort({ position: 1 })
    .lean();
  return normalizeAll(subprojects);
}

/** The project a sub-project belongs to, so the API can run the project's access check on it. */
export async function getSubprojectProjectId(id: string) {
  await requireDb();
  const sp = await FpbSubproject.findById(toObjectId(id), { projectId: 1 }).lean();
  return sp ? String(sp.projectId) : null;
}

export async function createSubproject(input: {
  projectId: string;
  name: string;
  color?: string;
  createdBy: string;
}) {
  await requireDb();
  const projectId = toObjectId(input.projectId);
  const position = await FpbSubproject.countDocuments({ projectId });
  const created = await FpbSubproject.create({
    projectId,
    name: input.name,
    color: input.color ?? "#6366f1",
    position,
    createdBy: toObjectId(input.createdBy),
  });
  return normalize(created)!;
}

export async function updateSubproject(
  id: string,
  updates: { name?: string; color?: string }
) {
  await requireDb();
  const payload: Record<string, unknown> = {};
  if (updates.name !== undefined) payload.name = updates.name;
  if (updates.color !== undefined) payload.color = updates.color;
  const saved = await FpbSubproject.findByIdAndUpdate(toObjectId(id), payload, {
    returnDocument: "after",
  }).lean();
  return normalize(saved);
}

/**
 * Removes a sub-project and every card filed under it. A project must keep at
 * least one sub-project, so the last one cannot be deleted.
 */
export async function deleteSubproject(id: string) {
  await requireDb();
  const subprojectId = toObjectId(id);
  const sp = await FpbSubproject.findById(subprojectId).lean();
  if (!sp) return { deletedTasks: 0 };

  const remaining = await FpbSubproject.countDocuments({
    projectId: sp.projectId,
    _id: { $ne: subprojectId },
  });
  if (remaining === 0) {
    throw new Error("Cannot delete the last sub-project");
  }

  const tasks = await FpbTask.find({ subprojectId }, { _id: 1 }).lean();
  const taskIds = tasks.map(t => t._id);
  const subtasks = await FpbSubtask.find({ taskId: { $in: taskIds } }, { _id: 1 }).lean();
  await Promise.all([
    FpbSubtaskComment.deleteMany({ subtaskId: { $in: subtasks.map(s => s._id) } }),
    FpbSubtask.deleteMany({ taskId: { $in: taskIds } }),
    FpbTaskComment.deleteMany({ taskId: { $in: taskIds } }),
    FpbTaskMember.deleteMany({ taskId: { $in: taskIds } }),
  ]);
  await FpbTask.deleteMany({ subprojectId });
  await FpbSubproject.deleteOne({ _id: subprojectId });
  return { deletedTasks: taskIds.length };
}

/**
 * Returns the first (default) sub-project of a project, creating one if the
 * project has none yet. Callers that must land a card somewhere use this so a
 * project is never left without a sub-project to file work under.
 */
export async function ensureDefaultSubproject(projectId: string, createdBy: string) {
  await requireDb();
  const pid = toObjectId(projectId);
  const existing = await FpbSubproject.findOne({ projectId: pid }).sort({ position: 1 }).lean();
  if (existing) return String(existing._id);
  const created = await FpbSubproject.create({
    projectId: pid,
    name: DEFAULT_SUBPROJECT_NAME,
    color: "#6366f1",
    position: 0,
    createdBy: toObjectId(createdBy),
  });
  return String(created._id);
}

/**
 * One-time (idempotent) backfill for the sub-project level. Ensures every
 * project has at least one sub-project and that every existing card is filed
 * under its project's default sub-project. Safe to run on every boot: once the
 * data is consistent it finds nothing to do and returns quickly.
 */
export async function backfillSubprojects() {
  await requireDb();

  const orphanTasks = await FpbTask.countDocuments({ subprojectId: { $exists: false } });
  const projects = await FpbProject.find({}, { _id: 1, createdBy: 1 }).lean();
  const subprojectCount = await FpbSubproject.countDocuments({});

  // Nothing to do: no orphan cards and at least as many sub-projects as
  // projects (the common steady state after the first run).
  if (orphanTasks === 0 && subprojectCount >= projects.length) {
    return { createdSubprojects: 0, updatedTasks: 0, skipped: true };
  }

  let createdSubprojects = 0;
  let updatedTasks = 0;
  for (const p of projects) {
    let first = await FpbSubproject.findOne({ projectId: p._id }).sort({ position: 1 }).lean();
    if (!first) {
      const created = await FpbSubproject.create({
        projectId: p._id,
        name: DEFAULT_SUBPROJECT_NAME,
        color: "#6366f1",
        position: 0,
        createdBy: p.createdBy,
      });
      first = created.toObject() as any;
      createdSubprojects += 1;
    }
    const res = await FpbTask.updateMany(
      { projectId: p._id, subprojectId: { $exists: false } },
      { $set: { subprojectId: first!._id } }
    );
    updatedTasks += res.modifiedCount ?? 0;
  }
  return { createdSubprojects, updatedTasks, skipped: false };
}

// ==================== Projects ====================

/**
 * The project list, with member and task rollups. Four queries total,
 * regardless of how many projects exist.
 *
 * `visibleTo` scopes the list to one person's spaces — the ones they created
 * plus the ones they were added to. Anyone can create a space now, so without
 * this every employee's private space would show up in everybody's sidebar.
 * Omit it for admins, who see the lot.
 */
export async function getProjects(filters?: {
  projectType?: string;
  status?: string;
  visibleTo?: string;
}) {
  await requireDb();
  const query: Record<string, unknown> = {};
  if (filters?.projectType) query.projectType = filters.projectType;
  if (filters?.status) query.status = filters.status;

  if (filters?.visibleTo) {
    const viewer = toObjectId(filters.visibleTo);
    const memberships = await FpbProjectMember.find({ userId: viewer }, { projectId: 1 }).lean();
    query.$or = [
      { createdBy: viewer },
      { _id: { $in: memberships.map(m => m.projectId) } },
    ];
  }

  const projects = await FpbProject.find(query).sort({ createdAt: -1 }).lean();
  if (projects.length === 0) return [];

  const ids = projects.map(p => p._id);
  const [members, tasks] = await Promise.all([
    FpbProjectMember.find({ projectId: { $in: ids } }).lean(),
    FpbTask.find({ projectId: { $in: ids } }, { projectId: 1, completed: 1 }).lean(),
  ]);

  const membersByProject = new Map<string, string[]>();
  for (const m of members) {
    const key = String(m.projectId);
    const list = membersByProject.get(key);
    if (list) list.push(String(m.userId));
    else membersByProject.set(key, [String(m.userId)]);
  }

  const taskStats = new Map<string, { total: number; done: number }>();
  for (const t of tasks) {
    const key = String(t.projectId);
    const stat = taskStats.get(key) ?? { total: 0, done: 0 };
    stat.total += 1;
    if (t.completed) stat.done += 1;
    taskStats.set(key, stat);
  }

  // Annotated so the spread fields stay visible to callers; without it
  // TypeScript keeps only the explicitly listed keys and drops the rest.
  return projects.map((p): Normalized => {
    const key = String(p._id);
    const memberIds = membersByProject.get(key) ?? [];
    const stat = taskStats.get(key) ?? { total: 0, done: 0 };
    return {
      ...normalize(p)!,
      memberIds,
      memberCount: memberIds.length,
      taskCount: stat.total,
      completedTasks: stat.done,
      progress: stat.total > 0 ? Math.round((stat.done / stat.total) * 100) : 0,
    };
  });
}

export async function getProject(id: string) {
  await requireDb();
  const project = await FpbProject.findById(toObjectId(id)).lean();
  if (!project) return null;
  const members = await FpbProjectMember.find({ projectId: project._id }).lean();
  const result: Normalized = {
    ...normalize(project)!,
    members: normalizeAll(members),
    memberIds: members.map(m => String(m.userId)),
  };
  return result;
}

/** Creates a project and seeds it with its own board columns. */
export async function createProject(input: {
  title: string;
  description?: string;
  projectType: string;
  priority?: string;
  dueDate?: Date;
  createdBy: string;
  memberIds?: string[];
  columns?: { name: string; color: string }[];
}) {
  await requireDb();

  const project = await FpbProject.create({
    title: input.title,
    description: input.description,
    projectType: input.projectType,
    priority: input.priority ?? "medium",
    dueDate: input.dueDate,
    createdBy: toObjectId(input.createdBy),
  });

  const columns = input.columns?.length ? input.columns : DEFAULT_COLUMNS;
  await FpbColumn.insertMany(
    columns.map((c, position) => ({
      projectId: project._id,
      name: c.name,
      color: c.color,
      position,
    }))
  );

  // Every project starts with one sub-project, so the board always has a
  // sub-project to show and cards always have somewhere to live.
  await FpbSubproject.create({
    projectId: project._id,
    name: DEFAULT_SUBPROJECT_NAME,
    color: "#6366f1",
    position: 0,
    createdBy: toObjectId(input.createdBy),
  });

  // The creator is always a member, plus anyone picked in the dialog.
  const memberIds = new Set<string>([input.createdBy, ...(input.memberIds ?? [])]);
  await setProjectMembers(String(project._id), [...memberIds]);

  return normalize(project)!;
}

export async function updateProject(
  id: string,
  updates: Record<string, unknown>
) {
  await requireDb();
  const payload: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(updates)) {
    if (v === undefined) continue;
    payload[k] = k === "columnId" && typeof v === "string" ? toObjectId(v) : v;
  }
  const saved = await FpbProject.findByIdAndUpdate(toObjectId(id), payload, {
    returnDocument: "after",
  }).lean();
  return normalize(saved);
}

/** Removes the card and everything hanging off it. */
export async function deleteProject(id: string) {
  await requireDb();
  const projectId = toObjectId(id);

  const tasks = await FpbTask.find({ projectId }, { _id: 1 }).lean();
  const taskIds = tasks.map(t => t._id);
  const subtasks = await FpbSubtask.find({ taskId: { $in: taskIds } }, { _id: 1 }).lean();
  const annotations = await FpbAnnotation.find({ projectId }, { _id: 1 }).lean();
  await removeAttachmentFiles({ projectId });

  await Promise.all([
    FpbSubtaskComment.deleteMany({ subtaskId: { $in: subtasks.map(s => s._id) } }),
    FpbSubtask.deleteMany({ taskId: { $in: taskIds } }),
    FpbTaskComment.deleteMany({ taskId: { $in: taskIds } }),
    FpbTaskMember.deleteMany({ taskId: { $in: taskIds } }),
    FpbAnnotationComment.deleteMany({ annotationId: { $in: annotations.map(a => a._id) } }),
  ]);
  await Promise.all([
    FpbTask.deleteMany({ projectId }),
    FpbColumn.deleteMany({ projectId }),
    FpbSubproject.deleteMany({ projectId }),
    FpbProjectMember.deleteMany({ projectId }),
    FpbAnnotation.deleteMany({ projectId }),
    FpbActivity.deleteMany({ projectId }),
    FpbLabel.deleteMany({ projectId }),
  ]);
  await FpbProject.deleteOne({ _id: projectId });
}

/**
 * Moves a card and renumbers both affected columns, so positions stay dense.
 * The reference wrote the dropped index straight onto one row, which left
 * duplicate positions and made card order drift after a few moves.
 */
export async function moveTask(id: string, columnId: string, position: number) {
  await requireDb();
  const taskId = toObjectId(id);
  const target = toObjectId(columnId);

  const task = await FpbTask.findById(taskId).lean();
  if (!task) return null;

  const column = await FpbColumn.findById(target).lean();
  // A card can only move between columns of its own project's board.
  if (!column || String(column.projectId) !== String(task.projectId)) {
    throw new Error("Column does not belong to this project");
  }

  // Both ids are compared and written as strings; Mongoose casts on the way in.
  const from = String(task.columnId);
  const sameColumn = from === target;

  type PositionWrite = {
    updateOne: {
      filter: { _id: unknown };
      update: { columnId: string; position: number };
    };
  };

  // Columns are shared across a project's sub-projects, so a column holds cards
  // from several sub-projects. Renumber only within the moved card's own
  // sub-project, or the boards would fight over each other's positions.
  const scope = { subprojectId: task.subprojectId };
  const destination = (await FpbTask.find({ ...scope, columnId: target }).sort({ position: 1 }).lean())
    .filter(t => String(t._id) !== id);

  const clamped = Math.max(0, Math.min(position, destination.length));
  destination.splice(clamped, 0, { ...task, columnId: target } as any);

  const writes: PositionWrite[] = destination.map((t, index) => ({
    updateOne: {
      filter: { _id: t._id },
      update: { columnId: target, position: index },
    },
  }));

  if (!sameColumn) {
    const source = (await FpbTask.find({ ...scope, columnId: from }).sort({ position: 1 }).lean())
      .filter(t => String(t._id) !== id);
    writes.push(
      ...source.map((t, index) => ({
        updateOne: {
          filter: { _id: t._id },
          update: { columnId: from, position: index },
        },
      }))
    );
  }

  if (writes.length > 0) await FpbTask.bulkWrite(writes as any);
  return normalize(await FpbTask.findById(taskId).lean());
}

export async function setProjectMembers(projectId: string, memberIds: string[]) {
  await requireDb();
  const pid = toObjectId(projectId);
  const unique = [...new Set(memberIds)].filter(isValidId);

  await FpbProjectMember.deleteMany({ projectId: pid });
  if (unique.length > 0) {
    await FpbProjectMember.insertMany(
      unique.map(userId => ({ projectId: pid, userId: toObjectId(userId) })),
      { ordered: false }
    );
  }
  return unique;
}

/**
 * Keeps `completed` and `status` in agreement on tasks and subtasks. The
 * reference let them drift, so an item could read "done" while still counting
 * as outstanding on the card, and reopening one left the status at "done".
 *
 * Reopening consults the stored status rather than the payload, because
 * `{ completed: false }` arrives on its own with no status to inspect.
 */
async function syncCompletion(
  payload: Record<string, unknown>,
  loadCurrent: () => Promise<{ status?: string } | null>
) {
  if (payload.status === "done" && payload.completed === undefined) {
    payload.completed = true;
  }
  if (payload.completed === true) {
    if (payload.status === undefined) payload.status = "done";
    payload.progress = 100;
  }
  if (payload.completed === false && payload.status === undefined) {
    const current = await loadCurrent();
    // Only demote something that was actually finished; a "todo" item stays put.
    if (current?.status === "done") payload.status = "in_progress";
  }
}

// ==================== Tasks ====================

export async function getTasks(projectId: string, subprojectId?: string) {
  await requireDb();
  const filter: Record<string, unknown> = { projectId: toObjectId(projectId) };
  // The board asks for one sub-project's cards; other callers still get them all.
  if (subprojectId) filter.subprojectId = toObjectId(subprojectId);
  const tasks = await FpbTask.find(filter)
    .sort({ columnId: 1, position: 1 })
    .lean();
  if (tasks.length === 0) return [];

  const taskIds = tasks.map(t => t._id);
  const [subtasks, members, attachments, commentCounts] = await Promise.all([
    FpbSubtask.find({ taskId: { $in: taskIds } }).sort({ position: 1 }).lean(),
    FpbTaskMember.find({ taskId: { $in: taskIds } }).lean(),
    // How many files a card has, and its newest image for the cover.
    FpbAttachment.find({ taskId: { $in: taskIds } }, { taskId: 1, isImage: 1, createdAt: 1 })
      .sort({ createdAt: 1 })
      .lean(),
    // The card shows how many (live) comments a task has.
    FpbTaskComment.aggregate<{ _id: unknown; n: number }>([
      { $match: { taskId: { $in: taskIds }, deletedAt: { $exists: false } } },
      { $group: { _id: "$taskId", n: { $sum: 1 } } },
    ]),
  ]);
  const commentsByTask = new Map(commentCounts.map(c => [String(c._id), c.n]));
  const filesByTask = new Map<string, { count: number; cover: string | null }>();
  for (const a of attachments) {
    const key = String(a.taskId);
    const entry = filesByTask.get(key) ?? { count: 0, cover: null };
    entry.count += 1;
    if (a.isImage) entry.cover = String(a._id);
    filesByTask.set(key, entry);
  }

  const subtasksByTask = new Map<string, unknown[]>();
  for (const s of subtasks) {
    const key = String(s.taskId);
    const list = subtasksByTask.get(key);
    if (list) list.push(normalize(s)!);
    else subtasksByTask.set(key, [normalize(s)!]);
  }

  const membersByTask = new Map<string, string[]>();
  for (const m of members) {
    const key = String(m.taskId);
    const list = membersByTask.get(key);
    if (list) list.push(String(m.userId));
    else membersByTask.set(key, [String(m.userId)]);
  }

  return tasks.map((t): Normalized => ({
    ...normalize(t)!,
    subtasks: subtasksByTask.get(String(t._id)) ?? [],
    memberIds: membersByTask.get(String(t._id)) ?? [],
    commentCount: commentsByTask.get(String(t._id)) ?? 0,
    attachmentCount: filesByTask.get(String(t._id))?.count ?? 0,
    coverAttachmentId: filesByTask.get(String(t._id))?.cover ?? null,
  }));
}

export async function getTask(id: string) {
  await requireDb();
  const task = await FpbTask.findById(toObjectId(id)).lean();
  if (!task) return null;

  const [subtasks, members, comments, activity, attachments] = await Promise.all([
    FpbSubtask.find({ taskId: task._id }).sort({ position: 1 }).lean(),
    FpbTaskMember.find({ taskId: task._id }).lean(),
    FpbTaskComment.find({ taskId: task._id }).sort({ createdAt: 1 }).lean(),
    // The card's own history, shown alongside its comments.
    FpbActivity.find({ taskId: task._id }).sort({ createdAt: -1 }).limit(50).lean(),
    FpbAttachment.find({ taskId: task._id }, { storageKey: 0 }).sort({ createdAt: 1 }).lean(),
  ]);

  return {
    task: normalize(task)!,
    subtasks: normalizeAll(subtasks),
    members: normalizeAll(members),
    memberIds: members.map(m => String(m.userId)),
    comments: normalizeAll(comments),
    activity: normalizeAll(activity),
    attachments: normalizeAll(attachments),
  };
}

export async function createTask(input: {
  projectId: string;
  subprojectId?: string;
  columnId?: string;
  title: string;
  description?: string;
  priority?: string;
  dueDate?: Date;
  assignedTo?: string;
  createdBy: string;
  memberIds?: string[];
  labelIds?: string[];
}) {
  await requireDb();
  const projectId = toObjectId(input.projectId);
  // File the card under the named sub-project, or the project's default one.
  const subprojectId = toObjectId(
    input.subprojectId ?? (await ensureDefaultSubproject(input.projectId, input.createdBy))
  );

  // Default to the first column, so a card always lands somewhere on the board.
  let columnId = input.columnId;
  if (!columnId) {
    const first = await FpbColumn.findOne({ projectId }).sort({ position: 1 }).lean();
    if (!first) throw new Error("This project has no columns yet");
    columnId = String(first._id);
  }

  // Position runs per (sub-project, column): each sub-project has its own stack
  // of cards in a shared column.
  const position = await FpbTask.countDocuments({
    subprojectId,
    columnId: toObjectId(columnId),
  });

  const task = await FpbTask.create({
    projectId,
    subprojectId,
    columnId: toObjectId(columnId),
    title: input.title,
    description: input.description,
    priority: input.priority ?? "medium",
    dueDate: input.dueDate,
    assignedTo: input.assignedTo ? toObjectId(input.assignedTo) : undefined,
    position,
    createdBy: toObjectId(input.createdBy),
    labelIds: [...new Set(input.labelIds ?? [])].filter(isValidId),
  });

  if (input.memberIds?.length) {
    await setTaskMembers(String(task._id), input.memberIds);
  }
  return normalize(task)!;
}

export async function updateTask(
  id: string,
  updates: Record<string, unknown>,
  actorId?: string
) {
  await requireDb();
  const payload: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(updates)) {
    if (v === undefined) continue;
    if (k === "assignedTo") {
      payload[k] = v === null ? null : toObjectId(v as string);
      continue;
    }
    payload[k] = v;
  }

  const current = await FpbTask.findById(toObjectId(id), {
    status: 1, completed: 1, assignedTo: 1,
  }).lean();
  await syncCompletion(payload, async () => current);

  // Record who finished it and when, for the monthly performance report.
  const unset: Record<string, 1> = {};
  if (current && actorId) {
    const stamp = completionStamp({
      wasCompleted: Boolean(current.completed),
      willBeCompleted: payload.completed as boolean | undefined,
      assigneeAfter:
        payload.assignedTo !== undefined
          ? (payload.assignedTo === null ? null : String(payload.assignedTo))
          : current.assignedTo
            ? String(current.assignedTo)
            : null,
      actorId,
    });
    if (stamp.kind === "set") {
      payload.completedAt = stamp.completedAt;
      payload.completedBy = toObjectId(stamp.completedBy);
    } else if (stamp.kind === "clear") {
      unset.completedAt = 1;
      unset.completedBy = 1;
    }
  }

  const update: Record<string, unknown> = { $set: payload };
  if (Object.keys(unset).length > 0) update.$unset = unset;

  const saved = await FpbTask.findByIdAndUpdate(toObjectId(id), update, {
    returnDocument: "after",
  }).lean();
  return normalize(saved);
}

export async function deleteTask(id: string) {
  await requireDb();
  const taskId = toObjectId(id);
  const subtasks = await FpbSubtask.find({ taskId }, { _id: 1 }).lean();
  await removeAttachmentFiles({ taskId });
  await Promise.all([
    FpbSubtaskComment.deleteMany({ subtaskId: { $in: subtasks.map(s => s._id) } }),
    FpbSubtask.deleteMany({ taskId }),
    FpbTaskComment.deleteMany({ taskId }),
    FpbTaskMember.deleteMany({ taskId }),
  ]);
  await FpbTask.deleteOne({ _id: taskId });
}

export async function setTaskMembers(taskId: string, memberIds: string[]) {
  await requireDb();
  const tid = toObjectId(taskId);
  const unique = [...new Set(memberIds)].filter(isValidId);
  await FpbTaskMember.deleteMany({ taskId: tid });
  if (unique.length > 0) {
    await FpbTaskMember.insertMany(
      unique.map(userId => ({ taskId: tid, userId: toObjectId(userId) })),
      { ordered: false }
    );
  }
  return unique;
}

// ==================== Subtasks ====================

export async function createSubtask(taskId: string, title: string) {
  await requireDb();
  const tid = toObjectId(taskId);
  const position = await FpbSubtask.countDocuments({ taskId: tid });
  const created = await FpbSubtask.create({ taskId: tid, title, position });
  return normalize(created)!;
}

export async function updateSubtask(id: string, updates: Record<string, unknown>) {
  await requireDb();
  const payload: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(updates)) {
    if (v === undefined) continue;
    if (k === "assignedTo") {
      payload[k] = v === null ? null : toObjectId(v as string);
      continue;
    }
    payload[k] = v;
  }
  await syncCompletion(payload, () => FpbSubtask.findById(toObjectId(id), { status: 1 }).lean());

  const saved = await FpbSubtask.findByIdAndUpdate(toObjectId(id), payload, {
    returnDocument: "after",
  }).lean();
  return normalize(saved);
}

export async function getSubtask(id: string) {
  await requireDb();
  const subtask = await FpbSubtask.findById(toObjectId(id)).lean();
  if (!subtask) return null;
  const comments = await FpbSubtaskComment.find({ subtaskId: subtask._id })
    .sort({ createdAt: 1 })
    .lean();
  return { subtask: normalize(subtask)!, comments: normalizeAll(comments) };
}

export async function deleteSubtask(id: string) {
  await requireDb();
  const subtaskId = toObjectId(id);
  await FpbSubtaskComment.deleteMany({ subtaskId });
  await FpbSubtask.deleteOne({ _id: subtaskId });
}

// ==================== Comments ====================

export async function addTaskComment(taskId: string, userId: string, comment: string) {
  await requireDb();
  const created = await FpbTaskComment.create({
    taskId: toObjectId(taskId),
    userId: toObjectId(userId),
    comment,
  });
  return normalize(created)!;
}

export async function getTaskComment(id: string) {
  await requireDb();
  return normalize(await FpbTaskComment.findById(toObjectId(id)).lean());
}

/**
 * Edits a comment. Only its author may, and not once it is deleted. The text it
 * replaces is kept in `edits`, so an edit can never quietly rewrite history.
 * Returns null when the comment is not the caller's (or is gone).
 */
export async function editTaskComment(id: string, userId: string, comment: string) {
  await requireDb();
  const existing = await FpbTaskComment.findOne({
    _id: toObjectId(id),
    userId: toObjectId(userId),
    deletedAt: { $exists: false },
  }).lean();
  if (!existing) return null;
  if (existing.comment === comment) return normalize(existing)!;
  const now = new Date();
  const saved = await FpbTaskComment.findByIdAndUpdate(
    existing._id,
    {
      $set: { comment, editedAt: now },
      $push: { edits: { comment: existing.comment, editedAt: now } },
    },
    { returnDocument: "after" }
  ).lean();
  return normalize(saved);
}

/**
 * Soft-deletes a comment: the thread keeps a "X deleted this comment" line.
 * Whether the actor may do it is decided by the caller (canDeleteComment).
 * Returns false when there was nothing left to delete.
 */
export async function deleteTaskComment(id: string, actorId: string) {
  await requireDb();
  const res = await FpbTaskComment.updateOne(
    { _id: toObjectId(id), deletedAt: { $exists: false } },
    { $set: { deletedAt: new Date(), deletedBy: toObjectId(actorId) } }
  );
  return res.modifiedCount > 0;
}

export async function addSubtaskComment(subtaskId: string, userId: string, comment: string) {
  await requireDb();
  const created = await FpbSubtaskComment.create({
    subtaskId: toObjectId(subtaskId),
    userId: toObjectId(userId),
    comment,
  });
  return normalize(created)!;
}

export async function getSubtaskComment(id: string) {
  await requireDb();
  return normalize(await FpbSubtaskComment.findById(toObjectId(id)).lean());
}

/** Soft delete, as for task comments. */
export async function deleteSubtaskComment(id: string, actorId: string) {
  await requireDb();
  const res = await FpbSubtaskComment.updateOne(
    { _id: toObjectId(id), deletedAt: { $exists: false } },
    { $set: { deletedAt: new Date(), deletedBy: toObjectId(actorId) } }
  );
  return res.modifiedCount > 0;
}

// ==================== Performance ====================

/**
 * The tasks a monthly performance report needs: completed in the period (or,
 * for tasks finished before completion was recorded, last touched in it), and
 * everything still open with an assignee.
 */
export async function getPerformanceTasks(input: { start: Date; end: Date; projectId?: string }) {
  await requireDb();
  const range = { $gte: input.start, $lte: input.end };
  const filter: Record<string, unknown> = {
    $or: [
      { completed: true, completedAt: range },
      { completed: true, completedAt: { $exists: false }, updatedAt: range },
      { completed: false, assignedTo: { $ne: null } },
    ],
  };
  if (input.projectId) filter.projectId = toObjectId(input.projectId);

  const tasks = await FpbTask.find(filter, {
    projectId: 1, title: 1, assignedTo: 1, completed: 1, completedAt: 1, completedBy: 1,
    dueDate: 1, updatedAt: 1,
  }).lean();
  if (tasks.length === 0) return [];

  const projects = await FpbProject.find(
    { _id: { $in: [...new Set(tasks.map(t => String(t.projectId)))] } },
    { title: 1 }
  ).lean();
  const titleOf = new Map(projects.map(p => [String(p._id), p.title]));

  return tasks.map(t => ({
    id: String(t._id),
    projectId: String(t.projectId),
    projectTitle: titleOf.get(String(t.projectId)) ?? "Project",
    title: t.title,
    assignedTo: t.assignedTo ? String(t.assignedTo) : null,
    completed: Boolean(t.completed),
    completedAt: t.completedAt ?? null,
    completedBy: t.completedBy ? String(t.completedBy) : null,
    dueDate: t.dueDate ?? null,
    updatedAt: (t as any).updatedAt ?? null,
  }));
}

/** Name, position and department of the given people (all people when omitted). */
export async function getPeopleForMetrics(userIds?: string[]) {
  await requireDb();
  const filter = userIds ? { _id: { $in: userIds.filter(isValidId) } } : {};
  const users = await User.find(filter, { name: 1, employeeId: 1, position: 1, departmentId: 1, role: 1 }).lean();
  return users.map(u => ({
    id: String(u._id),
    name: u.name || u.employeeId || "Employee",
    position: u.position ?? "",
    departmentId: u.departmentId ? String(u.departmentId) : null,
  }));
}

/** Everyone in the given departments. */
export async function getPeopleInDepartments(departmentIds: string[]) {
  await requireDb();
  const users = await User.find(
    { departmentId: { $in: departmentIds.filter(isValidId) } },
    { _id: 1 }
  ).lean();
  return users.map(u => String(u._id));
}

// ==================== Attachments ====================

export async function createAttachment(input: {
  projectId: string;
  taskId: string;
  fileName: string;
  mimeType: string;
  size: number;
  storageKey: string;
  isImage: boolean;
  uploadedBy: string;
}) {
  await requireDb();
  const created = await FpbAttachment.create({
    ...input,
    projectId: toObjectId(input.projectId),
    taskId: toObjectId(input.taskId),
    uploadedBy: toObjectId(input.uploadedBy),
  });
  const { storageKey: _key, ...rest } = normalize(created)!;
  return rest;
}

/** The full record, storage key included, for serving or deleting the file. */
export async function getAttachment(id: string) {
  await requireDb();
  return normalize(await FpbAttachment.findById(toObjectId(id)).lean());
}

export async function deleteAttachment(id: string) {
  await requireDb();
  const found = await FpbAttachment.findById(toObjectId(id)).lean();
  if (!found) return false;
  await storageDelete(found.storageKey).catch(error =>
    console.error("[FPB] could not remove attachment file", error instanceof Error ? error.name : "unknown")
  );
  await FpbAttachment.deleteOne({ _id: found._id });
  return true;
}

/** Removes the files (and records) of a task's or a project's attachments. */
async function removeAttachmentFiles(filter: { taskId?: unknown; projectId?: unknown }) {
  const files = await FpbAttachment.find(filter as any, { storageKey: 1 }).lean();
  for (const f of files) {
    await storageDelete(f.storageKey).catch(() => false);
  }
  if (files.length > 0) await FpbAttachment.deleteMany(filter as any);
}

// ==================== Annotations ====================

export async function getAnnotations(projectId: string) {
  await requireDb();
  const annotations = await FpbAnnotation.find({ projectId: toObjectId(projectId) })
    .sort({ createdAt: -1 })
    .lean();
  if (annotations.length === 0) return [];

  const comments = await FpbAnnotationComment.find({
    annotationId: { $in: annotations.map(a => a._id) },
  })
    .sort({ createdAt: 1 })
    .lean();

  const byAnnotation = new Map<string, unknown[]>();
  for (const c of comments) {
    const key = String(c.annotationId);
    const list = byAnnotation.get(key);
    if (list) list.push(normalize(c)!);
    else byAnnotation.set(key, [normalize(c)!]);
  }

  return annotations.map(a => ({
    ...normalize(a)!,
    comments: byAnnotation.get(String(a._id)) ?? [],
  }));
}

export async function createAnnotation(input: {
  projectId: string;
  fileName: string;
  fileUrl: string;
  uploadedBy: string;
}) {
  await requireDb();
  const created = await FpbAnnotation.create({
    projectId: toObjectId(input.projectId),
    fileName: input.fileName,
    fileUrl: input.fileUrl,
    uploadedBy: toObjectId(input.uploadedBy),
  });
  return normalize(created)!;
}

export async function addAnnotationComment(input: {
  annotationId: string;
  userId: string;
  comment: string;
  posX: number;
  posY: number;
}) {
  await requireDb();
  const created = await FpbAnnotationComment.create({
    annotationId: toObjectId(input.annotationId),
    userId: toObjectId(input.userId),
    comment: input.comment,
    posX: input.posX,
    posY: input.posY,
  });
  return normalize(created)!;
}

/** The project an annotation belongs to, for the same reason as columns. */
export async function getAnnotationProjectId(id: string) {
  await requireDb();
  const annotation = await FpbAnnotation.findById(toObjectId(id), { projectId: 1 }).lean();
  return annotation ? String(annotation.projectId) : null;
}

export async function getAnnotationCommentProjectId(id: string) {
  await requireDb();
  const comment = await FpbAnnotationComment.findById(toObjectId(id), { annotationId: 1 }).lean();
  if (!comment) return null;
  return getAnnotationProjectId(String(comment.annotationId));
}

export async function resolveAnnotationComment(id: string, resolved: boolean) {
  await requireDb();
  const saved = await FpbAnnotationComment.findByIdAndUpdate(
    toObjectId(id),
    { resolved },
    { returnDocument: "after" }
  ).lean();
  return normalize(saved);
}

export async function deleteAnnotation(id: string) {
  await requireDb();
  const annotationId = toObjectId(id);
  await FpbAnnotationComment.deleteMany({ annotationId });
  await FpbAnnotation.deleteOne({ _id: annotationId });
}

// ==================== Activity ====================

export async function logActivity(
  projectId: string,
  userId: string,
  action: string,
  detail?: string,
  taskId?: string
) {
  // Never let an audit write break the action it is recording.
  try {
    await FpbActivity.create({
      projectId: toObjectId(projectId),
      taskId: taskId && isValidId(taskId) ? taskId : undefined,
      userId: toObjectId(userId),
      action,
      detail,
    });
  } catch (error) {
    console.error("[FPB] failed to log activity", action, error);
  }
}

export async function getActivity(projectId: string, limit: number) {
  await requireDb();
  const items = await FpbActivity.find({ projectId: toObjectId(projectId) })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
  if (items.length === 0) return [];

  const users = await User.find(
    { _id: { $in: [...new Set(items.map(i => String(i.userId)))].map(toObjectId) } },
    { name: 1, employeeId: 1, avatar: 1 }
  ).lean();
  const byId = new Map(users.map(u => [String(u._id), u]));

  return items.map(i => {
    const u = byId.get(String(i.userId));
    return {
      ...normalize(i)!,
      userName: u?.name ?? u?.employeeId ?? "Someone",
      userAvatar: u?.avatar ?? null,
    };
  });
}

// ==================== Users for member pickers ====================

export async function getBoardUsers() {
  await requireDb();
  const users = await User.find({}, {
    name: 1,
    employeeId: 1,
    department: 1,
    position: 1,
    avatar: 1,
    role: 1,
  })
    .sort({ name: 1 })
    .lean();

  return users.map(u => ({
    id: String(u._id),
    name: u.name ?? "",
    employeeId: u.employeeId ?? "",
    department: u.department ?? "",
    // The reference called this "designation"; this schema calls it position.
    designation: u.position ?? "",
    avatar: u.avatar ?? null,
    role: u.role,
  }));
}
