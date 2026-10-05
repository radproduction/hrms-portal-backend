/**
 * Reading what somebody typed to Wingman inside the portal.
 *
 * This is deliberately a small, predictable command reader rather than a
 * language model: every request maps to one named intent, and anything it does
 * not recognise gets the list of things it can do. It never guesses its way
 * into sending something to HR.
 *
 * Pure, so the phrasing it accepts is pinned down by unit tests.
 */
import { addDays, weekdayOf } from "./nowTime";

export type LeaveDraft = {
  leaveType: "annual" | "casual" | "sick";
  /** Office-local "YYYY-MM-DD". */
  startKey: string;
  endKey: string;
  halfDay: "morning" | "afternoon" | null;
};

export type WingmanIntent =
  | { kind: "plate" }
  | { kind: "clock_in" }
  | { kind: "clock_out"; scheduled: boolean }
  | { kind: "break_start" }
  | { kind: "break_end" }
  | { kind: "leave"; draft: LeaveDraft | null }
  | { kind: "overtime" }
  | { kind: "project_health"; project: string }
  | { kind: "standup" }
  | { kind: "support_ticket"; subject: string }
  | { kind: "hours" }
  | { kind: "leave_balance" }
  | { kind: "payslip" }
  | { kind: "help" };

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

function pad(n: number) {
  return String(n).padStart(2, "0");
}

function isRealDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/**
 * Every date mentioned in a sentence, in the order it appears.
 *
 * A bare day and month ("5 Oct") means the next time that date comes round,
 * and a weekday name means the next one after today - asking on a Monday for
 * "Monday" off is next week's, never today's.
 */
export function findDates(text: string, todayKey: string): string[] {
  const lower = text.toLowerCase();
  const found: { index: number; key: string }[] = [];
  const year = Number(todayKey.slice(0, 4));

  for (const match of lower.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
    if (isRealDate(y, m, d)) found.push({ index: match.index!, key: `${y}-${pad(m)}-${pad(d)}` });
  }

  const monthPattern = MONTHS.map(m => `${m}|${m.slice(0, 3)}`).join("|");
  const dayMonth = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${monthPattern})\\b`, "g");
  const monthDay = new RegExp(`\\b(${monthPattern})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, "g");
  const addMonthDate = (index: number, day: number, monthWord: string) => {
    const month = MONTHS.findIndex(m => m.startsWith(monthWord.slice(0, 3))) + 1;
    if (month < 1) return;
    let y = year;
    if (!isRealDate(y, month, day)) return;
    if (`${y}-${pad(month)}-${pad(day)}` < todayKey) y += 1;
    if (!isRealDate(y, month, day)) return;
    found.push({ index, key: `${y}-${pad(month)}-${pad(day)}` });
  };
  for (const match of lower.matchAll(dayMonth)) addMonthDate(match.index!, Number(match[1]), match[2]);
  for (const match of lower.matchAll(monthDay)) addMonthDate(match.index!, Number(match[2]), match[1]);

  for (const match of lower.matchAll(/\b(day after tomorrow|tomorrow|today)\b/g)) {
    const offset = match[1] === "today" ? 0 : match[1] === "tomorrow" ? 1 : 2;
    found.push({ index: match.index!, key: addDays(todayKey, offset) });
  }

  // "Sat" and "sun" are left out as abbreviations: they are ordinary words too.
  const weekdayPattern = WEEKDAYS.map(d => (d === "saturday" || d === "sunday" ? d : `${d}|${d.slice(0, 3)}`)).join("|");
  for (const match of lower.matchAll(new RegExp(`\\b(${weekdayPattern})\\b`, "g"))) {
    const target = WEEKDAYS.findIndex(d => d.startsWith(match[1].slice(0, 3)));
    const ahead = (target - weekdayOf(todayKey) + 7) % 7 || 7;
    found.push({ index: match.index!, key: addDays(todayKey, ahead) });
  }

  found.sort((a, b) => a.index - b.index);
  // "Monday 5 October" names one day twice; keep each date once.
  return [...new Set(found.map(item => item.key))];
}

/**
 * A leave request read out of a sentence, or null when it names no date.
 * The type defaults to casual, which is what a short unplanned day off is.
 */
export function parseLeave(text: string, todayKey: string): LeaveDraft | null {
  const lower = text.toLowerCase();
  const dates = findDates(text, todayKey);
  if (dates.length === 0) return null;

  const leaveType: LeaveDraft["leaveType"] = /\bsick\b|\bunwell\b|\bill\b/.test(lower)
    ? "sick"
    : /\bannual\b|\bvacation\b|\bholiday\b/.test(lower)
      ? "annual"
      : "casual";

  const half = /\bhalf[- ]?day\b|\bhalf a day\b/.test(lower);
  const halfDay: LeaveDraft["halfDay"] = half
    ? /\bafternoon\b|\bsecond half\b|\bevening\b/.test(lower)
      ? "afternoon"
      : "morning"
    : null;

  let startKey = dates[0];
  let endKey = dates.length > 1 ? dates[dates.length - 1] : dates[0];
  if (endKey < startKey) [startKey, endKey] = [endKey, startKey];

  // "3 days from Monday" - a length instead of an end date.
  const length = /\b(\d{1,2})\s+days?\b/.exec(lower);
  if (length && dates.length === 1 && !half) {
    const days = Number(length[1]);
    if (days >= 1 && days <= 60) endKey = addDays(startKey, days - 1);
  }
  // A half day is one day by definition.
  if (half) endKey = startKey;

  return { leaveType, startKey, endKey, halfDay };
}

/** The project somebody is asking after: "how is Now HRMS doing?" -> "now hrms". */
function projectIn(lower: string): string | null {
  const match =
    /\bhow(?:'s| is| are)\s+(?:the\s+)?(.+?)\s+(?:doing|going|looking|project)\b/.exec(lower) ??
    /\b(?:status|health|progress)\s+(?:of|on|for)\s+(?:the\s+)?(.+?)(?:\s+project)?[?.!]*$/.exec(lower);
  if (!match) return null;
  const name = match[1].trim();
  // "How is my day going" is not a project.
  if (!name || /^(my|the|it|everything|things|work)\b/.test(name)) return null;
  return name;
}

/**
 * What the person wants. Order matters: the specific requests are tried before
 * the broad ones, so "apply sick leave for tomorrow" is a leave request and
 * not a question about tomorrow's tasks.
 */
export function parseIntent(text: string, todayKey: string): WingmanIntent {
  const lower = text.toLowerCase().trim();
  if (!lower) return { kind: "help" };

  if (/\b(ticket|it support|support request)\b/.test(lower) || /\b(broken|not working|isn't working|won't turn on)\b/.test(lower)) {
    const subject = text
      .replace(/^.*?\b(?:ticket|support request)\b\s*(?:for|about|to|:|-)?\s*/i, "")
      .trim();
    return { kind: "support_ticket", subject: subject.length >= 4 && subject.length < text.length ? subject : "" };
  }

  if (/\b(leave balance|leave left|leaves left|how many leaves|how much leave|days? off (?:do i have|left))\b/.test(lower)) {
    return { kind: "leave_balance" };
  }

  if (/\b(leave|day off|days off|half[- ]?day|time off)\b/.test(lower) && !/\bleaving\b/.test(lower)) {
    return { kind: "leave", draft: parseLeave(text, todayKey) };
  }

  if (/\bover[- ]?time\b/.test(lower)) return { kind: "overtime" };

  if (/\b(end|stop|finish)\b.*\bbreak\b|\bback from (?:my )?break\b|\bi'?m back\b/.test(lower)) return { kind: "break_end" };
  if (/\bbreak\b/.test(lower)) return { kind: "break_start" };

  if (/\bclock\s*(?:me\s*)?out\b|\bsign(?:ing)?\s*off\b|\bpunch\s*out\b/.test(lower)) {
    // "at 7", "in an hour", "later" - a time in the future, not now.
    const scheduled = /\b(?:at|by|around)\s+\d|\bin\s+(?:an?|\d+)\s+(?:hour|min)|\blater\b/.test(lower);
    return { kind: "clock_out", scheduled };
  }
  if (/\bclock\s*(?:me\s*)?in\b|\bpunch\s*in\b|\bstart my day\b/.test(lower)) return { kind: "clock_in" };

  if (/\bstand[- ]?up\b|\bdaily update\b|\bstatus update\b/.test(lower)) return { kind: "standup" };

  const project = projectIn(lower);
  if (project) return { kind: "project_health", project };

  if (/\b(payslip|pay slip|salary|payday|pay day)\b/.test(lower)) return { kind: "payslip" };

  if (/\b(hours|attendance|timesheet|how long have i|late)\b/.test(lower)) return { kind: "hours" };

  if (/\b(plate|today|tasks?|to[- ]?do|meetings?|agenda|schedule|priorit|what(?:'s| is) (?:next|on))\b/.test(lower)) {
    return { kind: "plate" };
  }

  return { kind: "help" };
}

/** What Wingman can do here, shown whenever it did not understand. */
export const WINGMAN_HELP = [
  "What is on my plate today?",
  "Clock me in / Clock me out",
  "Start my break / End my break",
  "Apply a half day for Monday morning",
  "How much leave do I have left?",
  "How is <project> doing?",
  "Write my standup",
  "Raise a support ticket for <problem>",
  "How are my hours this month?",
];
