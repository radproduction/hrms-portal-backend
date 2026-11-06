/**
 * Pure rules for the Flow Project Board.
 *
 * Kept free of Mongo and tRPC so the decisions can be unit tested without a
 * database (see fpbRules.test.ts). fpbDb.ts and fpbRouter.ts call these.
 */

// ==================== Columns ====================

/**
 * Validates a requested column order against the project's real columns and
 * returns the position writes.
 *
 * The request must name every column of the project exactly once. Anything
 * else — a missing column, a duplicate, or a column from another project — is
 * refused, so a stale or forged request can never leave two columns on the
 * same position or move another project's column.
 */
export function planColumnOrder(
  existingIds: string[],
  requestedIds: string[]
): { id: string; position: number }[] {
  const existing = new Set(existingIds);
  const requested = new Set(requestedIds);
  if (requested.size !== requestedIds.length) {
    throw new Error("A column appears twice in the new order");
  }
  if (requested.size !== existing.size || requestedIds.some(id => !existing.has(id))) {
    throw new Error("The new order must list every column of this project exactly once");
  }
  return requestedIds.map((id, position) => ({ id, position }));
}

// ==================== Task completion ====================

export type CompletionStamp =
  | { kind: "set"; completedAt: Date; completedBy: string }
  | { kind: "clear" }
  | { kind: "none" };

/**
 * Who gets the credit for a finished task, and when.
 *
 * Monthly performance counts tasks per employee, so the credit goes to the
 * person the task is assigned to at the moment it is completed — not to
 * whoever happened to tick the box (a lead closing a card for their team).
 * With nobody assigned, the person who completed it gets the credit.
 *
 * Reopening a task clears the stamp, so a task completed, reopened and
 * completed again in a later month counts in the later month only.
 */
export function completionStamp(input: {
  wasCompleted: boolean;
  willBeCompleted: boolean | undefined;
  assigneeAfter: string | null | undefined;
  actorId: string;
  now?: Date;
}): CompletionStamp {
  if (input.willBeCompleted === undefined || input.willBeCompleted === input.wasCompleted) {
    return { kind: "none" };
  }
  if (!input.willBeCompleted) return { kind: "clear" };
  return {
    kind: "set",
    completedAt: input.now ?? new Date(),
    completedBy: input.assigneeAfter || input.actorId,
  };
}

// ==================== Comments ====================

export type CommentRecord = {
  id: string;
  userId: string;
  comment: string;
  deletedAt?: Date | string | null;
  deletedBy?: string | null;
  editedAt?: Date | string | null;
  edits?: { comment: string; editedAt: Date | string }[];
  [key: string]: unknown;
};

/**
 * What a viewer is shown of a comment.
 *
 * A deleted comment stays in the thread as "X deleted this comment" for
 * everyone. Its text, and the earlier versions of edited comments, are kept
 * for org-wide roles only (admin / head of ops), who may need them to settle a
 * dispute; everybody else gets them stripped on the server, not just hidden in
 * the page.
 */
export function presentComment(c: CommentRecord, viewerIsOrgWide: boolean): CommentRecord {
  const deleted = Boolean(c.deletedAt);
  if (viewerIsOrgWide) return { ...c, isDeleted: deleted };
  const { edits: _edits, ...rest } = c;
  if (!deleted) return { ...rest, isDeleted: false };
  return { ...rest, comment: "", isDeleted: true };
}

/** Whether `actor` may delete `comment`: its author, or an org-wide role moderating. */
export function canDeleteComment(
  comment: { userId: string },
  actor: { id: string; isOrgWide: boolean }
): boolean {
  return comment.userId === actor.id || actor.isOrgWide;
}

// ==================== Uploads ====================

/**
 * Image types the annotation upload accepts, keyed by MIME type, with the
 * extension the stored file gets and the leading bytes that identify it.
 *
 * The extension used to be derived from the client-supplied MIME type, so
 * "image/html" produced a .html file served from the portal's own origin —
 * a stored XSS. Now only these four can be stored, and the bytes must agree.
 */
const IMAGE_TYPES: Record<string, { ext: string; magic: (b: Buffer) => boolean }> = {
  "image/png": {
    ext: "png",
    magic: b => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  "image/jpeg": {
    ext: "jpg",
    magic: b => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  "image/gif": {
    ext: "gif",
    magic: b => b.length > 6 && (b.subarray(0, 6).toString("ascii") === "GIF87a" || b.subarray(0, 6).toString("ascii") === "GIF89a"),
  },
  "image/webp": {
    ext: "webp",
    magic: b => b.length > 12 && b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP",
  },
};

/** The safe extension for an uploaded image, or null when it is not one we accept. */
export function safeImageExtension(mimeType: string, data: Buffer): string | null {
  const type = IMAGE_TYPES[mimeType.trim().toLowerCase()];
  if (!type) return null;
  return type.magic(data) ? type.ext : null;
}

// ==================== Notifications ====================

/** Where a board notification should take the person who clicks it. */
export function boardLink(projectId: string, taskId?: string | null): string {
  const params = new URLSearchParams({ project: projectId });
  if (taskId) params.set("task", taskId);
  return `/board?${params.toString()}`;
}

/** Everyone who should hear about activity on a task, minus the person acting. */
export function taskAudience(
  task: { assignedTo?: string | null; createdBy?: string | null; memberIds?: string[] },
  actorId: string
): string[] {
  const ids = [task.assignedTo, task.createdBy, ...(task.memberIds ?? [])]
    .filter((id): id is string => Boolean(id))
    .map(String);
  return [...new Set(ids)].filter(id => id !== actorId);
}

// ==================== Mentions ====================

/**
 * How a mention is written in a comment or description: `@[Name](user:<id>)`.
 * The editor inserts it when a person is picked from the @ list; the name is
 * only for display, the id is what counts.
 */
const MENTION_RE = /@\[([^\]\n]{1,80})\]\(user:([0-9a-fA-F]{24})\)/g;

/** The distinct user ids mentioned in a piece of text, in order of appearance. */
export function parseMentions(text: string | null | undefined): string[] {
  if (!text) return [];
  const ids: string[] = [];
  for (const match of text.matchAll(MENTION_RE)) {
    const id = match[2].toLowerCase();
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * Who should be told they were mentioned: people mentioned in the new text who
 * were not already mentioned in the old one (so an edit does not ping everyone
 * again), who are on the project, and who are not the author.
 */
export function mentionTargets(input: {
  before?: string | null;
  after: string;
  projectPeople: string[];
  actorId: string;
}): string[] {
  const already = new Set(parseMentions(input.before));
  const allowed = new Set(input.projectPeople.map(id => id.toLowerCase()));
  return parseMentions(input.after).filter(
    id => !already.has(id) && allowed.has(id) && id !== input.actorId.toLowerCase()
  );
}

/** Plain text of a mention-bearing string, for notification previews. */
export function plainText(text: string): string {
  return text.replace(MENTION_RE, "@$1");
}

// ==================== Labels ====================

/** Label colours are stored as #rrggbb. */
export function isLabelColor(value: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(value);
}

/** Whether every requested label belongs to the card's project. */
export function labelsBelong(requested: string[], projectLabelIds: string[]): boolean {
  const own = new Set(projectLabelIds);
  return requested.every(id => own.has(id));
}

// ==================== Departments and stages ====================

/**
 * The stages a task moves through. A task has one status shared by every
 * department working on it; the department board's columns are these stages,
 * and the project board's columns map onto them by name.
 */
export const TASK_STAGES = ["backlog", "todo", "in_progress", "in_review", "done"] as const;
export type TaskStage = (typeof TASK_STAGES)[number];

/**
 * Which stage a project board column stands for, read from its name, or null
 * when the name says nothing about progress (e.g. "Marketing").
 */
export function inferStage(columnName: string): TaskStage | null {
  const name = columnName.trim().toLowerCase().replace(/[\s_-]+/g, " ");
  if (/^(backlog|ideas?|icebox|inbox|new)$/.test(name)) return "backlog";
  if (/^(to ?do|todo|open|ready|planned|up next|next)$/.test(name)) return "todo";
  if (/(progress|doing|working|active|wip|ongoing|development|dev)/.test(name)) return "in_progress";
  if (/(review|qa|testing|test|approval|feedback|check)/.test(name)) return "in_review";
  if (/^(done|complete|completed|finished|closed|shipped|delivered|live)$/.test(name)) return "done";
  return null;
}

/**
 * The column of a project's board a stage lands in: the first column whose
 * name maps to that stage, else null (the card stays where it is).
 */
export function columnForStage(
  columns: { id: string; name: string; position: number }[],
  stage: TaskStage
): string | null {
  const sorted = [...columns].sort((a, b) => a.position - b.position);
  return sorted.find(c => inferStage(c.name) === stage)?.id ?? null;
}

/**
 * Who may mark a department task done. The task has one owner department;
 * its head has the final say, along with the project's creator (the PM) and
 * admins. Tasks with no departments keep the old rule: anyone on the project.
 */
export function canFinishTask(input: {
  actorId: string;
  actorIsOrgWide: boolean;
  projectCreatorId: string;
  departmentIds: string[];
  ownerDepartmentHeadId: string | null;
}): boolean {
  if (input.actorIsOrgWide) return true;
  if (input.departmentIds.length === 0) return true;
  if (input.actorId === input.projectCreatorId) return true;
  return input.ownerDepartmentHeadId !== null && input.actorId === input.ownerDepartmentHeadId;
}

/**
 * The owner department of a task: the one named, if it is among the task's
 * departments, else the first department. Null for a task with none.
 */
export function resolveOwnerDepartment(departmentIds: string[], requested?: string | null): string | null {
  const unique = [...new Set(departmentIds)];
  if (unique.length === 0) return null;
  if (requested && unique.includes(requested)) return requested;
  return unique[0];
}

export type StageSpan = { status: string; from: string; to: string | null; durationMs: number };

/**
 * A task's history as stages: when it entered each one and how long it stayed,
 * from its status-change events. The last span is still open (to = null) and
 * runs to `now`. Totals add up the time spent in each stage across visits.
 */
export function buildStageTimeline(input: {
  createdAt: Date | string;
  initialStatus: string;
  events: { at: Date | string; toStatus: string }[];
  now: Date;
}): { spans: StageSpan[]; totals: Record<string, number> } {
  const events = [...input.events]
    .map(e => ({ at: new Date(e.at).getTime(), toStatus: e.toStatus }))
    .sort((a, b) => a.at - b.at);
  const spans: StageSpan[] = [];
  let status = input.initialStatus;
  let since = new Date(input.createdAt).getTime();
  for (const e of events) {
    if (e.toStatus === status) continue;
    const at = Math.max(e.at, since);
    spans.push({ status, from: new Date(since).toISOString(), to: new Date(at).toISOString(), durationMs: at - since });
    status = e.toStatus;
    since = at;
  }
  const end = Math.max(input.now.getTime(), since);
  spans.push({ status, from: new Date(since).toISOString(), to: null, durationMs: end - since });
  const totals: Record<string, number> = {};
  for (const s of spans) totals[s.status] = (totals[s.status] ?? 0) + s.durationMs;
  return { spans, totals };
}


/** Midnight at the start of `now`'s day in office time (offset in minutes east of UTC). */
export function officeDayStart(now: Date, offsetMinutes: number): Date {
  const shift = offsetMinutes * 60000;
  const local = new Date(now.getTime() + shift);
  local.setUTCHours(0, 0, 0, 0);
  return new Date(local.getTime() - shift);
}
