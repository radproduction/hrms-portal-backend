/**
 * The owner's view of the board: every project, grouped by the department
 * that runs it, with how far along it is and what is overdue.
 *
 * A project is listed under every department its tasks were handed to, since
 * the project manager creates projects and the departments do the work. A
 * project with no department tasks yet sits under its creator's department (a
 * head whose own department is unset counts for the one they lead). Other
 * departments involved are listed on each card.
 *
 * summarizeOverview is pure, so the grouping can be tested without a database.
 */
import { localDateKey } from "./attendance";

export type OverviewProject = {
  id: string;
  title: string;
  projectType: string;
  scopes?: string[];
  status: string;
  priority?: string;
  startDate?: Date | string | null;
  dueDate?: Date | string | null;
  createdBy: string;
  memberIds: string[];
  updatedAt?: Date | string | null;
};

export type OverviewTask = {
  projectId: string;
  completed: boolean;
  dueDate?: Date | string | null;
  /** The departments the task was handed to, if any. */
  departmentIds?: string[];
};

export type OverviewUser = { id: string; name: string; departmentId?: string | null };
export type OverviewDepartment = { id: string; name: string; headUserId?: string | null };

export type OverviewCard = {
  id: string;
  title: string;
  projectType: string;
  scopes: string[];
  status: string;
  priority: string;
  startDate: string | null;
  dueDate: string | null;
  ownerName: string;
  taskCount: number;
  completedTasks: number;
  openTasks: number;
  overdueTasks: number;
  progress: number;
  /** Everyone on it: the creator first, then the members. */
  people: { id: string; name: string }[];
  /** Other departments with people on it. */
  alsoDepartments: string[];
};

export type OverviewSection = {
  id: string | null;
  name: string;
  headName: string | null;
  projectCount: number;
  openTasks: number;
  overdueTasks: number;
  projects: OverviewCard[];
};

export type ProjectsOverview = {
  totals: { projects: number; openTasks: number; overdueTasks: number; completedTasks: number; taskCount: number };
  departments: OverviewSection[];
};

const NO_DEPARTMENT = "No department";

export function summarizeOverview(input: {
  projects: OverviewProject[];
  tasks: OverviewTask[];
  users: OverviewUser[];
  departments: OverviewDepartment[];
  now: Date;
  offsetMinutes?: number;
}): ProjectsOverview {
  const key = (d: Date | string) => localDateKey(new Date(d), input.offsetMinutes);
  const todayKey = key(input.now);

  const deptById = new Map(input.departments.map(d => [d.id, d]));
  const ledBy = new Map<string, string>();
  for (const d of input.departments) if (d.headUserId) ledBy.set(d.headUserId, d.id);
  const userById = new Map(input.users.map(u => [u.id, u]));
  const deptOf = (userId: string): string | null => {
    const own = userById.get(userId)?.departmentId;
    if (own && deptById.has(own)) return own;
    return ledBy.get(userId) ?? null;
  };
  const nameOf = (userId: string) => userById.get(userId)?.name || "Former employee";

  const stats = new Map<string, { total: number; done: number; overdue: number }>();
  // Which departments each project's tasks went to.
  const taskDepartments = new Map<string, Set<string>>();
  for (const t of input.tasks) {
    for (const d of t.departmentIds ?? []) {
      if (!deptById.has(d)) continue;
      const set = taskDepartments.get(t.projectId) ?? new Set<string>();
      set.add(d);
      taskDepartments.set(t.projectId, set);
    }
    const s = stats.get(t.projectId) ?? { total: 0, done: 0, overdue: 0 };
    s.total += 1;
    if (t.completed) s.done += 1;
    else if (t.dueDate && key(t.dueDate) < todayKey) s.overdue += 1;
    stats.set(t.projectId, s);
  }

  const sections = new Map<string, OverviewSection>();
  for (const p of input.projects) {
    const s = stats.get(p.id) ?? { total: 0, done: 0, overdue: 0 };
    const working = [...(taskDepartments.get(p.id) ?? [])];
    const homes: (string | null)[] = working.length > 0 ? working : [deptOf(p.createdBy)];
    const peopleIds = [...new Set([p.createdBy, ...p.memberIds])];

    const card: OverviewCard = {
      id: p.id,
      title: p.title,
      projectType: p.projectType,
      scopes: p.scopes ?? [],
      status: p.status,
      priority: p.priority ?? "medium",
      startDate: p.startDate ? new Date(p.startDate).toISOString() : null,
      dueDate: p.dueDate ? new Date(p.dueDate).toISOString() : null,
      ownerName: nameOf(p.createdBy),
      taskCount: s.total,
      completedTasks: s.done,
      openTasks: s.total - s.done,
      overdueTasks: s.overdue,
      progress: s.total > 0 ? Math.round((s.done / s.total) * 100) : 0,
      people: peopleIds.filter(id => userById.has(id)).map(id => ({ id, name: nameOf(id) })),
      alsoDepartments: [],
    };

    for (const ownerDept of homes) {
    // On each department's card: the other departments working on it.
    const also = new Set<string>(
      working.filter(d => d !== ownerDept).map(d => deptById.get(d)!.name)
    );
    if (working.length === 0) {
      for (const id of peopleIds) {
        const d = deptOf(id);
        if (d && d !== ownerDept) also.add(deptById.get(d)!.name);
      }
    }
    const placed = { ...card, alsoDepartments: [...also].sort() };
    const k = ownerDept ?? "";
    const section = sections.get(k) ?? {
      id: ownerDept,
      name: ownerDept ? deptById.get(ownerDept)!.name : NO_DEPARTMENT,
      headName: (() => {
        const head = ownerDept ? deptById.get(ownerDept)?.headUserId : null;
        return head ? nameOf(head) : null;
      })(),
      projectCount: 0,
      openTasks: 0,
      overdueTasks: 0,
      projects: [],
    };
    section.projectCount += 1;
    section.openTasks += card.openTasks;
    section.overdueTasks += card.overdueTasks;
    section.projects.push(placed);
    sections.set(k, section);
    }
  }

  const departments = [...sections.values()]
    .map(sec => ({
      ...sec,
      // Most overdue first, then the most work still open, then by name.
      projects: sec.projects.sort(
        (a, b) => b.overdueTasks - a.overdueTasks || b.openTasks - a.openTasks || a.title.localeCompare(b.title)
      ),
    }))
    .sort((a, b) => (a.id === null ? 1 : b.id === null ? -1 : a.name.localeCompare(b.name)));

  // Each project once, though it may sit under several departments.
  const all = [...new Map(departments.flatMap(d => d.projects).map(p => [p.id, p])).values()];
  return {
    totals: {
      projects: all.length,
      openTasks: all.reduce((n, p) => n + p.openTasks, 0),
      overdueTasks: all.reduce((n, p) => n + p.overdueTasks, 0),
      completedTasks: all.reduce((n, p) => n + p.completedTasks, 0),
      taskCount: all.reduce((n, p) => n + p.taskCount, 0),
    },
    departments,
  };
}

// ==================== Department KPIs ====================

export type KpiTask = {
  id: string;
  projectId: string;
  departmentIds: string[];
  ownerDepartmentId: string | null;
  status: string;
  completed: boolean;
  completedAt: Date | string | null;
  createdAt: Date | string;
  dueDate: Date | string | null;
  assignees: { departmentId: string; userId: string }[];
};

export type DepartmentKpi = {
  id: string;
  name: string;
  headName: string | null;
  projects: number;
  totalTasks: number;
  ownedTasks: number;
  openTasks: number;
  unassignedTasks: number;
  overdueTasks: number;
  byStage: Record<string, number>;
  completedInPeriod: number;
  onTimeInPeriod: number;
  /** Share of this period's completions that had a due date and met it; null with none to measure. */
  onTimeRate: number | null;
  /** Average days from a task reaching the department to it being done, this period. */
  avgCycleDays: number | null;
  activityLast7Days: number;
};

const STAGE_KEYS = ["backlog", "todo", "in_progress", "in_review", "blocked", "done"];

/**
 * Per-department KPIs from the board: how much work each department holds,
 * where it sits, how much is late, and how fast and on time it gets done.
 * A task with several departments counts for each of them.
 */
export function summarizeDepartmentKpis(input: {
  departments: { id: string; name: string; headName?: string | null }[];
  tasks: KpiTask[];
  activityCounts: Map<string, number>;
  start: Date;
  end: Date;
  now: Date;
  offsetMinutes?: number;
}): DepartmentKpi[] {
  const key = (d: Date | string) => localDateKey(new Date(d), input.offsetMinutes);
  const todayKey = key(input.now);
  const startMs = input.start.getTime();
  const endMs = input.end.getTime();

  return input.departments.map(d => {
    const mine = input.tasks.filter(t => t.departmentIds.includes(d.id));
    const byStage: Record<string, number> = Object.fromEntries(STAGE_KEYS.map(k => [k, 0]));
    let open = 0, unassigned = 0, overdue = 0, completed = 0, onTime = 0, measured = 0, cycleTotal = 0, cycleCount = 0;
    for (const t of mine) {
      const done = t.completed || t.status === "done";
      const stage = done ? "done" : STAGE_KEYS.includes(t.status) ? t.status : "todo";
      byStage[stage] += 1;
      if (!done) {
        open += 1;
        if (!t.assignees.some(a => a.departmentId === d.id)) unassigned += 1;
        if (t.dueDate && key(t.dueDate) < todayKey) overdue += 1;
        continue;
      }
      if (!t.completedAt) continue;
      const at = new Date(t.completedAt).getTime();
      if (at < startMs || at > endMs) continue;
      completed += 1;
      if (t.dueDate) {
        measured += 1;
        if (key(t.completedAt) <= key(t.dueDate)) onTime += 1;
      }
      cycleTotal += Math.max(0, at - new Date(t.createdAt).getTime());
      cycleCount += 1;
    }
    return {
      id: d.id,
      name: d.name,
      headName: d.headName ?? null,
      projects: new Set(mine.map(t => t.projectId)).size,
      totalTasks: mine.length,
      ownedTasks: mine.filter(t => (t.ownerDepartmentId ?? t.departmentIds[0]) === d.id).length,
      openTasks: open,
      unassignedTasks: unassigned,
      overdueTasks: overdue,
      byStage,
      completedInPeriod: completed,
      onTimeInPeriod: onTime,
      onTimeRate: measured > 0 ? Math.round((onTime / measured) * 100) : null,
      avgCycleDays: cycleCount > 0 ? Math.round((cycleTotal / cycleCount / 86400000) * 10) / 10 : null,
      activityLast7Days: input.activityCounts.get(d.id) ?? 0,
    };
  });
}
