import { describe, expect, it } from "vitest";
import {
  buildStageTimeline,
  canFinishTask,
  columnForStage,
  inferStage,
  officeDayStart,
  resolveOwnerDepartment,
} from "./fpbRules";

describe("department task rules", () => {
  it("reads a stage from a column name", () => {
    expect(inferStage("Backlog")).toBe("backlog");
    expect(inferStage("To Do")).toBe("todo");
    expect(inferStage("todo")).toBe("todo");
    expect(inferStage("In Progress")).toBe("in_progress");
    expect(inferStage("In Review")).toBe("in_review");
    expect(inferStage("QA")).toBe("in_review");
    expect(inferStage("Done")).toBe("done");
    expect(inferStage("Marketing")).toBe(null);
  });

  it("finds the first column for a stage, or none", () => {
    const cols = [
      { id: "c3", name: "Done", position: 3 },
      { id: "c1", name: "To Do", position: 1 },
      { id: "c0", name: "Backlog", position: 0 },
      { id: "c2", name: "Doing", position: 2 },
    ];
    expect(columnForStage(cols, "backlog")).toBe("c0");
    expect(columnForStage(cols, "in_progress")).toBe("c2");
    expect(columnForStage(cols, "in_review")).toBe(null);
  });

  it("gives the final say on a department task to the owner head, the PM and admins", () => {
    const base = {
      actorIsOrgWide: false,
      projectCreatorId: "pm",
      departmentIds: ["design", "dev"],
      ownerDepartmentHeadId: "designHead",
    };
    expect(canFinishTask({ ...base, actorId: "designHead" })).toBe(true);
    expect(canFinishTask({ ...base, actorId: "pm" })).toBe(true);
    expect(canFinishTask({ ...base, actorId: "devHead" })).toBe(false);
    expect(canFinishTask({ ...base, actorId: "employee" })).toBe(false);
    expect(canFinishTask({ ...base, actorId: "x", actorIsOrgWide: true })).toBe(true);
    // A task with no departments keeps the old rule.
    expect(canFinishTask({ ...base, departmentIds: [], actorId: "employee" })).toBe(true);
  });

  it("keeps the owner among the task's departments", () => {
    expect(resolveOwnerDepartment(["a", "b"], "b")).toBe("b");
    expect(resolveOwnerDepartment(["a", "b"], "z")).toBe("a");
    expect(resolveOwnerDepartment(["a"], undefined)).toBe("a");
    expect(resolveOwnerDepartment([], "a")).toBe(null);
  });

  it("turns status changes into time spent per stage", () => {
    const t0 = new Date("2026-11-01T09:00:00Z");
    const h = (n: number) => new Date(t0.getTime() + n * 3600_000);
    const { spans, totals } = buildStageTimeline({
      createdAt: t0,
      initialStatus: "backlog",
      events: [
        { at: h(2), toStatus: "in_progress" },
        { at: h(5), toStatus: "in_review" },
        { at: h(6), toStatus: "in_progress" },
        { at: h(6), toStatus: "in_progress" }, // repeat: ignored
        { at: h(9), toStatus: "done" },
      ],
      now: h(10),
    });
    expect(spans.map(s => s.status)).toEqual(["backlog", "in_progress", "in_review", "in_progress", "done"]);
    expect(totals.backlog).toBe(2 * 3600_000);
    expect(totals.in_progress).toBe(6 * 3600_000);
    expect(totals.in_review).toBe(3600_000);
    expect(spans[spans.length - 1].to).toBe(null);
    expect(totals.done).toBe(3600_000);
  });

  it("finds the start of the office day", () => {
    // 03:00 in Karachi on 5 Nov is 22:00 UTC on 4 Nov; the day began at 19:00 UTC on 4 Nov.
    expect(officeDayStart(new Date("2026-11-04T22:00:00Z"), 300).toISOString()).toBe("2026-11-04T19:00:00.000Z");
    expect(officeDayStart(new Date("2026-11-05T10:00:00Z"), 300).toISOString()).toBe("2026-11-04T19:00:00.000Z");
  });
});
