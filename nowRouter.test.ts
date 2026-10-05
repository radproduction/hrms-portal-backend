import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import mongoose from "mongoose";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { BreakLog, LeaveApplication, Notification, TimeEntry, User } from "./models";
import { EmployeeRequest, WingmanMessage, WingmanSettings } from "./nowModels";
import { localDateKey } from "./attendance";
import { addDays, localDayStart } from "./nowTime";
import { describeWithDb } from "./test-utils";

/**
 * The Now workspace APIs: requests, the employee's own time, and Wingman.
 *
 * Needs a throwaway database:
 *   TEST_MONGODB_URI="mongodb://.../hrms_test" npm test
 */
describeWithDb("Now workspace APIs", () => {
  let adminId: string;
  let employeeId: string;
  let otherId: string;

  const ctxFor = (id: string, role: string, name: string) =>
    ({
      user: { id, role, name },
      req: { protocol: "https", headers: {} },
      res: { cookie: () => {}, clearCookie: () => {} },
    }) as unknown as TrpcContext;

  const asAdmin = () => appRouter.createCaller(ctxFor(adminId, "admin", "Now Admin"));
  const asEmployee = () => appRouter.createCaller(ctxFor(employeeId, "user", "Now Employee"));
  const asOther = () => appRouter.createCaller(ctxFor(otherId, "user", "Now Other"));

  const todayKey = () => localDateKey(new Date());
  /** An instant on an office-local day, e.g. at(key, 10, 5) is 10:05 that day. */
  const at = (dateKey: string, hours: number, minutes = 0) =>
    new Date(localDayStart(dateKey).getTime() + (hours * 60 + minutes) * 60 * 1000);

  const clearOwned = async () => {
    const ids = [adminId, employeeId, otherId];
    await Promise.all([
      EmployeeRequest.deleteMany({ userId: { $in: ids } }),
      WingmanMessage.deleteMany({ userId: { $in: ids } }),
      WingmanSettings.deleteMany({ userId: { $in: ids } }),
      TimeEntry.deleteMany({ userId: { $in: ids } }),
      BreakLog.deleteMany({ userId: { $in: ids } }),
      LeaveApplication.deleteMany({ userId: { $in: ids } }),
      Notification.deleteMany({ userId: { $in: ids } }),
    ]);
  };

  beforeAll(async () => {
    await mongoose.connect(process.env.MONGODB_URI as string);
    const stamp = Date.now();
    const [admin, employee, other] = await User.create([
      { openId: `now-adm-${stamp}`, name: "Now Admin", role: "admin", employeeId: `NADM${stamp}` },
      { openId: `now-emp-${stamp}`, name: "Now Employee", role: "user", employeeId: `NEMP${stamp}` },
      { openId: `now-oth-${stamp}`, name: "Now Other", role: "user", employeeId: `NOTH${stamp}` },
    ]);
    adminId = String(admin._id);
    employeeId = String(employee._id);
    otherId = String(other._id);
  });

  afterAll(async () => {
    if (!adminId) return;
    await clearOwned();
    await User.deleteMany({ _id: { $in: [adminId, employeeId, otherId] } });
    await mongoose.connection.close();
  });

  beforeEach(clearOwned);

  // ------------------------------------------------------------- requests

  it("refuses an attendance correction with no day or no times", async () => {
    await expect(
      asEmployee().requests.create({ kind: "attendance_correction", subject: "Forgot to clock out" })
    ).rejects.toThrow();
    await expect(
      asEmployee().requests.create({
        kind: "attendance_correction",
        subject: "Forgot to clock out",
        workDate: at(addDays(todayKey(), -3), 0),
      })
    ).rejects.toThrow();
    expect(await EmployeeRequest.countDocuments({ userId: employeeId })).toBe(0);
  });

  it("closes the day's open entry when a correction is approved, and tells the employee", async () => {
    const day = addDays(todayKey(), -3);
    await TimeEntry.create({ userId: employeeId, timeIn: at(day, 10, 2), status: "active" });

    await asEmployee().requests.create({
      kind: "attendance_correction",
      subject: `Clock-out correction, ${day}`,
      details: "Left around 18:40",
      workDate: at(day, 0),
      requestedTimeOut: at(day, 18, 40),
    });
    const [request] = await asAdmin().requests.getForReview();
    expect(request).toMatchObject({ status: "pending", user: { name: "Now Employee" } });

    const result = await asAdmin().requests.review({ id: request.id, status: "approved", note: "Confirmed from chat" });
    expect(result.appliedToAttendance).toBe(true);

    const entries = await TimeEntry.find({ userId: employeeId }).lean();
    // The existing entry was corrected, not joined by a second one.
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ status: "completed", totalHours: 8.63, autoClockedOut: false });
    expect(entries[0].timeOut?.getTime()).toBe(at(day, 18, 40).getTime());
    expect(entries[0].notes).toContain("approved by Now Admin");

    const [mine] = await asEmployee().requests.getMine();
    expect(mine).toMatchObject({ status: "approved", reviewNote: "Confirmed from chat", appliedToAttendance: true });
    const pings = await Notification.find({ userId: employeeId }).lean();
    expect(pings.map(p => p.title)).toContain("Request approved");
  });

  it("creates the entry when the day had none and both times were given", async () => {
    const day = addDays(todayKey(), -4);
    await asEmployee().requests.create({
      kind: "attendance_correction",
      subject: "Portal was down, could not clock",
      workDate: at(day, 0),
      requestedTimeIn: at(day, 10, 0),
      requestedTimeOut: at(day, 15, 0),
    });
    const [request] = await asAdmin().requests.getForReview();
    await asAdmin().requests.review({ id: request.id, status: "approved" });
    const entries = await TimeEntry.find({ userId: employeeId }).lean();
    expect(entries).toHaveLength(1);
    // Five hours is under the 6.5 hour line, so it is recorded as an early out.
    expect(entries[0]).toMatchObject({ totalHours: 5, status: "early_out" });
  });

  it("leaves attendance alone when a correction is rejected", async () => {
    const day = addDays(todayKey(), -2);
    await TimeEntry.create({ userId: employeeId, timeIn: at(day, 10, 0), status: "active" });
    await asEmployee().requests.create({
      kind: "attendance_correction", subject: "Fix", workDate: at(day, 0), requestedTimeOut: at(day, 19, 0),
    });
    const [request] = await asAdmin().requests.getForReview();
    const result = await asAdmin().requests.review({ id: request.id, status: "rejected", note: "Times do not match" });
    expect(result.appliedToAttendance).toBe(false);
    const entry = await TimeEntry.findOne({ userId: employeeId }).lean();
    expect(entry?.status).toBe("active");
    expect(entry?.timeOut).toBeFalsy();
  });

  it("only lets the right people review, and only once", async () => {
    await asEmployee().requests.create({ kind: "support_ticket", subject: "Laptop charger stopped working", category: "equipment" });
    const [request] = await asAdmin().requests.getForReview();

    // A colleague it was not sent to sees nothing and cannot act on it.
    expect(await asOther().requests.getForReview()).toEqual([]);
    await expect(asOther().requests.review({ id: request.id, status: "resolved" })).rejects.toThrow(/not sent to you/);
    // A ticket is resolved, not approved.
    await expect(asAdmin().requests.review({ id: request.id, status: "approved" })).rejects.toThrow(/Resolve or reject/);

    await asAdmin().requests.review({ id: request.id, status: "resolved" });
    await expect(asAdmin().requests.review({ id: request.id, status: "rejected" })).rejects.toThrow(/already been closed/);
    expect((await asEmployee().requests.getMine())[0].status).toBe("resolved");
  });

  it("does not let an admin review their own request", async () => {
    await asAdmin().requests.create({ kind: "support_ticket", subject: "Monitor flickers" });
    const own = (await asAdmin().requests.getMine())[0];
    await expect(asAdmin().requests.review({ id: own.id, status: "resolved" })).rejects.toThrow(/your own request/);
  });

  // ----------------------------------------------------------------- time

  it("returns the caller's own four weeks and leave balance", async () => {
    const day = addDays(todayKey(), -1);
    await TimeEntry.create({ userId: otherId, timeIn: at(day, 10, 0), timeOut: at(day, 18, 0), totalHours: 8, status: "completed" });
    const mine = await asEmployee().time.getFourWeeks();
    // Somebody else's attendance never shows up in mine.
    expect(mine.stats.daysPresent).toBe(0);
    const theirs = await asOther().time.getFourWeeks();
    expect(theirs.stats.daysPresent).toBe(1);

    const balance = await asEmployee().time.getLeaveBalance();
    expect(balance.rows.map(r => r.type)).toEqual(["annual", "casual", "sick"]);
    expect(balance.rows.every(r => r.used === 0 && r.left === r.quota)).toBe(true);
  });

  // -------------------------------------------------------------- wingman

  it("clocks in and out when asked, and says so plainly when it cannot", async () => {
    const first = await asEmployee().wingman.ask({ text: "Clock me in" });
    expect(first.reply.text).toMatch(/clocked in at \d\d:\d\d/);
    expect(await TimeEntry.countDocuments({ userId: employeeId, status: "active" })).toBe(1);

    const again = await asEmployee().wingman.ask({ text: "clock me in" });
    expect(again.reply.text).toMatch(/already clocked in/);
    expect(await TimeEntry.countDocuments({ userId: employeeId })).toBe(1);

    // A clock-out for later is refused rather than done now by mistake.
    const later = await asEmployee().wingman.ask({ text: "Clock me out at 7" });
    expect(later.reply.text).toMatch(/cannot clock you out at a later time/);
    expect(await TimeEntry.countDocuments({ userId: employeeId, status: "active" })).toBe(1);

    const out = await asEmployee().wingman.ask({ text: "clock me out" });
    expect(out.reply.text).toMatch(/clocked out/);
    expect(await TimeEntry.countDocuments({ userId: employeeId, status: "active" })).toBe(0);
  });

  it("starts and ends a break only while clocked in", async () => {
    expect((await asEmployee().wingman.ask({ text: "Start my break" })).reply.text).toMatch(/not clocked in/);
    await asEmployee().wingman.ask({ text: "clock me in" });
    expect((await asEmployee().wingman.ask({ text: "Start my break" })).reply.text).toMatch(/Break started/);
    expect((await asEmployee().wingman.ask({ text: "Start my break" })).reply.text).toMatch(/already running/);
    expect((await asEmployee().wingman.ask({ text: "end my break" })).reply.text).toMatch(/Break ended/);
    expect((await asEmployee().wingman.ask({ text: "end my break" })).reply.text).toMatch(/no break running/);
    expect(await BreakLog.countDocuments({ userId: employeeId })).toBe(1);
  });

  it("drafts leave and sends it only on confirmation, exactly once", async () => {
    const { reply } = await asEmployee().wingman.ask({ text: "Apply a half day for Monday morning" });
    expect(reply.action).toMatchObject({ kind: "leave", status: "ready" });
    expect(reply.action?.detail).toMatch(/half day, morning · Casual/);
    // Nothing reached HR yet.
    expect(await LeaveApplication.countDocuments({ userId: employeeId })).toBe(0);

    // Nobody else can send it for them.
    await expect(asOther().wingman.confirmAction({ messageId: reply.id })).rejects.toThrow(/already been sent or cancelled/);
    expect(await LeaveApplication.countDocuments({ userId: employeeId })).toBe(0);

    const sent = await asEmployee().wingman.confirmAction({ messageId: reply.id });
    expect(sent.message.action).toMatchObject({ status: "sent", title: "Leave request sent" });
    await expect(asEmployee().wingman.confirmAction({ messageId: reply.id })).rejects.toThrow(/already been sent or cancelled/);

    const leaves = await LeaveApplication.find({ userId: employeeId }).lean();
    expect(leaves).toHaveLength(1);
    expect(leaves[0]).toMatchObject({ leaveType: "casual", status: "pending" });
    expect(leaves[0].reason).toContain("Half day (morning)");
    expect(localDateKey(leaves[0].startDate)).toBe(localDateKey(leaves[0].endDate));
    // It was routed to a senior, who was told.
    expect(String(leaves[0].approverUserId ?? "")).not.toBe("");
  });

  it("does not send a cancelled draft, and asks for a date when none was given", async () => {
    const { reply } = await asEmployee().wingman.ask({ text: "sick leave tomorrow" });
    await asEmployee().wingman.cancelAction({ messageId: reply.id });
    await expect(asEmployee().wingman.confirmAction({ messageId: reply.id })).rejects.toThrow();
    expect(await LeaveApplication.countDocuments({ userId: employeeId })).toBe(0);

    const vague = await asEmployee().wingman.ask({ text: "I need leave" });
    expect(vague.reply.action).toBeNull();
    expect(vague.reply.text).toMatch(/Which day/);
  });

  it("sends straight away once 'ask before sending' is turned off", async () => {
    expect(await asEmployee().wingman.getSettings()).toMatchObject({ askBeforeSending: true, whatsapp: false });
    const updated = await asEmployee().wingman.updateSettings({ askBeforeSending: false });
    expect(updated).toMatchObject({ askBeforeSending: false, morningBrief: true });
    // One person's setting is theirs alone.
    expect((await asOther().wingman.getSettings()).askBeforeSending).toBe(true);

    const { reply } = await asEmployee().wingman.ask({ text: "Raise a support ticket for the office wifi dropping" });
    expect(reply.action).toMatchObject({ kind: "support_ticket", status: "sent" });
    const tickets = await EmployeeRequest.find({ userId: employeeId }).lean();
    expect(tickets).toHaveLength(1);
    expect(tickets[0]).toMatchObject({ kind: "support_ticket", subject: "the office wifi dropping", status: "pending" });
  });

  it("keeps each person's chat to themselves, oldest first, and clears on request", async () => {
    await asEmployee().wingman.ask({ text: "tell me a joke" });
    await asEmployee().wingman.ask({ text: "How much leave do I have left?" });
    const history = await asEmployee().wingman.getHistory();
    expect(history.map(m => m.role)).toEqual(["user", "wingman", "user", "wingman"]);
    expect(history[1].text).toMatch(/did not catch that/);
    expect(history[3].items.map(i => i.label)).toEqual(["Annual", "Casual", "Sick"]);
    expect(await asOther().wingman.getHistory()).toEqual([]);

    await asEmployee().wingman.clearHistory();
    expect(await asEmployee().wingman.getHistory()).toEqual([]);
  });

  it("lists days to fix and pending items in the overview", async () => {
    const day = addDays(todayKey(), -5);
    await TimeEntry.create({ userId: employeeId, timeIn: at(day, 10, 0), status: "active" });
    await asEmployee().requests.create({ kind: "support_ticket", subject: "Keyboard keys sticking" });

    const overview = await asEmployee().wingman.getOverview();
    // -5 days can land on a weekend; a worked day with no clock-out needs fixing either way.
    expect(overview.toFix).toEqual([{ date: day, reason: "No clock-out" }]);
    expect(overview.watching[0].title).toMatch(/^No clock-out, /);
    expect(overview.waitingOn).toHaveLength(1);
    expect(overview.waitingOn[0]).toMatchObject({ title: "Keyboard keys sticking", href: "/requests" });
    expect(overview.waitingOn[0].detail).toMatch(/^With /);

    // The admin it was routed to sees it as waiting on them.
    const admin = await asAdmin().wingman.getOverview();
    expect(admin.waitingOnYou.some(item => /request/.test(item.title))).toBe(true);
  });
});
