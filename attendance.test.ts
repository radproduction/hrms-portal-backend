import { describe, expect, it } from "vitest";
import {
  buildMonthDays,
  getMonthRange,
  leaveDatesInMonth,
  localDateKey,
  summarizeEmployeeMonth,
} from "./attendance";

const OFFSET = 300; // UTC+5, the default

describe("localDateKey", () => {
  it("uses office-local time, not UTC", () => {
    // 2026-03-01 01:30 local (UTC+5) is 2026-02-28 20:30 UTC.
    const instant = new Date("2026-02-28T20:30:00Z");
    expect(instant.toISOString().slice(0, 10)).toBe("2026-02-28");
    expect(localDateKey(instant, OFFSET)).toBe("2026-03-01");
  });

  it("keeps a normal working day on its own date", () => {
    // 09:00 local == 04:00 UTC
    expect(localDateKey(new Date("2026-03-10T04:00:00Z"), OFFSET)).toBe("2026-03-10");
  });
});

describe("getMonthRange", () => {
  it("brackets the local month in UTC instants", () => {
    const { start, end } = getMonthRange(3, 2026, OFFSET);
    // 2026-03-01 00:00 local == 2026-02-28 19:00 UTC
    expect(start.toISOString()).toBe("2026-02-28T19:00:00.000Z");
    // 2026-03-31 23:59:59.999 local == 2026-03-31 18:59:59.999 UTC
    expect(end.toISOString()).toBe("2026-03-31T18:59:59.999Z");
  });

  it("handles February in a leap year", () => {
    const { end } = getMonthRange(2, 2028, 0);
    expect(end.toISOString().slice(0, 10)).toBe("2028-02-29");
  });
});

describe("buildMonthDays", () => {
  it("returns every day with weekend flags", () => {
    const days = buildMonthDays(3, 2026);
    expect(days).toHaveLength(31);
    expect(days[0].date).toBe("2026-03-01");
    expect(days[30].date).toBe("2026-03-31");
    // 2026-03-01 is a Sunday.
    expect(days[0].weekday).toBe(0);
    expect(days[0].isWorkingDay).toBe(false);
    expect(days[1].isWorkingDay).toBe(true); // Monday
  });

  it("counts 22 working days in March 2026", () => {
    expect(buildMonthDays(3, 2026).filter(d => d.isWorkingDay).length).toBe(22);
  });
});

describe("leaveDatesInMonth", () => {
  it("clips a leave that spans a month boundary", () => {
    // 28 Feb - 3 Mar; only the March part belongs to March.
    const dates = leaveDatesInMonth(
      new Date("2026-02-28T00:00:00Z"),
      new Date("2026-03-03T00:00:00Z"),
      3,
      2026,
      0
    );
    expect([...dates].sort()).toEqual(["2026-03-01", "2026-03-02", "2026-03-03"]);
  });

  it("ignores a leave from a different month entirely", () => {
    const dates = leaveDatesInMonth(
      new Date("2026-01-05T00:00:00Z"),
      new Date("2026-01-09T00:00:00Z"),
      3,
      2026,
      0
    );
    expect(dates.size).toBe(0);
  });

  it("counts a single-day leave as one day", () => {
    const dates = leaveDatesInMonth(
      new Date("2026-03-10T00:00:00Z"),
      new Date("2026-03-10T00:00:00Z"),
      3,
      2026,
      0
    );
    expect([...dates]).toEqual(["2026-03-10"]);
  });

  it("returns nothing when the range is inverted", () => {
    const dates = leaveDatesInMonth(
      new Date("2026-03-10T00:00:00Z"),
      new Date("2026-03-05T00:00:00Z"),
      3,
      2026,
      0
    );
    expect(dates.size).toBe(0);
  });
});

describe("summarizeEmployeeMonth", () => {
  const employee = { id: "u1", name: "Hassan", employeeId: "EMP001", department: "Eng" };

  const entryOn = (date: string, hours: number) => ({
    userId: "u1",
    timeIn: new Date(`${date}T04:00:00Z`), // 09:00 local
    timeOut: new Date(new Date(`${date}T04:00:00Z`).getTime() + hours * 3600_000),
    totalHours: hours,
    status: "completed",
  });

  it("counts present, absent and leave against working days only", () => {
    const summary = summarizeEmployeeMonth({
      employee,
      // Mon 2 Mar and Tue 3 Mar present.
      entries: [entryOn("2026-03-02", 8), entryOn("2026-03-03", 8)],
      // Wed 4 Mar on leave.
      leaveDates: new Set(["2026-03-04"]),
      month: 3,
      year: 2026,
      todayKey: "2026-03-31",
      offsetMinutes: OFFSET,
    });

    expect(summary.workingDays).toBe(22);
    expect(summary.presentDays).toBe(2);
    expect(summary.leaveDays).toBe(1);
    // Everything else in the month is an unexplained working day.
    expect(summary.absentDays).toBe(22 - 2 - 1);
  });

  it("does not count weekends as absent", () => {
    const summary = summarizeEmployeeMonth({
      employee,
      entries: [],
      leaveDates: new Set(),
      month: 3,
      year: 2026,
      todayKey: "2026-03-31",
      offsetMinutes: OFFSET,
    });
    // 31 calendar days, but only the 22 working days can be absent.
    expect(summary.absentDays).toBe(22);
    expect(summary.days.filter(d => d.status === "off")).toHaveLength(9);
  });

  it("does not count future days as absent", () => {
    const summary = summarizeEmployeeMonth({
      employee,
      entries: [entryOn("2026-03-02", 8)],
      leaveDates: new Set(),
      month: 3,
      year: 2026,
      todayKey: "2026-03-03", // mid-month
      offsetMinutes: OFFSET,
    });

    // Working days elapsed by 3 Mar: Mon 2nd and Tue 3rd.
    expect(summary.workingDaysElapsed).toBe(2);
    expect(summary.presentDays).toBe(1);
    expect(summary.absentDays).toBe(1);
    expect(summary.days.filter(d => d.status === "upcoming").length).toBeGreaterThan(0);
  });

  it("totals hours and overtime beyond 8h", () => {
    const summary = summarizeEmployeeMonth({
      employee,
      entries: [entryOn("2026-03-02", 10), entryOn("2026-03-03", 8)],
      leaveDates: new Set(),
      month: 3,
      year: 2026,
      todayKey: "2026-03-31",
      offsetMinutes: OFFSET,
    });

    expect(summary.totalHours).toBe(18);
    expect(summary.overtimeHours).toBe(2);
    expect(summary.averageHours).toBe(9);
  });

  it("flags short days under 6.5h", () => {
    const summary = summarizeEmployeeMonth({
      employee,
      entries: [entryOn("2026-03-02", 5), entryOn("2026-03-03", 8)],
      leaveDates: new Set(),
      month: 3,
      year: 2026,
      todayKey: "2026-03-31",
      offsetMinutes: OFFSET,
    });
    expect(summary.shortDays).toBe(1);
  });

  it("counts a still-open shift as present with a missing clock-out", () => {
    const summary = summarizeEmployeeMonth({
      employee,
      entries: [
        {
          userId: "u1",
          timeIn: new Date("2026-03-02T04:00:00Z"),
          timeOut: null,
          totalHours: null,
          status: "active",
        },
      ],
      leaveDates: new Set(),
      month: 3,
      year: 2026,
      todayKey: "2026-03-31",
      offsetMinutes: OFFSET,
    });

    expect(summary.presentDays).toBe(1);
    expect(summary.missingClockOuts).toBe(1);
    expect(summary.shortDays).toBe(0); // open shift is not a short day
  });

  it("merges multiple entries on one day into a single present day", () => {
    const summary = summarizeEmployeeMonth({
      employee,
      entries: [entryOn("2026-03-02", 4), entryOn("2026-03-02", 4)],
      leaveDates: new Set(),
      month: 3,
      year: 2026,
      todayKey: "2026-03-31",
      offsetMinutes: OFFSET,
    });

    expect(summary.presentDays).toBe(1);
    expect(summary.totalHours).toBe(8);
  });

  it("attributes a late-night clock-in to the local day", () => {
    // 2026-03-02 01:00 local == 2026-03-01 20:00 UTC
    const summary = summarizeEmployeeMonth({
      employee,
      entries: [
        {
          userId: "u1",
          timeIn: new Date("2026-03-01T20:00:00Z"),
          timeOut: new Date("2026-03-02T04:00:00Z"),
          totalHours: 8,
          status: "completed",
        },
      ],
      leaveDates: new Set(),
      month: 3,
      year: 2026,
      todayKey: "2026-03-31",
      offsetMinutes: OFFSET,
    });

    const march2 = summary.days.find(d => d.date === "2026-03-02");
    expect(march2?.status).toBe("present");
    expect(summary.days.find(d => d.date === "2026-03-01")?.status).toBe("off");
  });

  it("keeps a weekend as 'off' even inside a leave range", () => {
    const summary = summarizeEmployeeMonth({
      employee,
      entries: [],
      // 2026-03-01 is a Sunday, 2026-03-02 a Monday.
      leaveDates: new Set(["2026-03-01", "2026-03-02"]),
      month: 3,
      year: 2026,
      todayKey: "2026-03-31",
      offsetMinutes: OFFSET,
    });

    expect(summary.days.find(d => d.date === "2026-03-01")?.status).toBe("off");
    expect(summary.days.find(d => d.date === "2026-03-02")?.status).toBe("leave");
    // Only the Monday counts against the leave tally.
    expect(summary.leaveDays).toBe(1);
  });

  it("does not flag a short weekend shift as a short day", () => {
    const summary = summarizeEmployeeMonth({
      employee,
      // 2026-03-07 is a Saturday.
      entries: [entryOn("2026-03-07", 6)],
      leaveDates: new Set(),
      month: 3,
      year: 2026,
      todayKey: "2026-03-31",
      offsetMinutes: OFFSET,
    });

    expect(summary.presentDays).toBe(1);
    expect(summary.totalHours).toBe(6);
    expect(summary.shortDays).toBe(0);
  });

  it("produces a day row for every day of the month", () => {
    const summary = summarizeEmployeeMonth({
      employee,
      entries: [],
      leaveDates: new Set(),
      month: 2,
      year: 2026,
      todayKey: "2026-12-31",
      offsetMinutes: OFFSET,
    });
    expect(summary.days).toHaveLength(28);
  });
});
