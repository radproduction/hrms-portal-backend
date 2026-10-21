import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import fs from "node:fs";
import path from "node:path";
import mongoose from "mongoose";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { Notification, User } from "./models";
import { FpbColumn, FpbProject, FpbProjectMember, FpbSubproject, FpbActivity } from "./fpbModels";
import {
  ClientFeedback,
  ClientRound,
  clientFeedbackHttpRouter,
  feedbackInput,
  isOpenableMonth,
  monthKeyOf,
  monthLabel,
  roundSteps,
  webUrl,
} from "./clientRounds";
import { UPLOADS_DIR } from "./storage";
import { describeWithDb } from "./test-utils";

const answers = {
  satisfaction: "excellent",
  progress: "mostly_on_track",
  communication: "good",
  concerns: ["no_major_concerns"],
  improvement: "clearer_reporting",
  comments: "Keep it up.",
};

describe("client round helpers", () => {
  it("puts an instant in the office-local month", () => {
    // 20:00 UTC on 31 October is already 1 November in Karachi.
    expect(monthKeyOf(new Date("2026-10-31T20:00:00Z"), 300)).toBe("2026-11");
    expect(monthKeyOf(new Date("2026-10-31T18:00:00Z"), 300)).toBe("2026-10");
    expect(monthLabel("2026-10")).toBe("October 2026");
  });

  it("only opens months from two years back to three ahead", () => {
    const now = new Date("2026-10-15T08:00:00Z");
    expect(isOpenableMonth("2026-10", now, 300)).toBe(true);
    expect(isOpenableMonth("2027-01", now, 300)).toBe(true);
    expect(isOpenableMonth("2027-02", now, 300)).toBe(false);
    expect(isOpenableMonth("2024-10", now, 300)).toBe(true);
    expect(isOpenableMonth("2024-09", now, 300)).toBe(false);
    expect(isOpenableMonth("2026-13", now, 300)).toBe(false);
    expect(isOpenableMonth("2026-1", now, 300)).toBe(false);
  });

  it("counts a step done only when it has what it needs", () => {
    const at = new Date();
    expect(roundSteps({}).done).toBe(0);
    // A "sent" date with nothing attached is not a sent report.
    expect(roundSteps({ reportSentAt: at }).reportSent).toBe(false);
    expect(roundSteps({ reportSentAt: at, reportUrl: "https://x.example" }).reportSent).toBe(true);
    const full = roundSteps({
      reportSentAt: at, reportUrl: "https://x.example", meetingAt: at, meetingDoneAt: at,
      invoiceSentAt: at, invoiceFile: { url: "/uploads/a.pdf", key: "a.pdf", name: "a.pdf" }, paidAt: at,
    });
    expect(full).toMatchObject({ reportSent: true, meetingScheduled: true, meetingDone: true, invoiceSent: true, invoicePaid: true, done: 5 });
  });

  it("accepts only web links", () => {
    expect(webUrl.safeParse("https://drive.google.com/file/d/1").success).toBe(true);
    expect(webUrl.safeParse("javascript:alert(1)").success).toBe(false);
    expect(webUrl.safeParse("drive.google.com").success).toBe(false);
  });
});

describe("feedback answers", () => {
  it("takes a full answer and drops fields it does not know", () => {
    const parsed = feedbackInput.parse({ ...answers, role: "admin" });
    expect(parsed).toMatchObject({ satisfaction: "excellent", concerns: ["no_major_concerns"], otherConcern: "" });
    expect((parsed as any).role).toBeUndefined();
  });

  it("refuses missing or unknown choices", () => {
    expect(feedbackInput.safeParse({ ...answers, satisfaction: "amazing" }).success).toBe(false);
    expect(feedbackInput.safeParse({ ...answers, concerns: [] }).success).toBe(false);
    const { improvement: _skip, ...missing } = answers;
    expect(feedbackInput.safeParse(missing).success).toBe(false);
    expect(feedbackInput.safeParse({ ...answers, comments: "x".repeat(4001) }).success).toBe(false);
  });

  it("drops 'no major concerns' next to a real concern, and needs words for 'other'", () => {
    const mixed = feedbackInput.parse({ ...answers, concerns: ["no_major_concerns", "quality_of_work", "quality_of_work"] });
    expect(mixed.concerns).toEqual(["quality_of_work"]);
    expect(feedbackInput.safeParse({ ...answers, concerns: ["other"] }).success).toBe(false);
    expect(feedbackInput.parse({ ...answers, concerns: ["other"], otherConcern: "Slow approvals" }).otherConcern).toBe("Slow approvals");
    // Text for "other" is ignored when "other" is not ticked.
    expect(feedbackInput.parse({ ...answers, otherConcern: "ignored" }).otherConcern).toBe("");
  });
});

describeWithDb("client rounds", () => {
  let adminId: string;
  let ownerId: string;
  let memberId: string;
  let outsiderId: string;
  let projectId: string;
  let server: Server;
  let base: string;
  let address = 0;

  const ctxFor = (id: string, role: string) =>
    ({ user: { id, role }, req: { protocol: "https", headers: {} }, res: { cookie: () => {}, clearCookie: () => {} } }) as unknown as TrpcContext;
  const as = (id: string, role = "user") => appRouter.createCaller(ctxFor(id, role));
  const month = monthKeyOf(new Date());
  const pdf = Buffer.from("%PDF-1.4 test").toString("base64");

  const getForm = (token: string) =>
    fetch(`${base}/api/client-feedback/${token}`, { headers: { "X-Real-IP": `10.1.0.${++address}` } });
  const postForm = (token: string, body: unknown) =>
    fetch(`${base}/api/client-feedback/${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Real-IP": `10.1.0.${++address}` },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    await mongoose.connect(process.env.MONGODB_URI as string);
    const stamp = Date.now();
    const [admin, owner, member, outsider] = await User.create([
      { openId: `cr-adm-${stamp}`, name: "Round Admin", role: "admin", employeeId: `CRA${stamp}` },
      { openId: `cr-own-${stamp}`, name: "Round Owner", role: "dept_head", employeeId: `CRO${stamp}` },
      { openId: `cr-mem-${stamp}`, name: "Round Member", role: "user", employeeId: `CRM${stamp}` },
      { openId: `cr-out-${stamp}`, name: "Round Outsider", role: "user", employeeId: `CRX${stamp}` },
    ]);
    [adminId, ownerId, memberId, outsiderId] = [admin, owner, member, outsider].map(u => String(u._id));
    const app = express();
    app.use(clientFeedbackHttpRouter);
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server?.close();
    if (!adminId) return;
    const ids = [adminId, ownerId, memberId, outsiderId];
    await ClientFeedback.deleteMany({ projectId });
    await ClientRound.deleteMany({ projectId });
    await FpbColumn.deleteMany({ projectId });
    await FpbSubproject.deleteMany({ projectId });
    await FpbProjectMember.deleteMany({ projectId });
    await FpbActivity.deleteMany({ projectId });
    await FpbProject.deleteMany({ _id: projectId });
    await Notification.deleteMany({ userId: { $in: ids } });
    await User.deleteMany({ _id: { $in: ids } });
    await mongoose.connection.close();
  });

  beforeEach(async () => {
    if (projectId) {
      await ClientFeedback.deleteMany({ projectId });
      await ClientRound.deleteMany({ projectId });
      await FpbProject.deleteMany({ _id: projectId });
      await FpbProjectMember.deleteMany({ projectId });
    }
    // The owner is not an admin: they made the project, which is what lets them run it.
    const project = await FpbProject.create({ title: "Acme retainer", projectType: "management", createdBy: ownerId });
    projectId = String(project._id);
    await FpbProjectMember.create({ projectId, userId: memberId });
    await Notification.deleteMany({ userId: { $in: [adminId, ownerId, memberId, outsiderId] } });
  });

  it("lets the owner run a month, members look, and outsiders nothing", async () => {
    const round = await as(ownerId, "dept_head").clientRounds.create({ projectId, month });
    expect(round.steps.done).toBe(0);
    expect(round.feedbackToken).toMatch(/^[0-9a-f]{48}$/);

    // Opening the same month again returns it rather than a second copy.
    const again = await as(ownerId, "dept_head").clientRounds.create({ projectId, month });
    expect(again.id).toBe(round.id);
    expect(await ClientRound.countDocuments({ projectId })).toBe(1);

    const seen = await as(memberId).clientRounds.list({ projectId });
    expect(seen.canEdit).toBe(false);
    expect(seen.rounds).toHaveLength(1);
    // A member does not get the client's link.
    expect(seen.rounds[0].feedbackToken).toBeNull();

    await expect(as(memberId).clientRounds.update({ roundId: round.id, meetingAt: new Date() })).rejects.toThrow(/created this project/);
    await expect(as(memberId).clientRounds.create({ projectId, month })).rejects.toThrow(/created this project/);
    await expect(as(outsiderId).clientRounds.list({ projectId })).rejects.toThrow(/not on this project/);

    // An admin who is not on the project may still run it.
    const byAdmin = await as(adminId, "admin").clientRounds.update({ roundId: round.id, meetingAt: new Date() });
    expect(byAdmin.steps.meetingScheduled).toBe(true);
  });

  it("keeps the five steps in order", async () => {
    const owner = as(ownerId, "dept_head").clientRounds;
    const round = await owner.create({ projectId, month });

    await expect(owner.update({ roundId: round.id, reportSentAt: new Date() })).rejects.toThrow(/report link or file/);
    await expect(owner.update({ roundId: round.id, meetingDoneAt: new Date() })).rejects.toThrow(/meeting date/);
    await expect(owner.update({ roundId: round.id, invoiceSentAt: new Date() })).rejects.toThrow(/invoice file or link/);

    let saved = await owner.update({ roundId: round.id, reportUrl: "https://drive.example/report", reportSentAt: new Date() });
    expect(saved.steps.reportSent).toBe(true);
    await expect(owner.update({ roundId: round.id, reportUrl: "javascript:alert(1)" })).rejects.toThrow();

    const meeting = new Date(Date.now() + 3 * 86400000);
    saved = await owner.update({ roundId: round.id, meetingAt: meeting });
    saved = await owner.update({ roundId: round.id, meetingDoneAt: new Date(), meetingNotes: "Went well" });
    expect(saved.steps).toMatchObject({ meetingScheduled: true, meetingDone: true });

    // Clearing the meeting date clears "done" with it.
    saved = await owner.update({ roundId: round.id, meetingAt: null });
    expect(saved.steps).toMatchObject({ meetingScheduled: false, meetingDone: false });
    expect(saved.meetingDoneAt).toBeNull();

    await expect(owner.update({ roundId: round.id, paidAt: new Date() })).rejects.toThrow(/invoice as sent/);
    saved = await owner.attachFile({ roundId: round.id, kind: "invoice", fileName: "INV-12.pdf", fileBase64: pdf, mimeType: "application/pdf" });
    // Uploading the invoice marks it sent today.
    expect(saved.steps.invoiceSent).toBe(true);
    expect(saved.invoiceFile?.name).toBe("INV-12.pdf");
    saved = await owner.update({ roundId: round.id, paidAt: new Date(), paidAmount: 150000, invoiceAmount: 150000, invoiceCurrency: "PKR" });
    expect(saved.steps.invoicePaid).toBe(true);

    // Taking the only invoice away un-sends and un-pays it, and deletes the file.
    const stored = (await ClientRound.findById(round.id).lean())!.invoiceFile!;
    expect(fs.existsSync(path.join(UPLOADS_DIR, stored.key))).toBe(true);
    saved = await owner.removeFile({ roundId: round.id, kind: "invoice" });
    expect(saved.steps).toMatchObject({ invoiceSent: false, invoicePaid: false });
    expect(fs.existsSync(path.join(UPLOADS_DIR, stored.key))).toBe(false);
  });

  it("stores uploads under a random name and refuses other file types", async () => {
    const owner = as(ownerId, "dept_head").clientRounds;
    const round = await owner.create({ projectId, month });
    await expect(
      owner.attachFile({ roundId: round.id, kind: "report", fileName: "x.html", fileBase64: pdf, mimeType: "text/html" })
    ).rejects.toThrow(/PDF, image/);
    const saved = await owner.attachFile({ roundId: round.id, kind: "report", fileName: "Oct report.pdf", fileBase64: pdf, mimeType: "application/pdf" });
    expect(saved.reportFile?.url).toMatch(/^\/uploads\/client-rounds\/[0-9a-f]{24}\/report-[0-9a-f]{32}\.pdf$/);
    expect(saved.steps.reportSent).toBe(true);
    await owner.delete({ roundId: round.id });
    expect(await ClientRound.countDocuments({ projectId })).toBe(0);
  });

  it("takes one feedback answer per month from the public link, and tells the owner", async () => {
    const owner = as(ownerId, "dept_head").clientRounds;
    const round = await owner.create({ projectId, month });
    const token = round.feedbackToken!;

    const form = await getForm(token);
    expect(form.status).toBe(200);
    expect(await form.json()).toMatchObject({ ok: true, company: "Heard Studio", projectTitle: "Acme retainer", submitted: false });
    expect((await getForm("0".repeat(48))).status).toBe(404);
    expect((await getForm("not-a-token")).status).toBe(404);

    expect((await postForm(token, { ...answers, satisfaction: "amazing" })).status).toBe(400);
    expect((await postForm(token, answers)).status).toBe(200);
    // The link takes one answer.
    expect((await postForm(token, answers)).status).toBe(409);
    expect(await (await getForm(token)).json()).toMatchObject({ submitted: true });

    await new Promise(resolve => setTimeout(resolve, 100));
    const told = await Notification.find({ userId: { $in: [ownerId, adminId] }, title: "Client feedback received" }).lean();
    expect(told.map(n => String(n.userId)).sort()).toEqual([adminId, ownerId].sort());
    expect(await Notification.countDocuments({ userId: memberId })).toBe(0);

    // The owner reads the answers; a member only sees that one came in.
    const forOwner = await owner.list({ projectId });
    expect(forOwner.rounds[0].feedback).toMatchObject({ satisfaction: "excellent", comments: "Keep it up." });
    const forMember = await as(memberId).clientRounds.list({ projectId });
    expect(forMember.rounds[0].feedback).toBeNull();
    expect(forMember.rounds[0].feedbackSubmittedAt).not.toBeNull();

    // An answered link cannot be swapped for a new one.
    await expect(owner.resetFeedbackLink({ roundId: round.id })).rejects.toThrow(/already answered/);
  });

  it("drops a bot that fills the hidden field, and retires an old link on reset", async () => {
    const owner = as(ownerId, "dept_head").clientRounds;
    const round = await owner.create({ projectId, month });
    expect((await postForm(round.feedbackToken!, { ...answers, website: "spam" })).status).toBe(200);
    expect(await ClientFeedback.countDocuments({ roundId: round.id })).toBe(0);

    const reset = await owner.resetFeedbackLink({ roundId: round.id });
    expect(reset.feedbackToken).not.toBe(round.feedbackToken);
    expect((await getForm(round.feedbackToken!)).status).toBe(404);
    expect((await getForm(reset.feedbackToken!)).status).toBe(200);
  });

  it("lists meetings for the calendar from the projects the caller can see", async () => {
    const owner = as(ownerId, "dept_head").clientRounds;
    const round = await owner.create({ projectId, month });
    const at = new Date(Date.now() + 2 * 86400000);
    await owner.update({ roundId: round.id, meetingAt: at });
    const from = new Date(Date.now() - 86400000);
    const to = new Date(Date.now() + 10 * 86400000);

    const forMember = await as(memberId).clientRounds.meetings({ from, to });
    expect(forMember.find(m => m.roundId === round.id)).toMatchObject({ projectTitle: "Acme retainer" });
    const forOutsider = await as(outsiderId).clientRounds.meetings({ from, to });
    expect(forOutsider.find(m => m.roundId === round.id)).toBeUndefined();
    await expect(as(memberId).clientRounds.meetings({ from: to, to: from })).rejects.toThrow(/four months/);
  });

  it("removes a project's months and feedback when the project is deleted", async () => {
    const owner = as(ownerId, "dept_head").clientRounds;
    const round = await owner.create({ projectId, month });
    await postForm(round.feedbackToken!, answers);
    await as(adminId, "admin").fpb.deleteProject({ id: projectId });
    expect(await ClientRound.countDocuments({ projectId })).toBe(0);
    expect(await ClientFeedback.countDocuments({ projectId })).toBe(0);
  });
});
