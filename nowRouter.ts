/**
 * APIs behind the Now workspace screens that had nothing to call before:
 *
 *  requests - attendance corrections and support tickets. (Leave, overtime,
 *    grievance, feedback and resignation already have their own procedures.)
 *  time     - the employee's last four weeks and their leave balance.
 *  wingman  - Wingman inside the portal: settings, what it is watching, and a
 *    chat that carries out simple requests.
 *
 * Mounted on the app router alongside the existing routers; nothing that was
 * there before is changed.
 */
import { TRPCError } from "@trpc/server";
import { Types } from "mongoose";
import { z } from "zod";
import * as db from "./db";
import { protectedProcedure, router } from "./_core/trpc";
import { emitNotification } from "./_core/realtime";
import { connectToMongoDB } from "./mongodb";
import { TimeEntry, User } from "./models";
import { EmployeeRequest, WingmanMessage, WingmanSettings } from "./nowModels";
import { MAX_SHIFT_HOURS, localDateKey } from "./attendance";
import { isOrgWide } from "./roles";
import { routeLeaveFor } from "./leaveRouting";
import { clockInUser, clockOutUser, WorkClockError } from "./wingman";
import {
  addDays,
  buildFourWeeks,
  buildLeaveBalance,
  localClock,
  localDayStart,
  weekdayOf,
} from "./nowTime";
import { parseIntent, WINGMAN_HELP, type LeaveDraft } from "./wingmanChat";

async function requireDb() {
  if (!(await connectToMongoDB())) {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });
  }
}

function toObjectId(id: string) {
  if (!Types.ObjectId.isValid(id)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid id" });
  }
  return new Types.ObjectId(id);
}

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Mon 5 Oct" for a "YYYY-MM-DD" key. */
function dayLabel(dateKey: string) {
  return `${WEEKDAY_SHORT[weekdayOf(dateKey)]} ${Number(dateKey.slice(8, 10))} ${MONTH_SHORT[Number(dateKey.slice(5, 7)) - 1]}`;
}

function plainRequest(doc: any) {
  return {
    id: String(doc._id),
    userId: String(doc.userId?._id ?? doc.userId),
    kind: doc.kind as "attendance_correction" | "support_ticket",
    subject: doc.subject as string,
    details: (doc.details ?? "") as string,
    workDate: (doc.workDate ?? null) as Date | null,
    requestedTimeIn: (doc.requestedTimeIn ?? null) as Date | null,
    requestedTimeOut: (doc.requestedTimeOut ?? null) as Date | null,
    category: (doc.category ?? null) as string | null,
    status: doc.status as "pending" | "approved" | "rejected" | "resolved",
    reviewNote: (doc.reviewNote ?? "") as string,
    reviewedAt: (doc.reviewedAt ?? null) as Date | null,
    appliedToAttendance: Boolean(doc.appliedToAttendance),
    createdAt: doc.createdAt as Date,
  };
}

/** Tells one person something in the app. A failed ping never fails the action. */
async function notify(userId: string, title: string, message: string, relatedType: string) {
  try {
    await db.createNotification({ userId, type: "system_alert", title, message, priority: "medium", relatedType });
    emitNotification({ userId });
  } catch (error) {
    console.error("[Now] could not send a notification", error instanceof Error ? error.name : "unknown error");
  }
}

/** Everything the time screens need for one person, read once. */
async function loadTimeData(userId: string, now: Date) {
  // Six weeks back covers the four shown plus leaves that started earlier.
  const start = new Date(now.getTime() - 45 * 24 * 60 * 60 * 1000);
  const [entries, leaves, overtime] = await Promise.all([
    db.getTimeEntriesByDateRange(userId, start, now),
    db.getLeaveApplicationsByUser(userId),
    db.getOvertimeEntriesByDateRange(userId, start, now),
  ]);
  return { entries: entries as any[], leaves: leaves as any[], overtime: overtime as any[] };
}

async function createEmployeeRequest(input: {
  userId: string;
  userName: string;
  kind: "attendance_correction" | "support_ticket";
  subject: string;
  details?: string;
  workDate?: Date;
  requestedTimeIn?: Date;
  requestedTimeOut?: Date;
  category?: "it" | "equipment" | "portal" | "other";
}) {
  await requireDb();
  // Same routing as leave: the department head, or whoever is above them.
  const routing = await routeLeaveFor(input.userId);
  const created = await EmployeeRequest.create({
    userId: toObjectId(input.userId),
    kind: input.kind,
    subject: input.subject,
    details: input.details,
    workDate: input.workDate,
    requestedTimeIn: input.requestedTimeIn,
    requestedTimeOut: input.requestedTimeOut,
    category: input.category,
    approverUserId: routing.approverId ? toObjectId(routing.approverId) : undefined,
  });
  if (routing.approverId) {
    await notify(
      routing.approverId,
      input.kind === "support_ticket" ? "Support ticket to review" : "Attendance correction to review",
      `${input.userName}: ${input.subject}`,
      "request"
    );
  }
  return { request: plainRequest(created), routedTo: routing.reason };
}

async function submitLeaveDraft(userId: string, userName: string, draft: LeaveDraft) {
  const routing = await routeLeaveFor(userId);
  const half = draft.halfDay ? `Half day (${draft.halfDay}). ` : "";
  await db.createLeaveApplication({
    userId,
    leaveType: draft.leaveType,
    startDate: localDayStart(draft.startKey),
    endDate: localDayStart(draft.endKey),
    reason: `${half}Requested through Wingman.`,
    approverUserId: routing.approverId,
  });
  if (routing.approverId) {
    const dates = draft.startKey === draft.endKey ? dayLabel(draft.startKey) : `${dayLabel(draft.startKey)} - ${dayLabel(draft.endKey)}`;
    try {
      await db.createNotification({
        userId: routing.approverId,
        type: "announcement",
        title: "Leave request to review",
        message: `${userName} requested ${draft.leaveType} leave for ${dates}.`,
        priority: "medium",
        relatedType: "leave",
      });
      emitNotification({ userId: routing.approverId });
    } catch (error) {
      console.error("[Now] could not notify the leave approver", error instanceof Error ? error.name : "unknown error");
    }
  }
  return routing.reason;
}

// ---------------------------------------------------------------- requests

export const requestsRouter = router({
  create: protectedProcedure
    .input(
      z
        .object({
          kind: z.enum(["attendance_correction", "support_ticket"]),
          subject: z.string().trim().min(3).max(160),
          details: z.string().trim().max(2000).optional(),
          workDate: z.date().optional(),
          requestedTimeIn: z.date().optional(),
          requestedTimeOut: z.date().optional(),
          category: z.enum(["it", "equipment", "portal", "other"]).optional(),
        })
        .superRefine((value, ctx) => {
          if (value.kind !== "attendance_correction") return;
          if (!value.workDate) {
            ctx.addIssue({ code: "custom", message: "Choose the day to correct", path: ["workDate"] });
          }
          if (!value.requestedTimeIn && !value.requestedTimeOut) {
            ctx.addIssue({ code: "custom", message: "Give the clock-in or clock-out time", path: ["requestedTimeOut"] });
          }
          if (value.requestedTimeIn && value.requestedTimeOut && value.requestedTimeOut <= value.requestedTimeIn) {
            ctx.addIssue({ code: "custom", message: "Clock-out must be after clock-in", path: ["requestedTimeOut"] });
          }
          if (value.workDate && value.workDate.getTime() > Date.now()) {
            ctx.addIssue({ code: "custom", message: "That day has not happened yet", path: ["workDate"] });
          }
        })
    )
    .mutation(async ({ input, ctx }) => {
      const result = await createEmployeeRequest({
        ...input,
        userId: ctx.user.id,
        userName: ctx.user.name ?? "An employee",
      });
      return { success: true, ...result };
    }),

  getMine: protectedProcedure.query(async ({ ctx }) => {
    if (!(await connectToMongoDB())) return [];
    const list = await EmployeeRequest.find({ userId: toObjectId(ctx.user.id) }).sort({ createdAt: -1 }).lean();
    return list.map(plainRequest);
  }),

  /** Requests the caller is responsible for: everything if org-wide, else those routed to them. */
  getForReview: protectedProcedure.query(async ({ ctx }) => {
    await requireDb();
    const filter = isOrgWide(ctx.user.role) ? {} : { approverUserId: toObjectId(ctx.user.id) };
    const list = await EmployeeRequest.find(filter).sort({ createdAt: -1 }).populate("userId").lean();
    return list.map((doc: any) => ({
      ...plainRequest(doc),
      user: doc.userId
        ? {
            id: String(doc.userId._id),
            name: doc.userId.name ?? "",
            employeeId: doc.userId.employeeId ?? "",
            department: doc.userId.department ?? "",
          }
        : null,
    }));
  }),

  review: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        status: z.enum(["approved", "rejected", "resolved"]),
        note: z.string().trim().max(1000).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      await requireDb();
      const request = await EmployeeRequest.findById(toObjectId(input.id));
      if (!request) throw new TRPCError({ code: "NOT_FOUND", message: "Request not found" });

      const isApprover = request.approverUserId && String(request.approverUserId) === ctx.user.id;
      if (!isOrgWide(ctx.user.role) && !isApprover) {
        throw new TRPCError({ code: "FORBIDDEN", message: "This request was not sent to you" });
      }
      // Nobody signs off their own correction, whatever their role.
      if (String(request.userId) === ctx.user.id) {
        throw new TRPCError({ code: "FORBIDDEN", message: "You cannot review your own request" });
      }
      if (request.status !== "pending") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "This request has already been closed" });
      }
      if (request.kind === "attendance_correction" && input.status === "resolved") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Approve or reject an attendance correction" });
      }
      if (request.kind === "support_ticket" && input.status === "approved") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Resolve or reject a support ticket" });
      }

      let applied = false;
      if (request.kind === "attendance_correction" && input.status === "approved" && request.workDate) {
        applied = await applyAttendanceCorrection({
          userId: String(request.userId),
          workDate: request.workDate,
          timeIn: request.requestedTimeIn ?? undefined,
          timeOut: request.requestedTimeOut ?? undefined,
          reviewerName: ctx.user.name ?? "a manager",
        });
      }

      request.status = input.status;
      request.reviewedBy = toObjectId(ctx.user.id);
      request.reviewedAt = new Date();
      request.reviewNote = input.note;
      request.appliedToAttendance = applied;
      await request.save();

      await notify(
        String(request.userId),
        `Request ${input.status}`,
        `${request.subject}${input.note ? ` - ${input.note}` : ""}`,
        "request"
      );
      return { success: true, appliedToAttendance: applied };
    }),
});

/**
 * Writes an approved correction onto the attendance record for that day.
 *
 * Corrects the day's existing entry when there is one, so a forgotten
 * clock-out is closed rather than a second, overlapping shift created. Only
 * when the day has no entry at all, and both times were given, is a new one
 * made. Returns false when there was nothing it could safely write.
 */
async function applyAttendanceCorrection(input: {
  userId: string;
  workDate: Date;
  timeIn?: Date;
  timeOut?: Date;
  reviewerName: string;
}): Promise<boolean> {
  const dayKey = localDateKey(input.workDate);
  const dayStart = localDayStart(dayKey);
  const dayEnd = localDayStart(addDays(dayKey, 1));
  const note = `Corrected on request, approved by ${input.reviewerName}.`;

  const existing = await TimeEntry.findOne({
    userId: toObjectId(input.userId),
    timeIn: { $gte: dayStart, $lt: dayEnd },
  }).sort({ timeIn: 1 });

  const timeIn = input.timeIn ?? existing?.timeIn;
  const timeOut = input.timeOut ?? existing?.timeOut;
  if (!timeIn || !timeOut) return false;

  const totalHours = (timeOut.getTime() - timeIn.getTime()) / (1000 * 60 * 60);
  if (!(totalHours > 0) || totalHours > MAX_SHIFT_HOURS) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Those times do not make a valid shift. Reject this and ask for a corrected request.",
    });
  }
  const fields = {
    timeIn,
    timeOut,
    totalHours: Number(totalHours.toFixed(2)),
    status: totalHours < 6.5 ? "early_out" : "completed",
    autoClockedOut: false,
  } as const;

  if (existing) {
    existing.set({ ...fields, notes: existing.notes ? `${existing.notes} ${note}` : note });
    await existing.save();
  } else {
    await TimeEntry.create({ ...fields, userId: toObjectId(input.userId), notes: note });
  }
  return true;
}

// -------------------------------------------------------------------- time

export const timeRouter = router({
  getFourWeeks: protectedProcedure.query(async ({ ctx }) => {
    const now = new Date();
    const data = await loadTimeData(ctx.user.id, now);
    return buildFourWeeks({ ...data, now });
  }),

  getLeaveBalance: protectedProcedure.query(async ({ ctx }) => {
    const leaves = (await db.getLeaveApplicationsByUser(ctx.user.id)) as any[];
    const year = Number(localDateKey(new Date()).slice(0, 4));
    return { year, rows: buildLeaveBalance({ leaves, year }) };
  }),
});

// ----------------------------------------------------------------- wingman

const DEFAULT_SETTINGS = { askBeforeSending: true, morningBrief: true, clockOutReminder: true, whatsapp: false };

async function readSettings(userId: string) {
  if (!(await connectToMongoDB())) return DEFAULT_SETTINGS;
  const found = await WingmanSettings.findOne({ userId: toObjectId(userId) }).lean();
  return {
    askBeforeSending: found?.askBeforeSending ?? DEFAULT_SETTINGS.askBeforeSending,
    morningBrief: found?.morningBrief ?? DEFAULT_SETTINGS.morningBrief,
    clockOutReminder: found?.clockOutReminder ?? DEFAULT_SETTINGS.clockOutReminder,
    whatsapp: found?.whatsapp ?? DEFAULT_SETTINGS.whatsapp,
  };
}

type TaskRow = { title: string; project: string; due: Date | null; overdue: boolean; dueToday: boolean; done: boolean; completedAt: Date | null };

async function loadTasks(userId: string, now: Date): Promise<TaskRow[]> {
  const todayKey = localDateKey(now);
  const tasks = (await db.getTasksByEmployee(userId)) as any[];
  return tasks.map(task => {
    const due = task.completionDate ? new Date(task.completionDate) : null;
    const dueKey = due ? localDateKey(due) : null;
    const done = task.status === "completed";
    return {
      title: String(task.title ?? "Untitled task"),
      project: String(task.project?.name ?? "No project"),
      due,
      overdue: !done && dueKey !== null && dueKey < todayKey,
      dueToday: !done && dueKey === todayKey,
      done,
      completedAt: task.completedAt ? new Date(task.completedAt) : null,
    };
  });
}

async function loadMeetingsToday(userId: string, now: Date) {
  const todayKey = localDateKey(now);
  const meetings = (await db.getMeetingsByUserId(userId)) as any[];
  return meetings
    .filter(meeting => meeting.startTime && localDateKey(new Date(meeting.startTime)) === todayKey)
    .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime())
    .map(meeting => ({ title: String(meeting.title ?? "Meeting"), at: localClock(new Date(meeting.startTime)) }));
}

type Reply = {
  text: string;
  items?: { label: string; meta?: string; tone?: "plain" | "warn" | "muted" }[];
  link?: { label: string; href: string };
  action?: {
    kind: "leave" | "support_ticket";
    title: string;
    detail: string;
    payload: Record<string, unknown>;
    status: "ready" | "sent" | "cancelled";
  };
};

function describeLeave(draft: LeaveDraft, left: number | null) {
  const when = draft.startKey === draft.endKey ? dayLabel(draft.startKey) : `${dayLabel(draft.startKey)} to ${dayLabel(draft.endKey)}`;
  const part = draft.halfDay ? `half day, ${draft.halfDay}` : draft.startKey === draft.endKey ? "full day" : "full days";
  const type = draft.leaveType.charAt(0).toUpperCase() + draft.leaveType.slice(1);
  return [when, part, type, left === null ? "" : `${left} ${type.toLowerCase()} days left before this`].filter(Boolean).join(" · ");
}

/** Works out the answer to one message. Anything that changes data is named in the reply. */
async function answer(user: { id: string; name?: string | null }, text: string, now: Date): Promise<Reply> {
  const todayKey = localDateKey(now);
  const intent = parseIntent(text, todayKey);
  const userName = user.name ?? "An employee";

  switch (intent.kind) {
    case "plate": {
      const [tasks, meetings] = await Promise.all([loadTasks(user.id, now), loadMeetingsToday(user.id, now)]);
      const open = tasks.filter(task => !task.done);
      const first = [...open.filter(t => t.overdue), ...open.filter(t => t.dueToday), ...open.filter(t => !t.overdue && !t.dueToday)].slice(0, 6);
      if (open.length === 0 && meetings.length === 0) {
        return { text: "Nothing is waiting on you today: no open tasks and no meetings." };
      }
      const overdue = open.filter(t => t.overdue).length;
      return {
        text: `${open.length} open ${open.length === 1 ? "task" : "tasks"} and ${meetings.length} ${meetings.length === 1 ? "meeting" : "meetings"} today.${overdue ? ` ${overdue} ${overdue === 1 ? "is" : "are"} past the due date, so start there.` : ""}`,
        items: [
          ...meetings.map(m => ({ label: m.title, meta: m.at, tone: "plain" as const })),
          ...first.map(t => ({
            label: t.title,
            meta: t.overdue ? "Overdue" : t.dueToday ? "Today" : t.project,
            tone: t.overdue ? ("warn" as const) : ("muted" as const),
          })),
        ],
        link: { label: "Open the board", href: "/board" },
      };
    }

    case "clock_in":
      try {
        await clockInUser(user.id, { at: now });
        return { text: `You are clocked in at ${localClock(now)}.` };
      } catch (error) {
        if (error instanceof WorkClockError) return { text: error.message + "." };
        throw error;
      }

    case "clock_out": {
      if (intent.scheduled) {
        return {
          text: "I cannot clock you out at a later time yet, only right now. Ask me again when you are leaving, or use Clock out on Home.",
          link: { label: "Go to Home", href: "/dashboard" },
        };
      }
      try {
        const result = await clockOutUser(user.id, { at: now });
        return { text: `You are clocked out at ${localClock(now)}. ${result.totalHours} hours today.` };
      } catch (error) {
        if (error instanceof WorkClockError) return { text: "You are not clocked in, so there is nothing to clock out of." };
        throw error;
      }
    }

    case "break_start": {
      const active = (await db.getActiveTimeEntry(user.id)) as { id: string } | undefined;
      if (!active) return { text: "You are not clocked in, so I cannot start a break." };
      if (await db.getActiveBreak(active.id)) return { text: "A break is already running. Say \"end my break\" when you are back." };
      await db.createBreakLog({ timeEntryId: active.id, userId: user.id, breakStart: now, reason: "Outgoing" });
      return { text: `Break started at ${localClock(now)}. Say "end my break" when you are back.` };
    }

    case "break_end": {
      const active = (await db.getActiveTimeEntry(user.id)) as { id: string } | undefined;
      const running = active ? ((await db.getActiveBreak(active.id)) as { id: string; breakStart: Date } | undefined) : undefined;
      if (!running) return { text: "There is no break running." };
      const minutes = Math.floor((now.getTime() - new Date(running.breakStart).getTime()) / 60000);
      await db.updateBreakLog(running.id, { breakEnd: now, duration: minutes });
      return { text: `Break ended. ${minutes} ${minutes === 1 ? "minute" : "minutes"}.` };
    }

    case "leave": {
      if (!intent.draft) {
        return {
          text: "Which day? Try \"apply a half day for Monday morning\" or \"sick leave tomorrow\".",
          link: { label: "Open Time", href: "/attendance" },
        };
      }
      if (intent.draft.startKey < todayKey) {
        return { text: "That date has already passed. Leave for a past day goes through HR.", link: { label: "Open Requests", href: "/requests" } };
      }
      const leaves = (await db.getLeaveApplicationsByUser(user.id)) as any[];
      const row = buildLeaveBalance({ leaves, year: Number(intent.draft.startKey.slice(0, 4)) }).find(r => r.type === intent.draft!.leaveType);
      const detail = describeLeave(intent.draft, row ? row.left : null);
      const settings = await readSettings(user.id);
      if (!settings.askBeforeSending) {
        await submitLeaveDraft(user.id, userName, intent.draft);
        return {
          text: "Sent. You turned off \"ask before sending\", so this went straight to your approver.",
          action: { kind: "leave", title: "Leave request sent", detail, payload: { ...intent.draft }, status: "sent" },
        };
      }
      return {
        text: "Ready when you are. Nothing goes to HR until you press Send.",
        action: { kind: "leave", title: "Leave request, ready to send", detail, payload: { ...intent.draft }, status: "ready" },
      };
    }

    case "overtime":
      return {
        text: "Overtime needs the project and task it was for, so add it on the Time page. It only takes today or yesterday.",
        link: { label: "Add overtime", href: "/attendance?overtime=1" },
      };

    case "project_health": {
      const tasks = await loadTasks(user.id, now);
      const wanted = intent.project;
      const names = [...new Set(tasks.map(t => t.project))];
      const match = names.find(n => n.toLowerCase() === wanted) ?? names.find(n => n.toLowerCase().includes(wanted) || wanted.includes(n.toLowerCase()));
      if (!match) {
        return {
          text: names.length ? `I could not find a project called "${wanted}" among your tasks. Yours are: ${names.join(", ")}.` : "You have no project tasks yet.",
        };
      }
      const mine = tasks.filter(t => t.project === match);
      const done = mine.filter(t => t.done).length;
      const overdue = mine.filter(t => t.overdue);
      return {
        text: `${match}: ${done} of ${mine.length} of your tasks are done${overdue.length ? `, and ${overdue.length} ${overdue.length === 1 ? "is" : "are"} overdue` : ", nothing overdue"}. This covers your own tasks only.`,
        items: overdue.slice(0, 5).map(t => ({ label: t.title, meta: "Overdue", tone: "warn" as const })),
        link: { label: "Open the board", href: "/board" },
      };
    }

    case "standup": {
      const tasks = await loadTasks(user.id, now);
      const yesterdayKey = addDays(todayKey, -1);
      const finished = tasks.filter(t => t.done && t.completedAt && localDateKey(t.completedAt) >= yesterdayKey);
      const open = tasks.filter(t => !t.done);
      const next = [...open.filter(t => t.overdue), ...open.filter(t => t.dueToday), ...open.filter(t => !t.overdue && !t.dueToday)].slice(0, 4);
      const blockers = open.filter(t => t.overdue);
      return {
        text: "Here is a standup from your tasks. Edit it before you post it.",
        items: [
          { label: "Done", meta: finished.length ? finished.map(t => t.title).join("; ") : "Nothing marked done since yesterday", tone: "plain" },
          { label: "Today", meta: next.length ? next.map(t => t.title).join("; ") : "No open tasks", tone: "plain" },
          { label: "Blockers", meta: blockers.length ? `${blockers.length} overdue: ${blockers.map(t => t.title).join("; ")}` : "None", tone: blockers.length ? "warn" : "muted" },
        ],
      };
    }

    case "support_ticket": {
      if (!intent.subject) {
        return { text: "What is the problem? Say \"raise a support ticket for\" and then describe it.", link: { label: "Open Requests", href: "/requests" } };
      }
      const subject = intent.subject.slice(0, 160);
      const settings = await readSettings(user.id);
      if (!settings.askBeforeSending) {
        await createEmployeeRequest({ userId: user.id, userName, kind: "support_ticket", subject, category: "other" });
        return { text: "Ticket raised.", action: { kind: "support_ticket", title: "Support ticket sent", detail: subject, payload: { subject }, status: "sent" } };
      }
      return {
        text: "Here is the ticket. I will send it when you say so.",
        action: { kind: "support_ticket", title: "Support ticket, ready to send", detail: subject, payload: { subject }, status: "ready" },
      };
    }

    case "hours": {
      const summary = buildFourWeeks({ ...(await loadTimeData(user.id, now)), now });
      const { stats, toFix } = summary;
      return {
        text: `Over the last four weeks you were in ${stats.daysPresent} of ${stats.workingDays} working days, averaging ${stats.averageHours} hours, with ${stats.lateArrivals} late ${stats.lateArrivals === 1 ? "arrival" : "arrivals"}.${toFix.length ? ` ${toFix.length} ${toFix.length === 1 ? "day needs" : "days need"} fixing.` : ""}`,
        items: toFix.slice(0, 5).map(day => ({ label: dayLabel(day.date), meta: day.reason, tone: "warn" as const })),
        link: { label: "Open Time", href: "/attendance" },
      };
    }

    case "leave_balance": {
      const leaves = (await db.getLeaveApplicationsByUser(user.id)) as any[];
      const rows = buildLeaveBalance({ leaves, year: Number(todayKey.slice(0, 4)) });
      return {
        text: "Leave left this year:",
        items: rows.map(r => ({
          label: r.type.charAt(0).toUpperCase() + r.type.slice(1),
          meta: `${r.left} of ${r.quota}${r.pending ? `, ${r.pending} pending` : ""}`,
          tone: "plain" as const,
        })),
        link: { label: "Open Time", href: "/attendance" },
      };
    }

    case "payslip": {
      const payslip = (await db.getLatestPayslip(user.id)) as any;
      if (!payslip) return { text: "No payslip has been issued to you yet.", link: { label: "Open Pay", href: "/payslips" } };
      const month = MONTH_SHORT[Number(payslip.month) - 1];
      return {
        text: `Your latest payslip is ${month} ${payslip.year}${payslip.paidAt ? `, paid on ${dayLabel(localDateKey(new Date(payslip.paidAt)))}` : ", not marked paid yet"}. Amounts stay on the Pay page.`,
        link: { label: "Open Pay", href: "/payslips" },
      };
    }

    default:
      return {
        text: "I did not catch that. Here is what I can do in the portal:",
        items: WINGMAN_HELP.map(label => ({ label, tone: "muted" as const })),
      };
  }
}

function plainMessage(doc: any) {
  return {
    id: String(doc._id),
    role: doc.role as "user" | "wingman",
    text: doc.text as string,
    items: (doc.items ?? []) as { label: string; meta?: string; tone?: string }[],
    link: doc.link?.href ? { label: doc.link.label as string, href: doc.link.href as string } : null,
    action: doc.action?.kind
      ? { kind: doc.action.kind as "leave" | "support_ticket", title: doc.action.title as string, detail: doc.action.detail as string, status: doc.action.status as "ready" | "sent" | "cancelled" }
      : null,
    createdAt: doc.createdAt as Date,
  };
}

export const wingmanRouter = router({
  getSettings: protectedProcedure.query(async ({ ctx }) => readSettings(ctx.user.id)),

  updateSettings: protectedProcedure
    .input(
      z.object({
        askBeforeSending: z.boolean().optional(),
        morningBrief: z.boolean().optional(),
        clockOutReminder: z.boolean().optional(),
        whatsapp: z.boolean().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      await requireDb();
      await WingmanSettings.findOneAndUpdate(
        { userId: toObjectId(ctx.user.id) },
        { $set: input, $setOnInsert: { userId: toObjectId(ctx.user.id) } },
        { upsert: true }
      );
      return readSettings(ctx.user.id);
    }),

  /** The side panels of the Wingman page, all read from real records. */
  getOverview: protectedProcedure.query(async ({ ctx }) => {
    const now = new Date();
    const userId = ctx.user.id;
    const [timeData, tasks, settings] = await Promise.all([loadTimeData(userId, now), loadTasks(userId, now), readSettings(userId)]);
    const summary = buildFourWeeks({ ...timeData, now });

    const watching: { title: string; detail: string; href: string }[] = [];
    for (const day of summary.toFix.slice(-3)) {
      watching.push({ title: `${day.reason}, ${dayLabel(day.date)}`, detail: "Send a correction so the day is counted", href: "/attendance" });
    }
    const overdueByProject = new Map<string, number>();
    for (const task of tasks) if (task.overdue) overdueByProject.set(task.project, (overdueByProject.get(task.project) ?? 0) + 1);
    for (const [project, count] of overdueByProject) {
      watching.push({ title: `${project}: ${count} overdue ${count === 1 ? "task" : "tasks"}`, detail: "Past the due date and still open", href: "/board" });
    }

    const waitingOnYou = tasks
      .filter(t => t.overdue || t.dueToday)
      .slice(0, 4)
      .map(t => ({ title: t.title, detail: `${t.project} · ${t.overdue ? "overdue" : "due today"}`, href: "/board" }));

    const toReview = (await connectToMongoDB())
      ? await EmployeeRequest.countDocuments({
          status: "pending",
          ...(isOrgWide(ctx.user.role) ? {} : { approverUserId: toObjectId(userId) }),
          userId: { $ne: toObjectId(userId) },
        })
      : 0;
    if (toReview > 0) {
      waitingOnYou.push({ title: `${toReview} ${toReview === 1 ? "request" : "requests"} to review`, detail: "Corrections and tickets from your team", href: "/admin/requests" });
    }

    // Who each pending item is with, by name, so "waiting on" names a person.
    const pendingLeaves = timeData.leaves.filter(l => l.status === "pending");
    const pendingRequests = (await connectToMongoDB())
      ? await EmployeeRequest.find({ userId: toObjectId(userId), status: "pending" }).sort({ createdAt: -1 }).lean()
      : [];
    const approverIds = [
      ...pendingLeaves.map(l => l.approverUserId).filter(Boolean),
      ...pendingRequests.map((r: any) => (r.approverUserId ? String(r.approverUserId) : null)).filter(Boolean),
    ] as string[];
    const approvers = approverIds.length
      ? await User.find({ _id: { $in: [...new Set(approverIds)].filter(id => Types.ObjectId.isValid(id)) } }).select("name").lean()
      : [];
    const nameOf = (id: unknown) => approvers.find(u => String(u._id) === String(id))?.name ?? "HR";

    const waitingOn = [
      ...pendingLeaves.slice(0, 3).map(l => ({
        title: `${String(l.leaveType).charAt(0).toUpperCase() + String(l.leaveType).slice(1)} leave, ${dayLabel(localDateKey(new Date(l.startDate)))}`,
        detail: `With ${nameOf(l.approverUserId)}`,
        href: "/requests",
      })),
      ...pendingRequests.slice(0, 3).map((r: any) => ({ title: r.subject as string, detail: `With ${nameOf(r.approverUserId)}`, href: "/requests" })),
    ];

    return { watching, waitingOnYou, waitingOn, settings, toFix: summary.toFix };
  }),

  getHistory: protectedProcedure.query(async ({ ctx }) => {
    if (!(await connectToMongoDB())) return [];
    const list = await WingmanMessage.find({ userId: toObjectId(ctx.user.id) }).sort({ createdAt: -1 }).limit(60).lean();
    return list.reverse().map(plainMessage);
  }),

  clearHistory: protectedProcedure.mutation(async ({ ctx }) => {
    await requireDb();
    await WingmanMessage.deleteMany({ userId: toObjectId(ctx.user.id) });
    return { success: true };
  }),

  ask: protectedProcedure
    .input(z.object({ text: z.string().trim().min(1).max(500) }))
    .mutation(async ({ input, ctx }) => {
      await requireDb();
      const userId = toObjectId(ctx.user.id);
      const now = new Date();
      const question = await WingmanMessage.create({ userId, role: "user", text: input.text, createdAt: now });
      const reply = await answer(ctx.user, input.text, now);
      const saved = await WingmanMessage.create({ userId, role: "wingman", ...reply, createdAt: new Date(now.getTime() + 1) });
      return { question: plainMessage(question), reply: plainMessage(saved) };
    }),

  /** Sends something Wingman prepared. Only ever the caller's own, and only once. */
  confirmAction: protectedProcedure
    .input(z.object({ messageId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      await requireDb();
      // Claimed atomically, so a double click cannot send the same request twice.
      const message = await WingmanMessage.findOneAndUpdate(
        { _id: toObjectId(input.messageId), userId: toObjectId(ctx.user.id), "action.status": "ready" },
        { $set: { "action.status": "sent" } },
        { returnDocument: "after" }
      );
      if (!message?.action) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "This has already been sent or cancelled" });
      }
      const userName = ctx.user.name ?? "An employee";
      try {
        if (message.action.kind === "leave") {
          await submitLeaveDraft(ctx.user.id, userName, message.action.payload as unknown as LeaveDraft);
        } else {
          await createEmployeeRequest({
            userId: ctx.user.id,
            userName,
            kind: "support_ticket",
            subject: String(message.action.payload.subject ?? message.action.detail),
            category: "other",
          });
        }
      } catch (error) {
        // Put it back so the person can try again rather than losing the draft.
        await WingmanMessage.updateOne({ _id: message._id }, { $set: { "action.status": "ready" } });
        throw error;
      }
      // The card stops saying "ready to send" once it has gone.
      message.action.title = message.action.title.replace(", ready to send", " sent");
      await WingmanMessage.updateOne({ _id: message._id }, { $set: { "action.title": message.action.title } });
      return { success: true, message: plainMessage(message) };
    }),

  cancelAction: protectedProcedure
    .input(z.object({ messageId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      await requireDb();
      const message = await WingmanMessage.findOneAndUpdate(
        { _id: toObjectId(input.messageId), userId: toObjectId(ctx.user.id), "action.status": "ready" },
        { $set: { "action.status": "cancelled" } },
        { returnDocument: "after" }
      );
      if (!message) throw new TRPCError({ code: "BAD_REQUEST", message: "This has already been sent or cancelled" });
      return { success: true, message: plainMessage(message) };
    }),
});
