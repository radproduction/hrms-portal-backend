/**
 * Monthly performance from the project board: how many tasks each employee
 * completed, on which projects, how many on time, and what is still open or
 * overdue - grouped by department, for the monthly department and employee
 * reviews.
 *
 * Credit for a completed task goes to `completedBy` (the assignee when it was
 * completed; see completionStamp in fpbRules.ts) in the month of `completedAt`.
 * Tasks completed before that was recorded have neither, so they fall back to
 * their assignee and their last update time: close, not exact.
 *
 * summarizePerformance is pure, so the counting can be tested without a database.
 */
import { localDateKey } from "./attendance";

export type MetricsTask = {
  id: string;
  projectId: string;
  projectTitle: string;
  title: string;
  assignedTo?: string | null;
  completed: boolean;
  completedAt?: Date | string | null;
  completedBy?: string | null;
  dueDate?: Date | string | null;
  updatedAt?: Date | string | null;
};

export type MetricsUser = {
  id: string;
  name: string;
  position?: string;
  departmentId?: string | null;
};

export type MetricsDepartment = { id: string; name: string; headUserId?: string | null };

export type EmployeePerformance = {
  userId: string;
  name: string;
  position: string;
  departmentId: string | null;
  departmentName: string;
  completed: number;
  completedOnTime: number;
  completedLate: number;
  /** Completed with no due date to measure against. */
  completedNoDueDate: number;
  open: number;
  overdue: number;
  /** Completed this month, by project, most first. */
  projects: { projectId: string; title: string; completed: number }[];
  /** The tasks behind `completed`, newest first, for the drill-down. */
  completedTasks: { id: string; title: string; projectTitle: string; completedAt: string; onTime: boolean | null }[];
};

export type DepartmentPerformance = {
  id: string | null;
  name: string;
  completed: number;
  open: number;
  overdue: number;
  employees: EmployeePerformance[];
};

export type PerformanceReport = {
  period: { month: number; year: number; from: string; to: string };
  totals: { completed: number; completedOnTime: number; completedLate: number; open: number; overdue: number };
  departments: DepartmentPerformance[];
};

const NO_DEPARTMENT = "No department";

export function summarizePerformance(input: {
  tasks: MetricsTask[];
  users: MetricsUser[];
  departments: MetricsDepartment[];
  month: number;
  year: number;
  start: Date;
  end: Date;
  now: Date;
  offsetMinutes?: number;
}): PerformanceReport {
  const key = (d: Date | string) => localDateKey(new Date(d), input.offsetMinutes);
  const todayKey = key(input.now);

  const deptById = new Map(input.departments.map(d => [d.id, d]));
  // A head's own departmentId is often unset; place them in the department they lead.
  const ledBy = new Map<string, string>();
  for (const d of input.departments) if (d.headUserId) ledBy.set(d.headUserId, d.id);

  const rows = new Map<string, EmployeePerformance>();
  for (const u of input.users) {
    const deptId = (u.departmentId && deptById.has(u.departmentId) ? u.departmentId : ledBy.get(u.id)) ?? null;
    rows.set(u.id, {
      userId: u.id,
      name: u.name || "Employee",
      position: u.position ?? "",
      departmentId: deptId,
      departmentName: deptId ? deptById.get(deptId)?.name ?? NO_DEPARTMENT : NO_DEPARTMENT,
      completed: 0,
      completedOnTime: 0,
      completedLate: 0,
      completedNoDueDate: 0,
      open: 0,
      overdue: 0,
      projects: [],
      completedTasks: [],
    });
  }

  const startMs = input.start.getTime();
  const endMs = input.end.getTime();
  const perProject = new Map<string, Map<string, { title: string; completed: number }>>();

  for (const t of input.tasks) {
    if (t.completed) {
      // When, and to whom: the recorded stamp, else the legacy fallback.
      const at = t.completedAt ?? t.updatedAt;
      const who = t.completedAt ? t.completedBy ?? t.assignedTo : t.assignedTo;
      if (!at || !who) continue;
      const ms = new Date(at).getTime();
      if (!(ms >= startMs && ms <= endMs)) continue;
      const row = rows.get(String(who));
      if (!row) continue;

      row.completed += 1;
      let onTime: boolean | null = null;
      if (t.dueDate) {
        onTime = key(at) <= key(t.dueDate);
        if (onTime) row.completedOnTime += 1;
        else row.completedLate += 1;
      } else {
        row.completedNoDueDate += 1;
      }
      row.completedTasks.push({
        id: t.id,
        title: t.title,
        projectTitle: t.projectTitle,
        completedAt: new Date(at).toISOString(),
        onTime,
      });

      const projects = perProject.get(row.userId) ?? new Map();
      const p = projects.get(t.projectId) ?? { title: t.projectTitle, completed: 0 };
      p.completed += 1;
      projects.set(t.projectId, p);
      perProject.set(row.userId, projects);
    } else if (t.assignedTo) {
      // Open work is "now", not "this month": what is on their plate today.
      const row = rows.get(String(t.assignedTo));
      if (!row) continue;
      row.open += 1;
      if (t.dueDate && key(t.dueDate) < todayKey) row.overdue += 1;
    }
  }

  for (const row of rows.values()) {
    row.projects = [...(perProject.get(row.userId) ?? new Map()).entries()]
      .map(([projectId, p]) => ({ projectId, title: p.title, completed: p.completed }))
      .sort((a, b) => b.completed - a.completed || a.title.localeCompare(b.title));
    row.completedTasks.sort((a, b) => b.completedAt.localeCompare(a.completedAt));
  }

  const byDept = new Map<string, DepartmentPerformance>();
  for (const row of rows.values()) {
    const k = row.departmentId ?? "";
    const dept = byDept.get(k) ?? {
      id: row.departmentId,
      name: row.departmentName,
      completed: 0,
      open: 0,
      overdue: 0,
      employees: [],
    };
    dept.completed += row.completed;
    dept.open += row.open;
    dept.overdue += row.overdue;
    dept.employees.push(row);
    byDept.set(k, dept);
  }

  const departments = [...byDept.values()]
    .map(d => ({
      ...d,
      employees: d.employees.sort((a, b) => b.completed - a.completed || a.name.localeCompare(b.name)),
    }))
    // Real departments by name, "No department" last.
    .sort((a, b) => (a.id === null ? 1 : b.id === null ? -1 : a.name.localeCompare(b.name)));

  const all = [...rows.values()];
  return {
    period: {
      month: input.month,
      year: input.year,
      from: input.start.toISOString(),
      to: input.end.toISOString(),
    },
    totals: {
      completed: all.reduce((n, r) => n + r.completed, 0),
      completedOnTime: all.reduce((n, r) => n + r.completedOnTime, 0),
      completedLate: all.reduce((n, r) => n + r.completedLate, 0),
      open: all.reduce((n, r) => n + r.open, 0),
      overdue: all.reduce((n, r) => n + r.overdue, 0),
    },
    departments,
  };
}
