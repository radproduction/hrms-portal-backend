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

type LeadMail = { name: string; company: string; email: string; teamSize: string; plan: string };

const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The comma-separated addresses in LEADS_NOTIFY_EMAILS, minus anything that is not an address. */
export function parseRecipients(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map(part => part.trim())
    .filter(part => /^[^\s@<>,]+@[^\s@<>,]+\.[^\s@<>,]+$/.test(part))
    .slice(0, 20);
}

/**
 * The email sent for one sign-up. Everything the visitor typed is escaped in
 * the HTML part and stripped of line breaks in the subject, so a sign-up can
 * never inject markup or extra headers into the message.
 */
export function buildLeadEmail(lead: LeadMail) {
  const oneLine = (value: string) => value.replace(/[\r\n]+/g, " ").trim();
  const rows: [string, string][] = [
    ["Name", lead.name],
    ["Company", lead.company],
    ["Email", lead.email],
    ["Team size", lead.teamSize || "Not given"],
    ["Plan", lead.plan || "Not given"],
  ];
  return {
    subject: `New sign-up: ${oneLine(lead.name)} at ${oneLine(lead.company)}`.slice(0, 200),
    text: `${rows.map(([label, value]) => `${label}: ${value}`).join("\n")}\n\nSee all leads in the portal under Admin > Leads.`,
    html:
      `<table cellpadding="6" style="font-family:sans-serif;font-size:14px">` +
      rows.map(([label, value]) => `<tr><td style="color:#5b6258">${label}</td><td><strong>${escapeHtml(value)}</strong></td></tr>`).join("") +
      `</table><p style="font-family:sans-serif;font-size:13px;color:#5b6258">See all leads in the portal under Admin &gt; Leads.</p>`,
  };
}

/** "Now <leads@example.com>" or a bare address, as the name and email a mail API wants. */
export function parseSender(raw: string | undefined): { name?: string; email: string } | null {
  const value = (raw ?? "").trim();
  const named = /^(.*)<([^<>\s]+@[^<>\s]+)>$/.exec(value);
  if (named) {
    const name = named[1].trim().replace(/^"|"$/g, "");
    return name ? { name, email: named[2] } : { email: named[2] };
  }
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value) ? { email: value } : null;
}

/**
 * Emails a sign-up to the addresses in LEADS_NOTIFY_EMAILS.
 *
 * Goes over HTTPS to a mail service rather than SMTP, because DigitalOcean
 * blocks the SMTP ports on droplets. Brevo is used when BREVO_API_KEY is set,
 * otherwise Resend when RESEND_API_KEY is. Does nothing until a key,
 * LEADS_FROM_EMAIL and LEADS_NOTIFY_EMAILS are all set. The lead is already
 * saved by the time this runs, so a failure here loses an email, never a lead.
 */
export async function sendLeadEmail(
  lead: LeadMail,
  env: Record<string, string | undefined> = process.env,
  send: typeof fetch = fetch
): Promise<"sent" | "not_configured" | "failed"> {
  const sender = parseSender(env.LEADS_FROM_EMAIL);
  const to = parseRecipients(env.LEADS_NOTIFY_EMAILS);
  if (!sender || to.length === 0 || (!env.BREVO_API_KEY && !env.RESEND_API_KEY)) return "not_configured";
  const mail = buildLeadEmail(lead);

  const request = env.BREVO_API_KEY
    ? {
        url: "https://api.brevo.com/v3/smtp/email",
        headers: { "api-key": env.BREVO_API_KEY, "Content-Type": "application/json", Accept: "application/json" },
        body: {
          sender,
          to: to.map(email => ({ email })),
          replyTo: { email: lead.email },
          subject: mail.subject,
          htmlContent: mail.html,
          textContent: mail.text,
        },
      }
    : {
        url: "https://api.resend.com/emails",
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: {
          from: sender.name ? `${sender.name} <${sender.email}>` : sender.email,
          to,
          reply_to: lead.email,
          ...mail,
        },
      };

  try {
    const response = await send(request.url, {
      method: "POST",
      headers: request.headers as Record<string, string>,
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      // Status only: the response body can echo the lead back.
      console.error("[Leads] email was not accepted, status", response.status);
      return "failed";
    }
    return "sent";
  } catch (error) {
    console.error("[Leads] email could not be sent", error instanceof Error ? error.name : "unknown error");
    return "failed";
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
      void sendLeadEmail(lead);
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
