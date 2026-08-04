/**
 * Monthly attendance reporting.
 *
 * Everything here is pure (no DB / network) so the date maths can be unit
 * tested, which is where the previous client-side version kept going wrong.
 *
 * Two things are policy, not logic, and are configurable:
 *
 *  REPORT_UTC_OFFSET_MINUTES - the office timezone, used to decide which
 *    calendar day a clock-in belongs to. Times are stored in UTC, so a 1am
 *    local clock-in would otherwise be reported on the previous day. Defaults
 *    to 300 (UTC+5).
 *
 *  WORK_WEEK_DAYS - which weekdays count as working days, 0=Sunday..6=Saturday.
 *    Defaults to 1,2,3,4,5 (Mon-Fri).
 *
 * The 8h / 6.5h thresholds below are not new inventions: they already exist in
 * wingman.ts, which marks a shift "early_out" under 6.5 hours.
 */

export const FULL_DAY_HOURS = 8;
export const SHORT_DAY_HOURS = 6.5;

function parseOffsetMinutes(): number {
  const raw = process.env.REPORT_UTC_OFFSET_MINUTES;
  if (raw === undefined || raw === "") return 300;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 300;
}

function parseWorkWeek(): Set<number> {
  const raw = process.env.WORK_WEEK_DAYS;
  if (!raw) return new Set([1, 2, 3, 4, 5]);
  const days = raw
    .split(",")
    .map(part => Number(part.trim()))
    .filter(day => Number.isInteger(day) && day >= 0 && day <= 6);
  return days.length > 0 ? new Set(days) : new Set([1, 2, 3, 4, 5]);
}

export const OFFSET_MINUTES = parseOffsetMinutes();
export const WORK_WEEK = parseWorkWeek();

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Shifts a UTC instant into office-local time so day/weekday reads correctly. */
function toLocal(date: Date, offsetMinutes = OFFSET_MINUTES): Date {
  return new Date(date.getTime() + offsetMinutes * 60 * 1000);
}

/** "YYYY-MM-DD" for the office-local calendar day an instant falls on. */
export function localDateKey(date: Date, offsetMinutes = OFFSET_MINUTES): string {
  const local = toLocal(date, offsetMinutes);
  const y = local.getUTCFullYear();
  const m = String(local.getUTCMonth() + 1).padStart(2, "0");
  const d = String(local.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** UTC instants bounding an office-local calendar month. */
export function getMonthRange(
  month: number,
  year: number,
  offsetMinutes = OFFSET_MINUTES
): { start: Date; end: Date } {
  const startLocal = Date.UTC(year, month - 1, 1, 0, 0, 0, 0);
  const endLocal = Date.UTC(year, month, 0, 23, 59, 59, 999);
  return {
    start: new Date(startLocal - offsetMinutes * 60 * 1000),
    end: new Date(endLocal - offsetMinutes * 60 * 1000),
  };
}

export type MonthDay = {
  date: string;
  day: number;
  weekday: number;
  isWorkingDay: boolean;
};

export function buildMonthDays(month: number, year: number): MonthDay[] {
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const days: MonthDay[] = [];
  for (let day = 1; day <= daysInMonth; day++) {
    const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    days.push({
      date: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
      day,
      weekday,
      isWorkingDay: WORK_WEEK.has(weekday),
    });
  }
  return days;
}

/**
 * Days of a leave application that actually fall inside the month. A leave
 * spanning a month boundary must only count its overlapping portion; the old
 * report counted every approved leave in full, in every month.
 */
export function leaveDatesInMonth(
  leaveStart: Date,
  leaveEnd: Date,
  month: number,
  year: number,
  offsetMinutes = OFFSET_MINUTES
): Set<string> {
  const dates = new Set<string>();
  if (!leaveStart || !leaveEnd) return dates;

  const startKey = localDateKey(leaveStart, offsetMinutes);
  const endKey = localDateKey(leaveEnd, offsetMinutes);
  if (endKey < startKey) return dates;

  const prefix = `${year}-${String(month).padStart(2, "0")}-`;
  // Walk day by day from the leave's local start date.
  let cursor = Date.parse(`${startKey}T00:00:00Z`);
  const last = Date.parse(`${endKey}T00:00:00Z`);
  // Guard against absurd ranges rather than looping forever on bad data.
  let guard = 0;
  while (cursor <= last && guard < 2000) {
    const key = new Date(cursor).toISOString().slice(0, 10);
    if (key.startsWith(prefix)) dates.add(key);
    cursor += MS_PER_DAY;
    guard += 1;
  }
  return dates;
}

export type RawTimeEntry = {
  userId: string;
  timeIn: Date | string;
  timeOut?: Date | string | null;
  totalHours?: number | null;
  status?: string;
};

export type DayRecord = {
  date: string;
  weekday: number;
  isWorkingDay: boolean;
  status: "present" | "leave" | "absent" | "off" | "upcoming";
  timeIn: string | null;
  timeOut: string | null;
  hours: number;
  missingClockOut: boolean;
};

export type EmployeeMonthSummary = {
  userId: string;
  name: string;
  employeeId: string;
  department: string;
  workingDays: number;
  workingDaysElapsed: number;
  presentDays: number;
  leaveDays: number;
  absentDays: number;
  totalHours: number;
  averageHours: number;
  overtimeHours: number;
  shortDays: number;
  missingClockOuts: number;
  days: DayRecord[];
};

function entryHours(entry: RawTimeEntry): number {
  if (typeof entry.totalHours === "number" && Number.isFinite(entry.totalHours)) {
    return entry.totalHours;
  }
  if (!entry.timeOut) return 0;
  const inMs = new Date(entry.timeIn).getTime();
  const outMs = new Date(entry.timeOut).getTime();
  if (!Number.isFinite(inMs) || !Number.isFinite(outMs) || outMs <= inMs) return 0;
  return (outMs - inMs) / (1000 * 60 * 60);
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function summarizeEmployeeMonth(input: {
  employee: { id: string; name?: string; employeeId?: string; department?: string };
  entries: RawTimeEntry[];
  leaveDates: Set<string>;
  month: number;
  year: number;
  /** "Today" in office-local terms, so future days are not counted absent. */
  todayKey: string;
  offsetMinutes?: number;
}): EmployeeMonthSummary {
  const { employee, entries, leaveDates, month, year, todayKey } = input;
  const offsetMinutes = input.offsetMinutes ?? OFFSET_MINUTES;

  // Group this employee's entries by the office-local day they started on.
  const byDate = new Map<string, RawTimeEntry[]>();
  for (const entry of entries) {
    const key = localDateKey(new Date(entry.timeIn), offsetMinutes);
    const list = byDate.get(key);
    if (list) list.push(entry);
    else byDate.set(key, [entry]);
  }

  const days: DayRecord[] = [];
  let presentDays = 0;
  let leaveDays = 0;
  let absentDays = 0;
  let totalHours = 0;
  let overtimeHours = 0;
  let shortDays = 0;
  let missingClockOuts = 0;
  let workingDays = 0;
  let workingDaysElapsed = 0;

  for (const meta of buildMonthDays(month, year)) {
    if (meta.isWorkingDay) workingDays += 1;
    const isFuture = meta.date > todayKey;
    if (meta.isWorkingDay && !isFuture) workingDaysElapsed += 1;

    const dayEntries = byDate.get(meta.date) ?? [];
    const dayHours = dayEntries.reduce((sum, e) => sum + entryHours(e), 0);
    const openEntries = dayEntries.filter(e => !e.timeOut || e.status === "active").length;

    let status: DayRecord["status"];
    if (dayEntries.length > 0) {
      status = "present";
      presentDays += 1;
      totalHours += dayHours;
      if (dayHours > FULL_DAY_HOURS) overtimeHours += dayHours - FULL_DAY_HOURS;
      // Only a working day can fall short; nobody owes hours on a weekend.
      if (
        meta.isWorkingDay &&
        openEntries === 0 &&
        dayHours > 0 &&
        dayHours < SHORT_DAY_HOURS
      ) {
        shortDays += 1;
      }
      missingClockOuts += openEntries;
    } else if (!meta.isWorkingDay) {
      // A weekend stays a weekend even when a leave range spans it, otherwise
      // the muster roll shows "L" on Sundays.
      status = "off";
    } else if (leaveDates.has(meta.date)) {
      status = "leave";
      leaveDays += 1;
    } else if (isFuture) {
      status = "upcoming";
    } else {
      status = "absent";
      absentDays += 1;
    }

    const first = dayEntries
      .slice()
      .sort((a, b) => new Date(a.timeIn).getTime() - new Date(b.timeIn).getTime())[0];
    const lastOut = dayEntries
      .filter(e => e.timeOut)
      .sort(
        (a, b) => new Date(b.timeOut as string).getTime() - new Date(a.timeOut as string).getTime()
      )[0];

    days.push({
      date: meta.date,
      weekday: meta.weekday,
      isWorkingDay: meta.isWorkingDay,
      status,
      timeIn: first ? new Date(first.timeIn).toISOString() : null,
      timeOut: lastOut?.timeOut ? new Date(lastOut.timeOut).toISOString() : null,
      hours: round1(dayHours),
      missingClockOut: openEntries > 0,
    });
  }

  return {
    userId: employee.id,
    name: employee.name || employee.employeeId || "Employee",
    employeeId: employee.employeeId || "",
    department: employee.department || "",
    workingDays,
    workingDaysElapsed,
    presentDays,
    leaveDays,
    absentDays,
    totalHours: round1(totalHours),
    averageHours: presentDays > 0 ? round1(totalHours / presentDays) : 0,
    overtimeHours: round1(overtimeHours),
    shortDays,
    missingClockOuts,
    days,
  };
}
