/**
 * How an old project and its tasks map onto the Work board. Pure, so it can be
 * tested without a database; used by migrate-tenant.ts.
 */

/** The columns a new project gets (the same as fpbDb's DEFAULT_COLUMNS). */
export const BOARD_COLUMNS = [
  { name: "Backlog", color: "#6b7280" },
  { name: "To Do", color: "#3b82f6" },
  { name: "In Progress", color: "#f59e0b" },
  { name: "In Review", color: "#8b5cf6" },
  { name: "Done", color: "#10b981" },
] as const;

export type BoardColumnName = (typeof BOARD_COLUMNS)[number]["name"];

/** Old project status → board project status. "cancelled" has no twin, so it is archived. */
export function projectStatusFor(status: unknown): "active" | "on_hold" | "completed" | "archived" {
  switch (status) {
    case "on_hold": return "on_hold";
    case "completed": return "completed";
    case "cancelled": return "archived";
    default: return "active";
  }
}

export function priorityFor(priority: unknown): "low" | "medium" | "high" | "urgent" {
  return priority === "low" || priority === "high" || priority === "urgent" ? priority : "medium";
}

export type LegacyTask = {
  userId?: unknown;
  assigneeIds?: unknown[];
  status?: string;
};

export type TaskPlan = {
  column: BoardColumnName;
  status: "todo" | "in_progress" | "blocked" | "done";
  completed: boolean;
  /** The person the card is assigned to: the first assignee, else its owner. */
  assignedTo: string | null;
  /** Everyone on the card: its owner and all assignees. */
  memberIds: string[];
  createdBy: string | null;
};

/**
 * Where an old task lands. `known` turns an id into itself if that person
 * still exists, else null, so nobody deleted is put on a card.
 */
export function planLegacyTask(task: LegacyTask, known: (id: unknown) => string | null): TaskPlan {
  const owner = known(task.userId);
  const assignees = (task.assigneeIds ?? []).map(known).filter((id): id is string => Boolean(id));
  const memberIds = Array.from(new Set([...(owner ? [owner] : []), ...assignees]));
  const assignedTo = assignees[0] ?? owner;

  switch (task.status) {
    case "completed":
      return { column: "Done", status: "done", completed: true, assignedTo, memberIds, createdBy: owner };
    case "in_progress":
      return { column: "In Progress", status: "in_progress", completed: false, assignedTo, memberIds, createdBy: owner };
    case "blocked":
      // The board shows blocked work in its In Progress column, flagged.
      return { column: "In Progress", status: "blocked", completed: false, assignedTo, memberIds, createdBy: owner };
    default:
      return { column: "To Do", status: "todo", completed: false, assignedTo, memberIds, createdBy: owner };
  }
}
