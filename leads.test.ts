import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import mongoose from "mongoose";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { Notification, User } from "./models";
import { createLimiter, Lead, leadInput, leadsHttpRouter } from "./leads";
import { describeWithDb } from "./test-utils";

describe("leadInput", () => {
  const good = { name: " Sara Khan ", company: "Acme", email: " Sara@Acme.COM ", teamSize: "21 to 50", plan: "Enterprise" };

  it("trims, lower-cases the email and drops fields it does not know", () => {
    const parsed = leadInput.parse({ ...good, role: "admin", status: "closed" });
    expect(parsed).toEqual({ name: "Sara Khan", company: "Acme", email: "sara@acme.com", teamSize: "21 to 50", plan: "Enterprise", source: "landing", website: "" });
  });

  it("refuses missing fields, bad emails and oversized values", () => {
    expect(leadInput.safeParse({ ...good, name: "  " }).success).toBe(false);
    expect(leadInput.safeParse({ ...good, email: "not-an-email" }).success).toBe(false);
    expect(leadInput.safeParse({ ...good, email: "a b@c.com" }).success).toBe(false);
    expect(leadInput.safeParse({ ...good, company: "x".repeat(161) }).success).toBe(false);
    expect(leadInput.safeParse({ ...good, name: { $gt: "" } }).success).toBe(false);
    expect(leadInput.safeParse(null).success).toBe(false);
  });
});

describe("createLimiter", () => {
  it("allows the limit inside the window, then refuses, then recovers", () => {
    const allow = createLimiter(2, 1000);
    expect(allow("a", 0)).toBe(true);
    expect(allow("a", 100)).toBe(true);
    expect(allow("a", 200)).toBe(false);
    // Another address is counted on its own.
    expect(allow("b", 200)).toBe(true);
    // The first hit has aged out, so one more is allowed.
    expect(allow("a", 1050)).toBe(true);
    expect(allow("a", 1060)).toBe(false);
  });
});

describeWithDb("POST /api/leads", () => {
  let server: Server;
  let base: string;
  let adminId: string;
  let userId: string;
  let address = 0;

  const post = (body: unknown, ip?: string) =>
    fetch(`${base}/api/leads`, {
      method: "POST",
      // Each test posts from its own address unless it is testing the limit.
      headers: { "Content-Type": "application/json", "X-Real-IP": ip ?? `10.0.0.${++address}` },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  const lead = (email: string) => ({ name: "Sara Khan", company: "Acme", email, teamSize: "21 to 50", plan: "Enterprise" });
  const ctxFor = (id: string, role: string) =>
    ({ user: { id, role }, req: { protocol: "https", headers: {} }, res: { cookie: () => {}, clearCookie: () => {} } }) as unknown as TrpcContext;

  beforeAll(async () => {
    await mongoose.connect(process.env.MONGODB_URI as string);
    const stamp = Date.now();
    const [admin, user] = await User.create([
      { openId: `lead-adm-${stamp}`, name: "Lead Admin", role: "admin", employeeId: `LADM${stamp}` },
      { openId: `lead-usr-${stamp}`, name: "Lead User", role: "user", employeeId: `LUSR${stamp}` },
    ]);
    adminId = String(admin._id);
    userId = String(user._id);
    const app = express();
    app.use(leadsHttpRouter);
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server?.close();
    if (!adminId) return;
    await Lead.deleteMany({ email: /@leadtest\.example$/ });
    await Notification.deleteMany({ userId: { $in: [adminId, userId] } });
    await User.deleteMany({ _id: { $in: [adminId, userId] } });
    await mongoose.connection.close();
  });

  beforeEach(async () => {
    await Lead.deleteMany({ email: /@leadtest\.example$/ });
    await Notification.deleteMany({ userId: { $in: [adminId, userId] } });
  });

  it("saves a sign-up, tells the admins, and only admins can read it", async () => {
    const response = await post({ ...lead("Sara@LeadTest.example"), status: "closed", note: "injected" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });

    const saved = await Lead.find({ email: "sara@leadtest.example" }).lean();
    expect(saved).toHaveLength(1);
    // Fields the page does not send cannot be set from outside.
    expect(saved[0]).toMatchObject({ name: "Sara Khan", company: "Acme", plan: "Enterprise", status: "new", source: "landing" });
    expect(saved[0].note).toBeUndefined();

    // The notification is sent after the response, so give it a moment.
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(await Notification.countDocuments({ userId: adminId, title: "New sign-up from the website" })).toBe(1);
    expect(await Notification.countDocuments({ userId })).toBe(0);

    const list = await appRouter.createCaller(ctxFor(adminId, "admin")).leads.list();
    expect(list.some(row => row.email === "sara@leadtest.example")).toBe(true);
    await expect(appRouter.createCaller(ctxFor(userId, "user")).leads.list()).rejects.toThrow(/Only admins/);
    await expect(appRouter.createCaller(ctxFor(userId, "dept_head")).leads.list()).rejects.toThrow(/Only admins/);
  });

  it("does not store the same sign-up twice on a double submit", async () => {
    await post(lead("twice@leadtest.example"));
    const second = await post(lead("TWICE@leadtest.example"));
    expect(second.status).toBe(200);
    expect(await Lead.countDocuments({ email: "twice@leadtest.example" })).toBe(1);
  });

  it("refuses bad input and quietly drops a bot that fills the hidden field", async () => {
    expect((await post({ name: "", company: "Acme", email: "x@leadtest.example" })).status).toBe(400);
    expect((await post({ ...lead("bad"), email: "nope" })).status).toBe(400);
    expect((await post("{not json")).status).toBe(400);
    expect((await post({ ...lead("big@leadtest.example"), name: "x".repeat(20000) })).status).toBe(413);

    const bot = await post({ ...lead("bot@leadtest.example"), website: "http://spam.example" });
    expect(bot.status).toBe(200);
    expect(await Lead.countDocuments({ email: /@leadtest\.example$/ })).toBe(0);
  });

  it("limits how many sign-ups one address can send", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 7; i += 1) statuses.push((await post(lead(`flood${i}@leadtest.example`), "203.0.113.9")).status);
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429, 429]);
    expect(await Lead.countDocuments({ email: /^flood/ })).toBe(5);
    // Someone else is not caught by that address's limit.
    expect((await post(lead("other@leadtest.example"), "203.0.113.10")).status).toBe(200);
  });

  it("lets an admin mark a sign-up as contacted, and nobody else", async () => {
    await post(lead("mark@leadtest.example"));
    const admin = appRouter.createCaller(ctxFor(adminId, "admin"));
    const row = (await admin.leads.list()).find(item => item.email === "mark@leadtest.example")!;
    await expect(appRouter.createCaller(ctxFor(userId, "user")).leads.update({ id: row.id, status: "closed" })).rejects.toThrow(/Only admins/);
    await admin.leads.update({ id: row.id, status: "contacted", note: "Called, demo on Thursday" });
    const after = (await admin.leads.list()).find(item => item.id === row.id)!;
    expect(after).toMatchObject({ status: "contacted", note: "Called, demo on Thursday" });
  });
});
