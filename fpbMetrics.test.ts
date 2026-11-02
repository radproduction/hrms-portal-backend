import { describe, expect, it } from "vitest";
import { getMonthRange } from "./attendance";
import { summarizePerformance, type MetricsTask } from "./fpbMetrics";

const OFFSET = 300;
const { start, end } = getMonthRange(11, 2026, OFFSET);
const now = new Date("2026-11-20T10:00:00Z");

const users = [
  { id: "ali", name: "Ali", departmentId: "dev" },
  { id: "sara", name: "Sara", departmentId: "design" },
  { id: "head", name: "Head of Dev" }, // heads often have no departmentId
  { id: "x", name: "No Dept" },
];
const departments = [
  { id: "dev", name: "Development", headUserId: "head" },
  { id: "design", name: "Design" },
];

const task = (over: Partial<MetricsTask>): MetricsTask => ({
  id: Math.random().toString(36).slice(2),
  projectId: "p1",
  projectTitle: "Kunzul Channar",
  title: "t",
  completed: false,
  ...over,
});

describe("summarizePerformance", () => {
  const report = summarizePerformance({
    users, departments, month: 11, year: 2026, start, end, now, offsetMinutes: OFFSET,
    tasks: [
      // Ali: two this month (one on time, one late), one last month.
      task({ completed: true, completedAt: "2026-11-05T09:00:00Z", completedBy: "ali", dueDate: "2026-11-06T07:00:00Z" }),
      task({ completed: true, completedAt: "2026-11-10T09:00:00Z", completedBy: "ali", dueDate: "2026-11-08T07:00:00Z", projectId: "p2", projectTitle: "Heard" }),
      task({ completed: true, completedAt: "2026-10-30T09:00:00Z", completedBy: "ali" }),
      // Credit goes to completedBy, not whoever is assigned now.
      task({ completed: true, completedAt: "2026-11-12T09:00:00Z", completedBy: "sara", assignedTo: "ali" }),
      // Legacy: no stamp, falls back to assignee + updatedAt.
      task({ completed: true, assignedTo: "sara", updatedAt: "2026-11-15T09:00:00Z" }),
      // Open work for Ali: one overdue, one not.
      task({ assignedTo: "ali", dueDate: "2026-11-01T07:00:00Z" }),
      task({ assignedTo: "ali", dueDate: "2026-12-01T07:00:00Z" }),
      // Head of Dev finished one.
      task({ completed: true, completedAt: "2026-11-03T09:00:00Z", completedBy: "head" }),
    ],
  });

  const row = (id: string) =>
    report.departments.flatMap(d => d.employees).find(e => e.userId === id)!;

  it("counts tasks completed in the month, per person, on time or late", () => {
    expect(row("ali")).toMatchObject({ completed: 2, completedOnTime: 1, completedLate: 1, open: 2, overdue: 1 });
    expect(row("ali").projects.map(p => p.title).sort()).toEqual(["Heard", "Kunzul Channar"]);
  });

  it("credits the completer and falls back for old tasks", () => {
    expect(row("sara").completed).toBe(2);
  });

  it("groups by department, putting a head in the department they lead", () => {
    expect(row("head").departmentName).toBe("Development");
    const dev = report.departments.find(d => d.name === "Development")!;
    expect(dev.completed).toBe(3);
    expect(report.departments[report.departments.length - 1].name).toBe("No department");
  });

  it("totals the whole report", () => {
    expect(report.totals.completed).toBe(5);
  });
});
