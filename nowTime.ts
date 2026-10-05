/**
 * The employee's own view of their time: the last few weeks day by day, and
 * how much leave is left.
 *
 * Pure, like attendance.ts, so the date maths is unit tested. It reuses that
 * file's office timezone, working week and hour thresholds rather than
 * restating them.
 *
 * Three things here are policy and configurable:
 *
 *  SHIFT_START_TIME - "HH:MM" office-local, when the day starts. Default 10:00.
 *  LATE_GRACE_MINUTES - minutes after the start that still count as on time.
 *    Default 15.
 *  LEAVE_QUOTA_ANNUAL / LEAVE_QUOTA_CASUAL / LEAVE_QUOTA_SICK - days a year.
 *    Defaults 14 / 10 / 8.
 */
import {
  MAX_SHIFT_HOURS,
  OFFSET_MINUTES,
  SHORT_DAY_HOURS,
  WORK_WEEK,
  localDateKey,
} from "./attendance";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function parseShiftStartMinutes(): number {
  const raw = process.env.SHIFT_START_TIME ?? "";
  const match = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!match) return 10 * 60;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return 10 * 60;
  return hours * 60 + minutes;
}

function parseNonNegative(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export const SHIFT_START_MINUTES = parseShiftStartMinutes();
export const LATE_GRACE_MINUTES = parseNonNegative(process.env.LATE_GRACE_MINUTES, 15);

export const LEAVE_QUOTAS = {
  annual: parseNonNegative(process.env.LEAVE_QUOTA_ANNUAL, 14),
  casual: parseNonNegative(process.env.LEAVE_QUOTA_CASUAL, 10),
  sick: parseNonNegative(process.env.LEAVE_QUOTA_SICK, 8),
} as const;

export type QuotaLeaveType = keyof typeof LEAVE_QUOTAS;

/** "YYYY-MM-DD" plus or minus whole days. */
export function addDays(dateKey: string, days: number): string {
  return new Date(Date.parse(`${dateKey}T00:00:00Z`) + days * MS_PER_DAY).toISOString().slice(0, 10);
}

/** 0=Sunday..6=Saturday for a "YYYY-MM-DD" key. */
export function weekdayOf(dateKey: string): number {
  return new Date(`${dateKey}T00:00:00Z`).getUTCDay();
}

/** The UTC instant at which an office-local calendar day starts. */
export function localDayStart(dateKey: string, offsetMinutes = OFFSET_MINUTES): Date {
  return new Date(Date.parse(`${dateKey}T00:00:00Z`) - offsetMinutes * 60 * 1000);
}

/** Minutes past office-local midnight for an instant. */
function localMinutes(date: Date, offsetMinutes: number): number {
  const local = new Date(date.getTime() + offsetMinutes * 60 * 1000);
  return local.getUTCHours() * 60 + local.getUTCMinutes();
}

/** "HH:MM" in office-local time. */
export function localClock(date: Date, offsetMinutes = OFFSET_MINUTES): string {
  const minutes = localMinutes(date, offsetMinutes);
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** Every calendar day a leave covers, as office-local keys. */
export function leaveDateKeys(start: Date, end: Date, offsetMinutes = OFFSET_MINUTES): string[] {
  const startKey = localDateKey(new Date(start), offsetMinutes);
  const endKey = localDateKey(new Date(end), offsetMinutes);
  const keys: string[] = [];
  // Guarded so a bad record cannot loop for ever.
  for (let key = startKey, guard = 0; key <= endKey && guard < 730; key = addDays(key, 1), guard += 1) {
    keys.push(key);
  }
  return keys;
}

export type TimeEntryInput = {
  timeIn: Date | string;
  timeOut?: Date | string | null;
  totalHours?: number | null;
  status?: string;
  autoClockedOut?: boolean;
};

export type LeaveInput = {
  leaveType: string;
  startDate: Date | string;
  endDate: Date | string;
  status: string;
};

export type TimeDayKind = "ok" | "late" | "leave" | "fix" | "today" | "absent" | "upcoming";

export type TimeDay = {
  date: string;
  kind: TimeDayKind;
  /** Hours worked, or null when there is nothing usable to show. */
  hours: number | null;
  timeIn: string | null;
  timeOut: string | null;
  /** Short reason shown under the hours: "Late, 10:42", "No clock-out", "Annual". */
  note: string;
};

export type FourWeekSummary = {
  from: string;
  to: string;
  days: TimeDay[];
  stats: {
    workingDays: number;
    daysPresent: number;
    averageHours: number;
    lateArrivals: number;
    earlyOuts: number;
    overtimeHours: number;
  };
  /** Days whose record needs a person to fix it, oldest first. */
  toFix: { date: string; reason: string }[];
};

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * The last `weeks` working weeks, ending with the current one.
 *
 * A day needs fixing when it was clocked into and never properly clocked out
 * of: still open on a later day, closed by the shift sweep, or so long that the
 * hours cannot be real. Those are exactly the records payroll cannot use.
 */
export function buildFourWeeks(input: {
  entries: TimeEntryInput[];
  leaves: LeaveInput[];
  overtime: { workDate: Date | string; hours: number }[];
  now: Date;
  weeks?: number;
  offsetMinutes?: number;
  workWeek?: Set<number>;
  shiftStartMinutes?: number;
  lateGraceMinutes?: number;
  maxShiftHours?: number;
}): FourWeekSummary {
  const offsetMinutes = input.offsetMinutes ?? OFFSET_MINUTES;
  const workWeek = input.workWeek ?? WORK_WEEK;
  const weeks = input.weeks ?? 4;
  const lateAfter =
    (input.shiftStartMinutes ?? SHIFT_START_MINUTES) + (input.lateGraceMinutes ?? LATE_GRACE_MINUTES);
  const maxShiftHours = input.maxShiftHours ?? MAX_SHIFT_HOURS;

  const todayKey = localDateKey(input.now, offsetMinutes);
  // Weeks run Monday to Sunday.
  const sinceMonday = (weekdayOf(todayKey) + 6) % 7;
  const from = addDays(todayKey, -sinceMonday - (weeks - 1) * 7);
  const to = addDays(from, weeks * 7 - 1);

  const byDate = new Map<string, TimeEntryInput[]>();
  for (const entry of input.entries) {
    const key = localDateKey(new Date(entry.timeIn), offsetMinutes);
    const list = byDate.get(key);
    if (list) list.push(entry);
    else byDate.set(key, [entry]);
  }

  const leaveByDate = new Map<string, string>();
  for (const leave of input.leaves) {
    if (leave.status !== "approved") continue;
    for (const key of leaveDateKeys(new Date(leave.startDate), new Date(leave.endDate), offsetMinutes)) {
      leaveByDate.set(key, leave.leaveType);
    }
  }

  const overtimeByDate = new Map<string, number>();
  let overtimeHours = 0;
  for (const item of input.overtime) {
    const key = localDateKey(new Date(item.workDate), offsetMinutes);
    if (key < from || key > to) continue;
    overtimeByDate.set(key, (overtimeByDate.get(key) ?? 0) + item.hours);
    overtimeHours += item.hours;
  }

  const days: TimeDay[] = [];
  const toFix: { date: string; reason: string }[] = [];
  let workingDays = 0;
  let daysPresent = 0;
  let lateArrivals = 0;
  let earlyOuts = 0;
  let hoursTotal = 0;
  let daysWithHours = 0;

  for (let key = from; key <= to; key = addDays(key, 1)) {
    const entries = (byDate.get(key) ?? [])
      .slice()
      .sort((a, b) => new Date(a.timeIn).getTime() - new Date(b.timeIn).getTime());
    const isWorkingDay = workWeek.has(weekdayOf(key));
    // A weekend only appears when somebody actually worked it.
    if (!isWorkingDay && entries.length === 0) continue;

    if (key > todayKey) {
      days.push({ date: key, kind: "upcoming", hours: null, timeIn: null, timeOut: null, note: "" });
      continue;
    }
    if (isWorkingDay) workingDays += 1;

    if (entries.length === 0) {
      const leaveType = leaveByDate.get(key);
      if (leaveType) {
        days.push({
          date: key,
          kind: "leave",
          hours: null,
          timeIn: null,
          timeOut: null,
          note: leaveType.charAt(0).toUpperCase() + leaveType.slice(1),
        });
      } else if (key === todayKey) {
        days.push({ date: key, kind: "today", hours: null, timeIn: null, timeOut: null, note: "Not clocked in yet" });
      } else {
        days.push({ date: key, kind: "absent", hours: null, timeIn: null, timeOut: null, note: "No record" });
      }
      continue;
    }

    daysPresent += 1;
    const first = new Date(entries[0].timeIn);
    const firstClock = localClock(first, offsetMinutes);
    const late = isWorkingDay && localMinutes(first, offsetMinutes) > lateAfter;
    if (late) lateArrivals += 1;

    let hours = 0;
    let lastOut: Date | null = null;
    let open = false;
    let unusable = "";
    for (const entry of entries) {
      const timeIn = new Date(entry.timeIn);
      const timeOut = entry.timeOut ? new Date(entry.timeOut) : null;
      if (!timeOut) {
        open = true;
        continue;
      }
      if (!lastOut || timeOut > lastOut) lastOut = timeOut;
      const worked =
        typeof entry.totalHours === "number" && Number.isFinite(entry.totalHours)
          ? entry.totalHours
          : (timeOut.getTime() - timeIn.getTime()) / (1000 * 60 * 60);
      if (entry.autoClockedOut) unusable = "No clock-out";
      else if (worked > maxShiftHours) unusable = "Hours look wrong";
      else if (worked > 0) hours += worked;
    }

    const overtimeNote = overtimeByDate.has(key) ? `+${round1(overtimeByDate.get(key)!)} overtime` : "";

    if (key === todayKey && open) {
      // Still at work: show the running total so far, never a problem.
      const running = hours + (input.now.getTime() - new Date(entries[entries.length - 1].timeIn).getTime()) / 3600000;
      days.push({
        date: key,
        kind: "today",
        hours: round1(Math.max(0, running)),
        timeIn: firstClock,
        timeOut: null,
        note: `Today, in at ${firstClock}`,
      });
      continue;
    }

    if (open || unusable) {
      const reason = open ? "No clock-out" : unusable;
      days.push({ date: key, kind: "fix", hours: null, timeIn: firstClock, timeOut: null, note: reason });
      toFix.push({ date: key, reason });
      continue;
    }

    hoursTotal += hours;
    daysWithHours += 1;
    if (isWorkingDay && hours < SHORT_DAY_HOURS) earlyOuts += 1;

    days.push({
      date: key,
      kind: key === todayKey ? "today" : late ? "late" : "ok",
      hours: round1(hours),
      timeIn: firstClock,
      timeOut: lastOut ? localClock(lastOut, offsetMinutes) : null,
      note: late ? `Late, ${firstClock}` : overtimeNote,
    });
  }

  return {
    from,
    to,
    days,
    stats: {
      workingDays,
      daysPresent,
      averageHours: daysWithHours > 0 ? round1(hoursTotal / daysWithHours) : 0,
      lateArrivals,
      earlyOuts,
      overtimeHours: round1(overtimeHours),
    },
    toFix,
  };
}

export type LeaveBalanceRow = {
  type: QuotaLeaveType;
  quota: number;
  used: number;
  pending: number;
  left: number;
};

/**
 * Leave used and left for one calendar year.
 *
 * Only working days count against the quota: a leave from Friday to Monday is
 * two days, not four. A leave that crosses New Year counts only the days that
 * fall inside the year asked for.
 */
export function buildLeaveBalance(input: {
  leaves: LeaveInput[];
  year: number;
  quotas?: Record<QuotaLeaveType, number>;
  offsetMinutes?: number;
  workWeek?: Set<number>;
}): LeaveBalanceRow[] {
  const offsetMinutes = input.offsetMinutes ?? OFFSET_MINUTES;
  const workWeek = input.workWeek ?? WORK_WEEK;
  const quotas = input.quotas ?? LEAVE_QUOTAS;
  const prefix = `${input.year}-`;

  const used: Record<string, number> = {};
  const pending: Record<string, number> = {};
  for (const leave of input.leaves) {
    if (leave.status !== "approved" && leave.status !== "pending") continue;
    const days = leaveDateKeys(new Date(leave.startDate), new Date(leave.endDate), offsetMinutes).filter(
      key => key.startsWith(prefix) && workWeek.has(weekdayOf(key))
    ).length;
    const bucket = leave.status === "approved" ? used : pending;
    bucket[leave.leaveType] = (bucket[leave.leaveType] ?? 0) + days;
  }

  return (Object.keys(quotas) as QuotaLeaveType[]).map(type => ({
    type,
    quota: quotas[type],
    used: used[type] ?? 0,
    pending: pending[type] ?? 0,
    left: Math.max(0, quotas[type] - (used[type] ?? 0)),
  }));
}
