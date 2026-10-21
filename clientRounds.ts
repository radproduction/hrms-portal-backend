/**
 * Monthly client rounds on a project, and the client's feedback on each one.
 *
 * Every month a client project goes through the same five steps:
 *
 *   1. Report sent        a link or an uploaded file
 *   2. Meeting scheduled  the date and time the meeting is fixed for
 *   3. Meeting done
 *   4. Invoice sent       an uploaded file or a link
 *   5. Invoice paid       the date, and optionally the amount received
 *
 * All five are filled in by hand. A round also carries a private feedback link
 * the team sends to the client; the client answers six questions on a public
 * page, without signing in, once per round.
 *
 * Who may do what:
 *  - anyone on the project sees the rounds and their steps;
 *  - the project's creator and org-wide roles change them and read feedback.
 */
import express, { Router, type Request } from "express";
import { randomBytes } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { Schema, model, Document, Types, isValidObjectId } from "mongoose";
import { z } from "zod";
import * as db from "./db";
import * as fpb from "./fpbDb";
import { protectedProcedure, router } from "./_core/trpc";
import { emitNotification } from "./_core/realtime";
import { connectToMongoDB } from "./mongodb";
import { User } from "./models";
import { isOrgWide } from "./roles";
import { OFFSET_MINUTES } from "./attendance";
import { storageDelete, storagePut } from "./storage";
import { createLimiter } from "./leads";

// ==================== Feedback questions ====================

export const SATISFACTION = ["exceptional", "excellent", "good", "average", "poor"] as const;
export const PROGRESS = [
  "ahead_of_expectations",
  "mostly_on_track",
  "some_gaps_or_delays",
  "significantly_off_track",
  "too_early_to_assess",
] as const;
export const COMMUNICATION = ["excellent", "good", "fair", "poor"] as const;
export const CONCERNS = [
  "no_major_concerns",
  "quality_of_work",
  "deadlines_or_delays",
  "performance_and_results",
  "communication_or_ownership",
  "strategy_or_business_understanding",
  "budget_billing_value",
  "other",
] as const;
export const IMPROVEMENT = [
  "no_change_needed",
  "better_results",
  "faster_delivery",
  "more_proactive_communication",
  "better_strategy",
  "higher_quality_work",
  "clearer_reporting",
] as const;

/** What the public form sends. Unknown fields are dropped, long ones refused. */
export const feedbackInput = z
  .object({
    satisfaction: z.enum(SATISFACTION),
    progress: z.enum(PROGRESS),
    communication: z.enum(COMMUNICATION),
    concerns: z.array(z.enum(CONCERNS)).min(1).max(CONCERNS.length),
    otherConcern: z.string().trim().max(1000).optional().default(""),
    improvement: z.enum(IMPROVEMENT),
    comments: z.string().trim().max(4000).optional().default(""),
    name: z.string().trim().max(120).optional().default(""),
    // Hidden on the page. A person never fills it in; a form-filling bot does.
    website: z.string().max(200).optional().default(""),
  })
  .transform(value => {
    const concerns = [...new Set(value.concerns)];
    // "No major concerns" next to a real concern contradicts itself; the real
    // concern is the one worth keeping.
    const cleaned = concerns.length > 1 ? concerns.filter(c => c !== "no_major_concerns") : concerns;
    return {
      ...value,
      concerns: cleaned,
      otherConcern: cleaned.includes("other") ? value.otherConcern : "",
    };
  })
  .refine(value => !value.concerns.includes("other") || value.otherConcern.length > 0, {
    message: "Tell us what the other concern is",
    path: ["otherConcern"],
  });

export type FeedbackAnswers = z.infer<typeof feedbackInput>;

// ==================== Models ====================

type StoredFile = { url: string; key: string; name: string };

export interface IClientRound extends Document {
  _id: Types.ObjectId;
  projectId: Types.ObjectId;
  /** Office-local month, "YYYY-MM". */
  month: string;
  reportUrl?: string;
  reportFile?: StoredFile;
  reportSentAt?: Date;
  meetingAt?: Date;
  meetingDoneAt?: Date;
  meetingNotes?: string;
  invoiceNumber?: string;
  invoiceAmount?: number;
  invoiceCurrency?: string;
  invoiceUrl?: string;
  invoiceFile?: StoredFile;
  invoiceSentAt?: Date;
  paidAt?: Date;
  paidAmount?: number;
  paymentNote?: string;
  /** The secret in the client's feedback link. */
  feedbackToken: string;
  createdBy: Types.ObjectId;
  updatedBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const fileSchema = new Schema<StoredFile>({ url: String, key: String, name: String }, { _id: false });

const clientRoundSchema = new Schema<IClientRound>(
  {
    projectId: { type: Schema.Types.ObjectId, ref: "FpbProject", required: true },
    month: { type: String, required: true },
    reportUrl: String,
    reportFile: fileSchema,
    reportSentAt: Date,
    meetingAt: Date,
    meetingDoneAt: Date,
    meetingNotes: String,
    invoiceNumber: String,
    invoiceAmount: Number,
    invoiceCurrency: String,
    invoiceUrl: String,
    invoiceFile: fileSchema,
    invoiceSentAt: Date,
    paidAt: Date,
    paidAmount: Number,
    paymentNote: String,
    feedbackToken: { type: String, required: true, unique: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);
// One round per project per month.
clientRoundSchema.index({ projectId: 1, month: 1 }, { unique: true });
clientRoundSchema.index({ meetingAt: 1 });

export const ClientRound = model<IClientRound>("ClientRound", clientRoundSchema);

export interface IClientFeedback extends Document {
  _id: Types.ObjectId;
  roundId: Types.ObjectId;
  projectId: Types.ObjectId;
  satisfaction: string;
  progress: string;
  communication: string;
  concerns: string[];
  otherConcern?: string;
  improvement: string;
  comments?: string;
  name?: string;
  createdAt: Date;
}

const clientFeedbackSchema = new Schema<IClientFeedback>({
  // Unique: a round's link takes one answer.
  roundId: { type: Schema.Types.ObjectId, ref: "ClientRound", required: true, unique: true },
  projectId: { type: Schema.Types.ObjectId, ref: "FpbProject", required: true, index: true },
  satisfaction: { type: String, required: true },
  progress: { type: String, required: true },
  communication: { type: String, required: true },
  concerns: [String],
  otherConcern: String,
  improvement: { type: String, required: true },
  comments: String,
  name: String,
  createdAt: { type: Date, default: Date.now },
});

export const ClientFeedback = model<IClientFeedback>("ClientFeedback", clientFeedbackSchema);

// ==================== Pure helpers ====================

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** The office-local month an instant falls in, "YYYY-MM". */
export function monthKeyOf(date: Date, offsetMinutes = OFFSET_MINUTES) {
  const local = new Date(date.getTime() + offsetMinutes * 60000);
  return `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** "October 2026" for "2026-10". */
export function monthLabel(month: string) {
  const match = MONTH_RE.exec(month);
  if (!match) return month;
  return `${MONTH_NAMES[Number(match[2]) - 1]} ${match[1]}`;
}

/** Whole months from a to b, both "YYYY-MM". */
function monthsBetween(a: string, b: string) {
  const [ay, am] = a.split("-").map(Number);
  const [by, bm] = b.split("-").map(Number);
  return (by - ay) * 12 + (bm - am);
}

/** A round may be opened up to two years back and three months ahead. */
export function isOpenableMonth(month: string, now: Date, offsetMinutes = OFFSET_MINUTES) {
  if (!MONTH_RE.test(month)) return false;
  const diff = monthsBetween(monthKeyOf(now, offsetMinutes), month);
  return diff >= -24 && diff <= 3;
}

export type RoundSteps = {
  reportSent: boolean;
  meetingScheduled: boolean;
  meetingDone: boolean;
  invoiceSent: boolean;
  invoicePaid: boolean;
  done: number;
};

/** Which of the five steps are done. */
export function roundSteps(round: Partial<IClientRound>): RoundSteps {
  const steps = {
    reportSent: Boolean(round.reportSentAt && (round.reportUrl || round.reportFile?.url)),
    meetingScheduled: Boolean(round.meetingAt),
    meetingDone: Boolean(round.meetingDoneAt),
    invoiceSent: Boolean(round.invoiceSentAt && (round.invoiceUrl || round.invoiceFile?.url)),
    invoicePaid: Boolean(round.paidAt),
  };
  return { ...steps, done: Object.values(steps).filter(Boolean).length };
}

/** Only web links are stored, never javascript: or data: and the like. */
export const webUrl = z
  .string()
  .trim()
  .max(1000)
  .refine(value => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" || url.protocol === "http:";
    } catch {
      return false;
    }
  }, "Enter a full link starting with https://");

/** Files the steps accept, and the extension each is stored under. */
export const ALLOWED_FILES: Record<string, string> = {
  "application/pdf": "pdf",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
};

export const MAX_FILE_BYTES = 10 * 1024 * 1024;

// ==================== Access ====================

type Ctx = { user: { id: string; role?: string | null } };

async function projectFor(projectId: string) {
  const project = await fpb.getProject(projectId);
  if (!project) throw new TRPCError({ code: "NOT_FOUND", message: "Project not found" });
  return project as any;
}

function isOwner(ctx: Ctx, project: any) {
  return isOrgWide(ctx.user.role ?? undefined) || String(project.createdBy) === ctx.user.id;
}

/** Anyone on the project may look. */
async function requireView(ctx: Ctx, projectId: string) {
  const project = await projectFor(projectId);
  if (isOwner(ctx, project)) return { project, canEdit: true };
  if ((project.memberIds ?? []).includes(ctx.user.id)) return { project, canEdit: false };
  throw new TRPCError({ code: "FORBIDDEN", message: "You are not on this project" });
}

/** Only the project's creator and admins change rounds or read feedback. */
async function requireEdit(ctx: Ctx, projectId: string) {
  const project = await projectFor(projectId);
  if (!isOwner(ctx, project)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Only the person who created this project, or an admin, can change this",
    });
  }
  return project;
}

async function roundFor(roundId: string) {
  if (!isValidObjectId(roundId)) throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid id" });
  if (!(await connectToMongoDB())) {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });
  }
  const round = await ClientRound.findById(roundId);
  if (!round) throw new TRPCError({ code: "NOT_FOUND", message: "Round not found" });
  return round;
}

async function ensureDb() {
  if (!(await connectToMongoDB())) {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });
  }
}

const newToken = () => randomBytes(24).toString("hex");

function fileOut(file?: StoredFile | null) {
  return file?.url ? { url: file.url, name: file.name } : null;
}

function roundOut(round: any, canEdit: boolean, feedback: any | null) {
  return {
    id: String(round._id),
    projectId: String(round.projectId),
    month: round.month as string,
    monthLabel: monthLabel(round.month),
    reportUrl: round.reportUrl ?? null,
    reportFile: fileOut(round.reportFile),
    reportSentAt: round.reportSentAt ?? null,
    meetingAt: round.meetingAt ?? null,
    meetingDoneAt: round.meetingDoneAt ?? null,
    meetingNotes: round.meetingNotes ?? "",
    invoiceNumber: round.invoiceNumber ?? "",
    invoiceAmount: round.invoiceAmount ?? null,
    invoiceCurrency: round.invoiceCurrency ?? "PKR",
    invoiceUrl: round.invoiceUrl ?? null,
    invoiceFile: fileOut(round.invoiceFile),
    invoiceSentAt: round.invoiceSentAt ?? null,
    paidAt: round.paidAt ?? null,
    paidAmount: round.paidAmount ?? null,
    paymentNote: round.paymentNote ?? "",
    steps: roundSteps(round),
    // The link and the answers are for the people who run the account.
    feedbackToken: canEdit ? round.feedbackToken : null,
    feedbackSubmittedAt: feedback?.createdAt ?? null,
    feedback: canEdit && feedback
      ? {
          satisfaction: feedback.satisfaction,
          progress: feedback.progress,
          communication: feedback.communication,
          concerns: feedback.concerns ?? [],
          otherConcern: feedback.otherConcern ?? "",
          improvement: feedback.improvement,
          comments: feedback.comments ?? "",
          name: feedback.name ?? "",
          submittedAt: feedback.createdAt,
        }
      : null,
    canEdit,
  };
}

// ==================== API ====================

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, "Invalid id");
const CURRENCIES = ["PKR", "USD", "CAD", "EUR", "GBP", "AED", "SAR"] as const;
const money = z.number().finite().min(0).max(1e12);

export const clientRoundsRouter = router({
  /** A project's rounds, newest month first. */
  list: protectedProcedure
    .input(z.object({ projectId: objectId }))
    .query(async ({ ctx, input }) => {
      const { canEdit } = await requireView(ctx, input.projectId);
      await ensureDb();
      const rounds = await ClientRound.find({ projectId: input.projectId }).sort({ month: -1 }).lean();
      const feedback = await ClientFeedback.find({ roundId: { $in: rounds.map(r => r._id) } }).lean();
      const byRound = new Map(feedback.map(f => [String(f.roundId), f]));
      return {
        canEdit,
        currentMonth: monthKeyOf(new Date()),
        rounds: rounds.map(r => roundOut(r, canEdit, byRound.get(String(r._id)) ?? null)),
      };
    }),

  /** Opens a month on a project. Opening one that exists returns it. */
  create: protectedProcedure
    .input(z.object({ projectId: objectId, month: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await requireEdit(ctx, input.projectId);
      if (!isOpenableMonth(input.month, new Date())) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Pick a month within the last two years or the next three months" });
      }
      await ensureDb();
      const existing = await ClientRound.findOne({ projectId: input.projectId, month: input.month }).lean();
      if (existing) return roundOut(existing, true, null);
      try {
        const created = await ClientRound.create({
          projectId: input.projectId,
          month: input.month,
          feedbackToken: newToken(),
          createdBy: ctx.user.id,
        });
        await fpb.logActivity(input.projectId, ctx.user.id, "opened client month", monthLabel(input.month));
        return roundOut(created.toObject(), true, null);
      } catch (error: any) {
        // Two clicks at once: the unique index lets one through.
        if (error?.code === 11000) {
          const again = await ClientRound.findOne({ projectId: input.projectId, month: input.month }).lean();
          if (again) return roundOut(again, true, null);
        }
        throw error;
      }
    }),

  /**
   * Fills in or clears the hand-entered parts of a round. A field left out is
   * unchanged; null clears it.
   */
  update: protectedProcedure
    .input(
      z.object({
        roundId: objectId,
        reportUrl: webUrl.nullable().optional(),
        reportSentAt: z.date().nullable().optional(),
        meetingAt: z.date().nullable().optional(),
        meetingDoneAt: z.date().nullable().optional(),
        meetingNotes: z.string().trim().max(2000).optional(),
        invoiceNumber: z.string().trim().max(80).optional(),
        invoiceAmount: money.nullable().optional(),
        invoiceCurrency: z.enum(CURRENCIES).optional(),
        invoiceUrl: webUrl.nullable().optional(),
        invoiceSentAt: z.date().nullable().optional(),
        paidAt: z.date().nullable().optional(),
        paidAmount: money.nullable().optional(),
        paymentNote: z.string().trim().max(500).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const round = await roundFor(input.roundId);
      await requireEdit(ctx, String(round.projectId));
      const { roundId, ...changes } = input;

      const set: Record<string, unknown> = {};
      const unset: Record<string, ""> = {};
      for (const [field, value] of Object.entries(changes)) {
        if (value === undefined) continue;
        if (value === null || value === "") unset[field] = "";
        else set[field] = value;
      }

      // Work out what the round will look like, so the steps stay in order: a
      // report or invoice is only "sent" once there is something to send, a
      // meeting is only "done" once it was scheduled, and an invoice is only
      // "paid" once it was sent. Asking for a step without what it needs is an
      // error; clearing what a step needs clears the step with it.
      const next: any = { ...round.toObject(), ...set };
      for (const field of Object.keys(unset)) delete next[field];

      const rules: { step: string; ok: () => boolean; message: string }[] = [
        { step: "reportSentAt", ok: () => Boolean(next.reportUrl || next.reportFile?.url), message: "Add the report link or file before marking it sent" },
        { step: "meetingDoneAt", ok: () => Boolean(next.meetingAt), message: "Set the meeting date before marking it done" },
        { step: "invoiceSentAt", ok: () => Boolean(next.invoiceUrl || next.invoiceFile?.url), message: "Add the invoice file or link before marking it sent" },
        { step: "paidAt", ok: () => Boolean(next.invoiceSentAt), message: "Mark the invoice as sent before marking it paid" },
      ];
      // In order, so clearing the invoice file also clears "paid" via "sent".
      for (const rule of rules) {
        if (!next[rule.step] || rule.ok()) continue;
        if (rule.step in set) throw new TRPCError({ code: "BAD_REQUEST", message: rule.message });
        delete next[rule.step];
        unset[rule.step] = "";
      }

      set.updatedBy = ctx.user.id;
      const update: Record<string, unknown> = { $set: set };
      if (Object.keys(unset).length > 0) update.$unset = unset;
      const saved = await ClientRound.findByIdAndUpdate(roundId, update, { returnDocument: "after" }).lean();
      const feedback = await ClientFeedback.findOne({ roundId }).lean();
      return roundOut(saved, true, feedback);
    }),

  /**
   * Uploads the report or the invoice file. When the step has no "sent" date
   * yet it is marked sent today; the date can be changed afterwards.
   */
  attachFile: protectedProcedure
    .input(
      z.object({
        roundId: objectId,
        kind: z.enum(["report", "invoice"]),
        fileName: z.string().trim().min(1).max(200),
        fileBase64: z.string().min(1),
        mimeType: z.string(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const round = await roundFor(input.roundId);
      await requireEdit(ctx, String(round.projectId));

      const ext = ALLOWED_FILES[input.mimeType];
      if (!ext) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Upload a PDF, image, Word, Excel or PowerPoint file" });
      }
      const buffer = Buffer.from(input.fileBase64, "base64");
      if (buffer.length === 0) throw new TRPCError({ code: "BAD_REQUEST", message: "File is empty" });
      if (buffer.length > MAX_FILE_BYTES) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "File must be 10MB or smaller" });
      }

      // A random name, so a stored invoice cannot be found by guessing, and an
      // extension from the type rather than the name, so nothing lands as .html.
      const key = `client-rounds/${String(round.projectId)}/${input.kind}-${randomBytes(16).toString("hex")}.${ext}`;
      const { url } = await storagePut(key, buffer, input.mimeType);
      const field = input.kind === "report" ? "reportFile" : "invoiceFile";
      const sentField = input.kind === "report" ? "reportSentAt" : "invoiceSentAt";
      const previous = (round as any)[field] as StoredFile | undefined;

      const set: Record<string, unknown> = {
        [field]: { url, key, name: input.fileName.replace(/[\r\n]+/g, " ") },
        updatedBy: ctx.user.id,
      };
      if (!(round as any)[sentField]) set[sentField] = new Date();
      const saved = await ClientRound.findByIdAndUpdate(round._id, { $set: set }, { returnDocument: "after" }).lean();

      if (previous?.key) await storageDelete(previous.key).catch(() => false);
      const feedback = await ClientFeedback.findOne({ roundId: round._id }).lean();
      return roundOut(saved, true, feedback);
    }),

  /** Takes the report or invoice file off a round, and deletes it. */
  removeFile: protectedProcedure
    .input(z.object({ roundId: objectId, kind: z.enum(["report", "invoice"]) }))
    .mutation(async ({ ctx, input }) => {
      const round = await roundFor(input.roundId);
      await requireEdit(ctx, String(round.projectId));
      const field = input.kind === "report" ? "reportFile" : "invoiceFile";
      const previous = (round as any)[field] as StoredFile | undefined;

      const unset: Record<string, ""> = { [field]: "" };
      // Without a file or a link there is nothing that was sent.
      if (input.kind === "report" && !round.reportUrl) unset.reportSentAt = "";
      if (input.kind === "invoice" && !round.invoiceUrl) {
        unset.invoiceSentAt = "";
        unset.paidAt = "";
      }
      const saved = await ClientRound.findByIdAndUpdate(
        round._id,
        { $unset: unset, $set: { updatedBy: ctx.user.id } },
        { returnDocument: "after" }
      ).lean();
      if (previous?.key) await storageDelete(previous.key).catch(() => false);
      const feedback = await ClientFeedback.findOne({ roundId: round._id }).lean();
      return roundOut(saved, true, feedback);
    }),

  /** Deletes a month, its files and its feedback. */
  delete: protectedProcedure
    .input(z.object({ roundId: objectId }))
    .mutation(async ({ ctx, input }) => {
      const round = await roundFor(input.roundId);
      await requireEdit(ctx, String(round.projectId));
      for (const file of [round.reportFile, round.invoiceFile]) {
        if (file?.key) await storageDelete(file.key).catch(() => false);
      }
      await ClientFeedback.deleteMany({ roundId: round._id });
      await ClientRound.deleteOne({ _id: round._id });
      await fpb.logActivity(String(round.projectId), ctx.user.id, "deleted client month", monthLabel(round.month));
      return { success: true };
    }),

  /** A fresh feedback link for a round that has no answer yet; the old one stops working. */
  resetFeedbackLink: protectedProcedure
    .input(z.object({ roundId: objectId }))
    .mutation(async ({ ctx, input }) => {
      const round = await roundFor(input.roundId);
      await requireEdit(ctx, String(round.projectId));
      if (await ClientFeedback.exists({ roundId: round._id })) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "The client has already answered this month" });
      }
      const saved = await ClientRound.findByIdAndUpdate(
        round._id,
        { $set: { feedbackToken: newToken(), updatedBy: ctx.user.id } },
        { returnDocument: "after" }
      ).lean();
      return roundOut(saved, true, null);
    }),

  /**
   * Client meetings in a date range, across every project the caller can see,
   * for the calendar on the Work page.
   */
  meetings: protectedProcedure
    .input(z.object({ from: z.date(), to: z.date() }))
    .query(async ({ ctx, input }) => {
      if (input.to <= input.from || input.to.getTime() - input.from.getTime() > 120 * 86400000) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Pick a range of up to four months" });
      }
      await ensureDb();
      const projects = (await fpb.getProjects({
        visibleTo: isOrgWide(ctx.user.role ?? undefined) ? undefined : ctx.user.id,
      })) as any[];
      const titles = new Map(projects.map(p => [String(p.id), p.title as string]));
      const rounds = await ClientRound.find({
        projectId: { $in: [...titles.keys()] },
        meetingAt: { $gte: input.from, $lt: input.to },
      })
        .sort({ meetingAt: 1 })
        .lean();
      return rounds.map(r => ({
        roundId: String(r._id),
        projectId: String(r.projectId),
        projectTitle: titles.get(String(r.projectId)) ?? "Project",
        month: r.month,
        monthLabel: monthLabel(r.month),
        meetingAt: r.meetingAt as Date,
        meetingDoneAt: r.meetingDoneAt ?? null,
        meetingNotes: r.meetingNotes ?? "",
      }));
    }),
});

// ==================== Public feedback page ====================

const allowAddress = createLimiter(20, 10 * 60 * 1000);
const allowRoute = createLimiter(600, 60 * 60 * 1000);

/** nginx sets X-Real-IP itself, so a visitor cannot choose its value. */
function addressOf(req: Request): string {
  const real = req.headers["x-real-ip"];
  return (Array.isArray(real) ? real[0] : real) || req.socket.remoteAddress || "unknown";
}

const TOKEN_RE = /^[0-9a-f]{48}$/;

/** The name the form asks about, e.g. "How satisfied are you with Heard Studio?" */
export function feedbackCompanyName(env: Record<string, string | undefined> = process.env) {
  return (env.CLIENT_FEEDBACK_COMPANY ?? "").trim().slice(0, 80) || "Heard Studio";
}

async function notifyOwners(round: IClientRound, projectTitle: string, createdBy: string) {
  try {
    const seniors = await User.find({ role: { $in: ["admin", "head_of_ops"] } }).select("_id").lean();
    const targets = new Set([createdBy, ...seniors.map(s => String(s._id))]);
    for (const userId of targets) {
      await db.createNotification({
        userId,
        type: "system_alert",
        title: "Client feedback received",
        message: `${projectTitle} answered the ${monthLabel(round.month)} feedback.`,
        priority: "medium",
        relatedId: String(round.projectId),
        relatedType: "fpb_project",
      });
      emitNotification({ userId });
    }
  } catch (error) {
    console.error("[ClientFeedback] could not notify", error instanceof Error ? error.name : "unknown error");
  }
}

export const clientFeedbackHttpRouter = Router();

/** What the form shows above the questions. Says nothing beyond the project's name. */
clientFeedbackHttpRouter.get("/api/client-feedback/:token", async (req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    const token = String(req.params.token);
    if (!TOKEN_RE.test(token)) return res.status(404).json({ ok: false, error: "not_found" });
    if (!allowRoute("all", Date.now()) || !allowAddress(addressOf(req), Date.now())) {
      return res.status(429).json({ ok: false, error: "too_many_requests" });
    }
    if (!(await connectToMongoDB())) return res.status(503).json({ ok: false, error: "unavailable" });
    const round = await ClientRound.findOne({ feedbackToken: token }).lean();
    if (!round) return res.status(404).json({ ok: false, error: "not_found" });
    const project = await fpb.getProject(String(round.projectId));
    const answered = await ClientFeedback.exists({ roundId: round._id });
    return res.json({
      ok: true,
      company: feedbackCompanyName(),
      projectTitle: (project as any)?.title ?? "",
      monthLabel: monthLabel(round.month),
      submitted: Boolean(answered),
    });
  } catch (error) {
    console.error("[ClientFeedback] lookup failed", error instanceof Error ? error.name : "unknown error");
    return res.status(500).json({ ok: false, error: "internal_error" });
  }
});

// The answers are a few short fields; anything bigger is not a form.
clientFeedbackHttpRouter.post("/api/client-feedback/:token", express.json({ limit: "20kb" }), async (req, res) => {
  try {
    const token = String(req.params.token);
    if (!TOKEN_RE.test(token)) return res.status(404).json({ ok: false, error: "not_found" });
    if (!allowRoute("all", Date.now()) || !allowAddress(addressOf(req), Date.now())) {
      return res.status(429).json({ ok: false, error: "too_many_requests" });
    }
    const parsed = feedbackInput.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: "invalid" });
    const { website, ...answers } = parsed.data;
    if (website) return res.status(200).json({ ok: true });

    if (!(await connectToMongoDB())) return res.status(503).json({ ok: false, error: "unavailable" });
    const round = await ClientRound.findOne({ feedbackToken: token });
    if (!round) return res.status(404).json({ ok: false, error: "not_found" });

    try {
      await ClientFeedback.create({ ...answers, roundId: round._id, projectId: round.projectId });
    } catch (error: any) {
      if (error?.code === 11000) return res.status(409).json({ ok: false, error: "already_submitted" });
      throw error;
    }
    const project = await fpb.getProject(String(round.projectId));
    void notifyOwners(round, (project as any)?.title ?? "A client", String(round.createdBy));
    return res.json({ ok: true });
  } catch (error) {
    // The body is never logged: it is the client's own words.
    console.error("[ClientFeedback] submit failed", error instanceof Error ? error.name : "unknown error");
    return res.status(500).json({ ok: false, error: "internal_error" });
  }
});

/** Removes a deleted project's rounds, their files and their feedback. */
export async function deleteRoundsForProject(projectId: string) {
  if (!isValidObjectId(projectId) || !(await connectToMongoDB())) return;
  const rounds = await ClientRound.find({ projectId }).lean();
  for (const round of rounds) {
    for (const file of [round.reportFile, round.invoiceFile]) {
      if (file?.key) await storageDelete(file.key).catch(() => false);
    }
  }
  await ClientFeedback.deleteMany({ projectId });
  await ClientRound.deleteMany({ projectId });
}
