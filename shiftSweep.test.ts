import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import mongoose from "mongoose";
import { TimeEntry, User } from "./models";
import { decideSweep, sweepStaleSessions, MAX_SESSION_HOURS } from "./shiftSweep";
import { describeWithDb } from "./test-utils";

const HOUR = 60 * 60 * 1000;
const NOW = new Date("2026-09-12T12:00:00.000Z");

/** Arithmetic only - no database, no real clock. */
describe("decideSweep", () => {
  const ago = (hours: number) => new Date(NOW.getTime() - hours * HOUR);

  it("leaves a session that is still within the limit", () => {
    const decisions = decideSweep([{ id: "a", timeIn: ago(11.9) }], NOW, 12);
    expect(decisions).toEqual([]);
  });

  it("leaves one sitting exactly on the limit", () => {
    // Closing at exactly 12h would clock someone out mid-keystroke on a long
    // but legitimate day; it takes going past it.
    const decisions = decideSweep([{ id: "a", timeIn: ago(12) }], NOW, 12);
    expect(decisions).toEqual([]);
  });

  it("closes one past the limit at the limit, not at now", () => {
    const timeIn = ago(30);
    const [decision] = decideSweep([{ id: "a", timeIn }], NOW, 12);

    expect(decision.totalHours).toBe(12);
    expect(decision.timeOut.getTime()).toBe(timeIn.getTime() + 12 * HOUR);
    // Emphatically not "now": the person stopped working long before the
    // sweep noticed, and 30 hours is not a day's work.
    expect(decision.timeOut.getTime()).toBeLessThan(NOW.getTime());
  });

  it("records the limit however late the sweep runs", () => {
    // The process being down for a week must not turn into a week-long shift.
    const [decision] = decideSweep([{ id: "a", timeIn: ago(24 * 81) }], NOW, 12);
    expect(decision.totalHours).toBe(12);
  });

  it("honours a different limit", () => {
    const [decision] = decideSweep([{ id: "a", timeIn: ago(10) }], NOW, 8);
    expect(decision.totalHours).toBe(8);
  });

  it("skips a row with an unusable timeIn instead of writing NaN hours", () => {
    const decisions = decideSweep(
      [{ id: "bad", timeIn: new Date("not a date") }, { id: "ok", timeIn: ago(20) }],
      NOW,
      12
    );
    expect(decisions.map(d => d.id)).toEqual(["ok"]);
  });
});

/**
 * The write itself.
 *   TEST_MONGODB_URI="mongodb://.../hrms_test" npx vitest run shiftSweep.test.ts
 */
describeWithDb("sweepStaleSessions", () => {
  let userId: string;

  beforeAll(async () => {
    await mongoose.connect(process.env.MONGODB_URI as string);
    const stamp = Date.now();
    const user = await User.create({
      openId: `sweep-${stamp}`,
      name: "Sweep Subject",
      role: "user",
      employeeId: `SWP${stamp}`,
    });
    userId = String(user._id);
  });

  afterAll(async () => {
    if (!userId) return;
    await TimeEntry.deleteMany({ userId });
    await User.deleteMany({ _id: userId });
    await mongoose.connection.close();
  });

  beforeEach(async () => {
    await TimeEntry.deleteMany({ userId });
  });

  const openSession = (hoursAgo: number) =>
    TimeEntry.create({
      userId,
      timeIn: new Date(Date.now() - hoursAgo * HOUR),
      status: "active",
    });

  it("closes a stale session and marks it as not the person's own doing", async () => {
    const entry = await openSession(30);

    expect(await sweepStaleSessions()).toBe(1);

    const saved = await TimeEntry.findById(entry._id).lean();
    expect(saved!.status).toBe("completed");
    expect(saved!.totalHours).toBe(MAX_SESSION_HOURS);
    expect(saved!.autoClockedOut).toBe(true);
    // Closed at the limit after clock-in, so the row cannot claim 30 hours.
    expect(new Date(saved!.timeOut as Date).getTime()).toBe(
      new Date(saved!.timeIn).getTime() + MAX_SESSION_HOURS * HOUR
    );
  });

  it("leaves a session that is still running normally", async () => {
    const entry = await openSession(3);

    expect(await sweepStaleSessions()).toBe(0);

    const saved = await TimeEntry.findById(entry._id).lean();
    expect(saved!.status).toBe("active");
    expect(saved!.timeOut).toBeUndefined();
  });

  it("does not touch a session the person closed themselves", async () => {
    const timeIn = new Date(Date.now() - 40 * HOUR);
    const timeOut = new Date(timeIn.getTime() + 9 * HOUR);
    const entry = await TimeEntry.create({
      userId, timeIn, timeOut, totalHours: 9, status: "completed",
    });

    await sweepStaleSessions();

    const saved = await TimeEntry.findById(entry._id).lean();
    expect(saved!.totalHours).toBe(9);
    expect(saved!.autoClockedOut).toBeFalsy();
  });

  it("is safe to run twice", async () => {
    await openSession(30);

    expect(await sweepStaleSessions()).toBe(1);
    // Nothing left to close, and the first result must not be re-closed at a
    // new time on every pass.
    expect(await sweepStaleSessions()).toBe(0);
  });
});
