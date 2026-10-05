/**
 * Sign-ups from the public landing page.
 *
 * The page posts JSON to POST /api/leads. This is the one route on the server
 * that anybody on the internet may write to without signing in, so it is kept
 * narrow: fixed fields with length limits, a per-address rate limit, a cap on
 * the whole route, and a hidden field that only bots fill in. It only ever
 * inserts a lead; reading them needs an org-wide role (see leadsRouter).
 */
import express, { Router, type Request } from "express";
import { TRPCError } from "@trpc/server";
import { Schema, model, Document, Types } from "mongoose";
import { z } from "zod";
import * as db from "./db";
import { protectedProcedure, router } from "./_core/trpc";
import { emitNotification } from "./_core/realtime";
import { connectToMongoDB } from "./mongodb";
import { User } from "./models";
import { isOrgWide } from "./roles";

export interface ILead extends Document {
  _id: Types.ObjectId;
  name: string;
  company: string;
  email: string;
  teamSize: string;
  plan: string;
  /** Where on the site it came from, e.g. "landing". */
  source: string;
  status: "new" | "contacted" | "closed";
  note?: string;
  createdAt: Date;
  updatedAt: Date;
}

const leadSchema = new Schema<ILead>({
  name: { type: String, required: true },
  company: { type: String, required: true },
  email: { type: String, required: true, index: true },
  teamSize: { type: String, default: "" },
  plan: { type: String, default: "" },
  source: { type: String, default: "landing" },
  status: { type: String, enum: ["new", "contacted", "closed"], default: "new", required: true },
  note: String,
}, { timestamps: true });

export const Lead = model<ILead>("Lead", leadSchema);

/** What the landing page sends. Unknown fields are dropped, long ones refused. */
export const leadInput = z.object({
  name: z.string().trim().min(1).max(120),
  company: z.string().trim().min(1).max(160),
  email: z.string().trim().toLowerCase().max(200).regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/),
  teamSize: z.string().trim().max(40).optional().default(""),
  plan: z.string().trim().max(40).optional().default(""),
  source: z.string().trim().max(40).optional().default("landing"),
  // Hidden on the page. A person never fills it in; a form-filling bot does.
  website: z.string().max(200).optional().default(""),
});

const WINDOW_MS = 10 * 60 * 1000;
const PER_ADDRESS = 5;
const ROUTE_CAP = 300;

/**
 * Sliding-window limiter, pure so it can be tested with a fake clock.
 * Kept in memory: a restart forgets it, which only ever errs towards letting a
 * real person through.
 */
export function createLimiter(limit: number, windowMs: number) {
  const hits = new Map<string, number[]>();
  return (key: string, now: number): boolean => {
    const recent = (hits.get(key) ?? []).filter(at => now - at < windowMs);
    if (recent.length >= limit) {
      hits.set(key, recent);
      return false;
    }
    recent.push(now);
    hits.set(key, recent);
    // Stop the map growing without bound under a flood of made-up addresses.
    if (hits.size > 5000) {
      for (const [k, list] of hits) if (list.every(at => now - at >= windowMs)) hits.delete(k);
    }
    return true;
  };
}

const allowAddress = createLimiter(PER_ADDRESS, WINDOW_MS);
const allowRoute = createLimiter(ROUTE_CAP, 60 * 60 * 1000);

/** nginx sets X-Real-IP itself, so a visitor cannot choose its value. */
function addressOf(req: Request): string {
  const real = req.headers["x-real-ip"];
  return (Array.isArray(real) ? real[0] : real) || req.socket.remoteAddress || "unknown";
}

/** Tells everyone org-wide that a sign-up came in. Never fails the sign-up. */
async function notifyTeam(lead: { name: string; company: string; plan: string }) {
  try {
    const seniors = await User.find({ role: { $in: ["admin", "head_of_ops"] } }).select("_id").lean();
    for (const person of seniors) {
      const userId = String(person._id);
      await db.createNotification({
        userId,
        type: "system_alert",
        title: "New sign-up from the website",
        message: `${lead.name} at ${lead.company}${lead.plan ? ` (${lead.plan})` : ""}.`,
        priority: "high",
        relatedType: "lead",
      });
      emitNotification({ userId });
    }
  } catch (error) {
    console.error("[Leads] could not notify the team", error instanceof Error ? error.name : "unknown error");
  }
}

export const leadsHttpRouter = Router();

// A sign-up is a few short fields; anything bigger is not one.
leadsHttpRouter.post("/api/leads", express.json({ limit: "10kb" }), async (req, res) => {
  try {
    const now = Date.now();
    if (!allowRoute("all", now) || !allowAddress(addressOf(req), now)) {
      return res.status(429).json({ ok: false, error: "too_many_requests" });
    }
    const parsed = leadInput.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: "invalid" });
    }
    const { website, ...lead } = parsed.data;
    // A filled honeypot is answered as a success, so the bot learns nothing.
    if (website) return res.status(200).json({ ok: true });

    if (!(await connectToMongoDB())) {
      return res.status(503).json({ ok: false, error: "unavailable" });
    }
    // A double click or an impatient resubmit should not make two leads.
    const recent = await Lead.findOne({ email: lead.email, createdAt: { $gte: new Date(now - WINDOW_MS) } }).lean();
    if (!recent) {
      await Lead.create(lead);
      void notifyTeam(lead);
    }
    return res.status(200).json({ ok: true });
  } catch (error) {
    // The body is never logged: it holds a stranger's name and email.
    console.error("[Leads] sign-up failed", error instanceof Error ? error.name : "unknown error");
    return res.status(500).json({ ok: false, error: "internal_error" });
  }
});

function requireOrgWide(role: string | undefined | null) {
  if (!isOrgWide(role)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Only admins can see website sign-ups" });
  }
}

export const leadsRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    requireOrgWide(ctx.user.role);
    if (!(await connectToMongoDB())) return [];
    const leads = await Lead.find().sort({ createdAt: -1 }).limit(1000).lean();
    return leads.map(lead => ({
      id: String(lead._id),
      name: lead.name,
      company: lead.company,
      email: lead.email,
      teamSize: lead.teamSize ?? "",
      plan: lead.plan ?? "",
      source: lead.source ?? "landing",
      status: lead.status,
      note: lead.note ?? "",
      createdAt: lead.createdAt,
    }));
  }),

  update: protectedProcedure
    .input(z.object({
      id: z.string(),
      status: z.enum(["new", "contacted", "closed"]).optional(),
      note: z.string().trim().max(1000).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      requireOrgWide(ctx.user.role);
      if (!Types.ObjectId.isValid(input.id)) throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid id" });
      if (!(await connectToMongoDB())) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });
      const changes: Record<string, unknown> = {};
      if (input.status) changes.status = input.status;
      if (input.note !== undefined) changes.note = input.note;
      const updated = await Lead.findByIdAndUpdate(input.id, { $set: changes });
      if (!updated) throw new TRPCError({ code: "NOT_FOUND", message: "Sign-up not found" });
      return { success: true };
    }),
});
