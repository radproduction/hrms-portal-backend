import { describe, expect, it } from "vitest";
import { buildFourWeeks, buildLeaveBalance, leaveDateKeys, localClock } from "./nowTime";

// Office time is UTC+5 throughout, the same default the reports use.
const OFFSET = 300;
const at = (date: string, time: string) => new Date(`${date}T${time}:00+05:00`);
const WORK_WEEK = new Set([1, 2, 3, 4, 5]);
const base = { offsetMinutes: OFFSET, workWeek: WORK_WEEK, shiftStartMinutes: 600, lateGraceMinutes: 15, maxShiftHours: 14 };

describe("buildFourWeeks", () => {
  // Friday 2 October 2026, mid afternoon.
  const now = at("2026-10-02", "15:40");

  it("covers four Monday-to-Friday weeks ending with the current one", () => {
    const result = buildFourWeeks({ entries: [], leaves: [], overtime: [], now, ...base });
    expect(result.from).toBe("2026-09-07");
    expect(result.to).toBe("2026-10-04");
    expect(result.days).toHaveLength(20);
    expect(result.days[0].date).toBe("2026-09-07");
    expect(result.days[19]).toMatchObject({ date: "2026-10-02", kind: "today" });
  });

  it("marks a clock-in after the grace period as late, and one inside it as on time", () => {
    const result = buildFourWeeks({
      entries: [
        { timeIn: at("2026-09-15", "10:42"), timeOut: at("2026-09-15", "18:06"), totalHours: 7.4 },
        { timeIn: at("2026-09-16", "10:15"), timeOut: at("2026-09-16", "18:39"), totalHours: 8.4 },
      ],
      leaves: [], overtime: [], now, ...base,
    });
    const day = (date: string) => result.days.find(d => d.date === date)!;
    expect(day("2026-09-15")).toMatchObject({ kind: "late", hours: 7.4, note: "Late, 10:42" });
    expect(day("2026-09-16")).toMatchObject({ kind: "ok", hours: 8.4 });
    expect(result.stats.lateArrivals).toBe(1);
  });

  it("flags a past day that was never clocked out of, but not today's open session", () => {
    const result = buildFourWeeks({
      entries: [
        { timeIn: at("2026-09-24", "10:02"), status: "active" },
        { timeIn: at("2026-10-02", "15:28"), status: "active" },
      ],
      leaves: [], overtime: [], now, ...base,
    });
    expect(result.toFix).toEqual([{ date: "2026-09-24", reason: "No clock-out" }]);
    expect(result.days.find(d => d.date === "2026-09-24")).toMatchObject({ kind: "fix", hours: null });
    expect(result.days.find(d => d.date === "2026-10-02")).toMatchObject({ kind: "today", hours: 0.2, note: "Today, in at 15:28" });
  });

  it("treats a session closed by the shift sweep as needing a fix, and leaves its hours out of the average", () => {
    const result = buildFourWeeks({
      entries: [
        { timeIn: at("2026-09-21", "10:00"), timeOut: at("2026-09-21", "22:00"), totalHours: 12, autoClockedOut: true },
        { timeIn: at("2026-09-22", "10:00"), timeOut: at("2026-09-22", "18:00"), totalHours: 8 },
      ],
      leaves: [], overtime: [], now, ...base,
    });
    expect(result.toFix).toEqual([{ date: "2026-09-21", reason: "No clock-out" }]);
    expect(result.stats.averageHours).toBe(8);
    expect(result.stats.daysPresent).toBe(2);
  });

  it("shows approved leave, ignores pending leave, and counts short days and overtime", () => {
    const result = buildFourWeeks({
      entries: [{ timeIn: at("2026-09-30", "10:00"), timeOut: at("2026-09-30", "15:00"), totalHours: 5 }],
      leaves: [
        { leaveType: "annual", startDate: at("2026-09-17", "00:00"), endDate: at("2026-09-17", "00:00"), status: "approved" },
        { leaveType: "casual", startDate: at("2026-09-18", "00:00"), endDate: at("2026-09-18", "00:00"), status: "pending" },
      ],
      overtime: [{ workDate: at("2026-09-30", "00:00"), hours: 1.5 }, { workDate: at("2026-08-01", "00:00"), hours: 9 }],
      now, ...base,
    });
    expect(result.days.find(d => d.date === "2026-09-17")).toMatchObject({ kind: "leave", note: "Annual" });
    expect(result.days.find(d => d.date === "2026-09-18")).toMatchObject({ kind: "absent" });
    expect(result.stats.earlyOuts).toBe(1);
    expect(result.stats.overtimeHours).toBe(1.5);
    // Twenty working days in the window, all of them on or before today.
    expect(result.stats.workingDays).toBe(20);
  });

  it("files a 1am clock-in under the office-local day, and shows worked weekends only", () => {
    const result = buildFourWeeks({
      entries: [
        // 20:30 UTC on Tuesday is 01:30 on Wednesday in the office.
        { timeIn: new Date("2026-09-22T20:30:00Z"), timeOut: new Date("2026-09-23T02:30:00Z"), totalHours: 6 },
        { timeIn: at("2026-09-26", "11:00"), timeOut: at("2026-09-26", "14:00"), totalHours: 3 },
      ],
      leaves: [], overtime: [], now, ...base,
    });
    expect(result.days.find(d => d.date === "2026-09-23")?.timeIn).toBe("01:30");
    expect(result.days.find(d => d.date === "2026-09-22")?.kind).toBe("absent");
    // Saturday appears because it was worked; Sunday does not.
    expect(result.days.some(d => d.date === "2026-09-26")).toBe(true);
    expect(result.days.some(d => d.date === "2026-09-27")).toBe(false);
    // A worked weekend is never a late arrival or a short day.
    expect(result.stats.lateArrivals).toBe(0);
    expect(result.stats.earlyOuts).toBe(1);
  });

  it("leaves the rest of the current week as upcoming, not absent", () => {
    const wednesday = at("2026-09-30", "11:00");
    const result = buildFourWeeks({ entries: [], leaves: [], overtime: [], now: wednesday, ...base });
    expect(result.days.find(d => d.date === "2026-10-01")?.kind).toBe("upcoming");
    expect(result.stats.workingDays).toBe(18);
  });
});

describe("buildLeaveBalance", () => {
  const quotas = { annual: 14, casual: 10, sick: 8 };
  const leave = (leaveType: string, start: string, end: string, status = "approved") => ({
    leaveType, startDate: at(start, "00:00"), endDate: at(end, "00:00"), status,
  });

  it("counts working days only, so Friday to Monday is two days", () => {
    const rows = buildLeaveBalance({ leaves: [leave("annual", "2026-09-18", "2026-09-21")], year: 2026, quotas, offsetMinutes: OFFSET, workWeek: WORK_WEEK });
    expect(rows.find(r => r.type === "annual")).toEqual({ type: "annual", quota: 14, used: 2, pending: 0, left: 12 });
  });

  it("keeps pending apart from used, and ignores rejected and unpaid leave", () => {
    const rows = buildLeaveBalance({
      leaves: [
        leave("casual", "2026-03-02", "2026-03-03"),
        leave("casual", "2026-11-02", "2026-11-02", "pending"),
        leave("casual", "2026-05-04", "2026-05-08", "rejected"),
        leave("unpaid", "2026-06-01", "2026-06-05"),
      ],
      year: 2026, quotas, offsetMinutes: OFFSET, workWeek: WORK_WEEK,
    });
    expect(rows.find(r => r.type === "casual")).toEqual({ type: "casual", quota: 10, used: 2, pending: 1, left: 8 });
    expect(rows.find(r => r.type === "sick")).toEqual({ type: "sick", quota: 8, used: 0, pending: 0, left: 8 });
  });

  it("splits a leave across New Year and never goes below zero", () => {
    const leaves = [leave("sick", "2026-12-30", "2027-01-04"), leave("sick", "2026-02-02", "2026-02-13")];
    const y2026 = buildLeaveBalance({ leaves, year: 2026, quotas, offsetMinutes: OFFSET, workWeek: WORK_WEEK });
    const y2027 = buildLeaveBalance({ leaves, year: 2027, quotas, offsetMinutes: OFFSET, workWeek: WORK_WEEK });
    // Feb: 10 working days. Dec 30 and 31: 2 more. Over the quota of 8.
    expect(y2026.find(r => r.type === "sick")).toMatchObject({ used: 12, left: 0 });
    // Fri 1 Jan and Mon 4 Jan.
    expect(y2027.find(r => r.type === "sick")).toMatchObject({ used: 2, left: 6 });
  });
});

describe("helpers", () => {
  it("lists every day of a leave and formats office-local time", () => {
    expect(leaveDateKeys(at("2026-09-30", "00:00"), at("2026-10-02", "00:00"), OFFSET)).toEqual(["2026-09-30", "2026-10-01", "2026-10-02"]);
    expect(leaveDateKeys(at("2026-10-02", "00:00"), at("2026-09-30", "00:00"), OFFSET)).toEqual([]);
    expect(localClock(new Date("2026-10-02T10:28:00Z"), OFFSET)).toBe("15:28");
  });
});
