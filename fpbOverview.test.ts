import { describe, expect, it } from "vitest";
import { summarizeDepartmentKpis, summarizeOverview } from "./fpbOverview";

const now = new Date("2026-11-04T07:00:00Z");
const departments = [
  { id: "brand", name: "Brand", headUserId: "tayaba" },
  { id: "dev", name: "Development", headUserId: null },
];
const users = [
  { id: "tayaba", name: "Tayaba Aslam", departmentId: null }, // head, own department unset
  { id: "eshal", name: "Eshal Khurshid", departmentId: "brand" },
  { id: "hassan", name: "Muhammad Hassan", departmentId: "dev" },
  { id: "owner", name: "Owner", departmentId: null },
];

describe("summarizeOverview", () => {
  it("groups projects under their creator's department, a head under the one they lead", () => {
    const report = summarizeOverview({
      now, departments, users,
      projects: [
        { id: "p1", title: "JBS", projectType: "management", status: "active", createdBy: "tayaba", memberIds: ["eshal", "hassan"] },
        { id: "p2", title: "Strapi", projectType: "dev", status: "active", createdBy: "hassan", memberIds: [] },
        { id: "p3", title: "Stack", projectType: "dev", status: "active", createdBy: "owner", memberIds: [] },
      ],
      tasks: [],
    });
    expect(report.departments.map(d => d.name)).toEqual(["Brand", "Development", "No department"]);
    const brand = report.departments[0];
    expect(brand.headName).toBe("Tayaba Aslam");
    expect(brand.projects[0].title).toBe("JBS");
    // Development has a person on JBS, so it shows as shared.
    expect(brand.projects[0].alsoDepartments).toEqual(["Development"]);
    expect(brand.projects[0].people.map(p => p.id)).toEqual(["tayaba", "eshal", "hassan"]);
  });

  it("counts progress and overdue work, most overdue first", () => {
    const report = summarizeOverview({
      now, departments, users,
      projects: [
        { id: "a", title: "Calm", projectType: "dev", status: "active", createdBy: "hassan", memberIds: [] },
        { id: "b", title: "Late", projectType: "dev", status: "active", createdBy: "hassan", memberIds: [] },
      ],
      tasks: [
        { projectId: "a", completed: true },
        { projectId: "a", completed: false, dueDate: "2026-12-01" },
        { projectId: "b", completed: false, dueDate: "2026-10-01" },
        { projectId: "b", completed: true, dueDate: "2026-10-01" }, // done: not overdue
        { projectId: "b", completed: false, dueDate: "2026-11-04T10:00:00Z" }, // due today: not yet
      ],
    });
    const dev = report.departments[0];
    expect(dev.projects.map(p => p.title)).toEqual(["Late", "Calm"]);
    expect(dev.projects[0]).toMatchObject({ taskCount: 3, completedTasks: 1, openTasks: 2, overdueTasks: 1, progress: 33 });
    expect(dev.projects[1]).toMatchObject({ progress: 50, overdueTasks: 0 });
    expect(report.totals).toEqual({ projects: 2, openTasks: 3, overdueTasks: 1, completedTasks: 2, taskCount: 5 });
    expect(dev.overdueTasks).toBe(1);
  });
});

describe("summarizeOverview with department tasks", () => {
  it("lists a project under each department its tasks went to, and counts it once", () => {
    const report = summarizeOverview({
      now, departments, users,
      projects: [
        { id: "p1", title: "Website", projectType: "other", status: "active", createdBy: "owner", memberIds: [] },
      ],
      tasks: [
        { projectId: "p1", completed: false, departmentIds: ["brand", "dev"] },
        { projectId: "p1", completed: true, departmentIds: ["dev"] },
      ],
    });
    expect(report.departments.map(d => d.name)).toEqual(["Brand", "Development"]);
    expect(report.departments[0].projects[0].alsoDepartments).toEqual(["Development"]);
    expect(report.departments[1].projects[0].alsoDepartments).toEqual(["Brand"]);
    expect(report.totals).toMatchObject({ projects: 1, taskCount: 2, completedTasks: 1 });
  });
});

describe("summarizeDepartmentKpis", () => {
  it("counts each department's work, lateness and pace", () => {
    const start = new Date("2026-11-01T00:00:00+05:00");
    const end = new Date("2026-11-30T23:59:59+05:00");
    const base = { assignees: [] as { departmentId: string; userId: string }[], ownerDepartmentId: null as string | null };
    const kpis = summarizeDepartmentKpis({
      departments: [{ id: "design", name: "Design", headName: "Ayesha" }, { id: "dev", name: "Development" }],
      activityCounts: new Map([["design", 7]]),
      start, end, now,
      tasks: [
        // Shared, owned by design, assigned in design only, overdue.
        { ...base, id: "1", projectId: "p1", departmentIds: ["design", "dev"], ownerDepartmentId: "design",
          status: "in_progress", completed: false, completedAt: null, createdAt: "2026-10-20", dueDate: "2026-11-01",
          assignees: [{ departmentId: "design", userId: "u1" }] },
        // Design, done on time this month in 2 days.
        { ...base, id: "2", projectId: "p2", departmentIds: ["design"], status: "done", completed: true,
          completedAt: "2026-11-03T10:00:00Z", createdAt: "2026-11-01T10:00:00Z", dueDate: "2026-11-05" },
        // Design, done late this month.
        { ...base, id: "3", projectId: "p2", departmentIds: ["design"], status: "done", completed: true,
          completedAt: "2026-11-04T10:00:00Z", createdAt: "2026-11-03T10:00:00Z", dueDate: "2026-11-02" },
        // Design, done last month: not in this period.
        { ...base, id: "4", projectId: "p3", departmentIds: ["design"], status: "done", completed: true,
          completedAt: "2026-10-04T10:00:00Z", createdAt: "2026-10-01T10:00:00Z", dueDate: null },
        // Design backlog, nobody on it.
        { ...base, id: "5", projectId: "p1", departmentIds: ["design"], status: "backlog", completed: false,
          completedAt: null, createdAt: "2026-11-02", dueDate: null },
      ],
    });
    const design = kpis[0];
    expect(design).toMatchObject({
      projects: 3, totalTasks: 5, ownedTasks: 5, openTasks: 2, unassignedTasks: 1, overdueTasks: 1,
      completedInPeriod: 2, onTimeInPeriod: 1, onTimeRate: 50, avgCycleDays: 1.5, activityLast7Days: 7,
    });
    expect(design.byStage).toMatchObject({ backlog: 1, in_progress: 1, done: 3 });
    const dev = kpis[1];
    // The shared task counts for dev too, unassigned there, owned by design.
    expect(dev).toMatchObject({ totalTasks: 1, ownedTasks: 0, openTasks: 1, unassignedTasks: 1, overdueTasks: 1, onTimeRate: null });
  });
});
