import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import mongoose from "mongoose";
import { ENV } from "./_core/env";
import { TimeEntry, User } from "./models";
import { clockInUser, handleWingmanClock, notifyWingman } from "./wingman";
import { describeWithDb } from "./test-utils";

const SECRET = "wm-test-secret-0123456789abcdef";
// Stands in for the private token in the real webhook URL.
const TOKEN = "PRIVATE-TOKEN-must-never-be-logged";

const original = { ...ENV };
const configure = (overrides: Partial<typeof ENV>) => Object.assign(ENV, overrides);

afterEach(() => {
  Object.assign(ENV, original);
  vi.restoreAllMocks();
});

/** A stand-in for Wingman's webhook that records what it receives. */
async function startHook(mode: "ok" | "hang" | "500") {
  const hits: Record<string, unknown>[] = [];
  const headers: http.IncomingHttpHeaders[] = [];
  const sockets = new Set<Socket>();
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", chunk => (raw += chunk));
    req.on("end", () => {
      headers.push(req.headers);
      try { hits.push(JSON.parse(raw || "{}")); } catch { hits.push({}); }
      if (mode === "hang") return;
      res.statusCode = mode === "500" ? 500 : 200;
      res.end("{}");
    });
  });
  server.on("connection", socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/work/company-event`,
    hits,
    headers,
    async waitForHits(count: number, ms = 3000) {
      const until = Date.now() + ms;
      while (hits.length < count && Date.now() < until) {
        await new Promise(r => setTimeout(r, 25));
      }
    },
    close: () =>
      new Promise<void>(resolve => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/** Everything decided before the database is touched. */
describe("handleWingmanClock, before any database work", () => {
  it("answers 503 when no secret is configured, rather than accepting anything", async () => {
    configure({ wingmanSecret: "" });
    expect(await handleWingmanClock("anything", { event: "clock_in" })).toEqual({
      status: 503,
      body: { ok: false, error: "wingman_not_configured" },
    });
  });

  it("answers 401 for a wrong secret", async () => {
    configure({ wingmanSecret: SECRET });
    const result = await handleWingmanClock("WRONG", { event: "clock_out" });
    expect(result).toEqual({ status: 401, body: { ok: false, error: "unauthorized" } });
  });

  it("answers 401 for a wrong secret of exactly the right length", async () => {
    configure({ wingmanSecret: SECRET });
    const result = await handleWingmanClock("x".repeat(SECRET.length), { event: "clock_out" });
    expect(result.status).toBe(401);
  });

  it("answers 401 when the header is missing", async () => {
    configure({ wingmanSecret: SECRET });
    expect((await handleWingmanClock(undefined, { event: "clock_out" })).status).toBe(401);
  });

  it("reads the first value when the header arrives twice", async () => {
    configure({ wingmanSecret: SECRET });
    // Passes the secret check, so it reaches validation and fails there.
    const result = await handleWingmanClock([SECRET, "other"], { event: "nap" });
    expect(result.status).toBe(400);
  });

  it("answers 400 for an event it does not know", async () => {
    configure({ wingmanSecret: SECRET });
    const result = await handleWingmanClock(SECRET, { event: "nap" });
    expect(result).toEqual({ status: 400, body: { ok: false, error: "invalid_payload" } });
  });

  it("answers 400 when there is no event at all", async () => {
    configure({ wingmanSecret: SECRET });
    expect((await handleWingmanClock(SECRET, {})).status).toBe(400);
  });
});

/**
 *   TEST_MONGODB_URI="mongodb://.../hrms_test" npx vitest run wingman.test.ts
 */
describeWithDb("Wingman clock, against the database", () => {
  const stamp = Date.now();
  const employeeId = `WMTEST${stamp}`;
  const email = `wm.test.${stamp}@radflow.local`;
  const otherEmployeeId = `WMOTHER${stamp}`;
  let userId: string;
  let otherId: string;

  const active = (id: string) => TimeEntry.findOne({ userId: id, status: "active" }).lean();

  beforeAll(async () => {
    await mongoose.connect(process.env.MONGODB_URI as string);
    const [user, other] = await User.create([
      { openId: `wm-${stamp}`, name: "Wingman Test", role: "user", employeeId, email },
      { openId: `wm-o-${stamp}`, name: "Wingman Other", role: "user", employeeId: otherEmployeeId },
    ]);
    userId = String(user._id);
    otherId = String(other._id);
  });

  afterAll(async () => {
    await TimeEntry.deleteMany({ userId: { $in: [userId, otherId] } });
    await User.deleteMany({ _id: { $in: [userId, otherId] } });
    await mongoose.connection.close();
  });

  beforeEach(async () => {
    await TimeEntry.deleteMany({ userId: { $in: [userId, otherId] } });
    configure({ wingmanSecret: SECRET, wingmanUrl: "", wingmanDefaultEmployee: "" });
  });

  // ------------------------------------------------------------- clocking

  it("clocks someone in by employee id, at the time Wingman gives", async () => {
    const at = "2026-09-14T04:00:00.000Z";
    const result = await handleWingmanClock(SECRET, { event: "clock_in", employee: employeeId, at });

    expect(result).toEqual({ status: 200, body: { ok: true, at } });
    const entry = await active(userId);
    expect(new Date(entry!.timeIn).toISOString()).toBe(at);
  });

  it("finds the person by email as well", async () => {
    const result = await handleWingmanClock(SECRET, { event: "clock_in", employee: email });
    expect(result.status).toBe(200);
    expect(await active(userId)).toBeTruthy();
  });

  it("uses the current time when Wingman sends none", async () => {
    const before = Date.now();
    const result = await handleWingmanClock(SECRET, { event: "clock_in", employee: employeeId });
    const at = Date.parse(String(result.body.at));
    expect(at).toBeGreaterThanOrEqual(before - 1000);
    expect(at).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("clocks the configured person when Wingman names nobody", async () => {
    configure({ wingmanDefaultEmployee: otherEmployeeId });

    const result = await handleWingmanClock(SECRET, { event: "clock_in" });

    expect(result.status).toBe(200);
    expect(await active(otherId)).toBeTruthy();
    expect(await active(userId)).toBeNull();
  });

  it("refuses to guess when there is no employee and no default", async () => {
    const result = await handleWingmanClock(SECRET, { event: "clock_in" });

    expect(result).toEqual({ status: 400, body: { ok: false, error: "employee_required" } });
    // Nobody was clocked in by mistake.
    expect(await TimeEntry.countDocuments({ userId: { $in: [userId, otherId] } })).toBe(0);
  });

  it("answers 404 for someone who does not exist", async () => {
    const result = await handleWingmanClock(SECRET, { event: "clock_in", employee: `nobody-${stamp}` });
    expect(result).toEqual({ status: 404, body: { ok: false, error: "employee_not_found" } });
  });

  it("answers 400 for a time it cannot read", async () => {
    const result = await handleWingmanClock(SECRET, { event: "clock_in", employee: employeeId, at: "not a date" });
    expect(result).toEqual({ status: 400, body: { ok: false, error: "invalid_at" } });
  });

  it("clocks someone out", async () => {
    await handleWingmanClock(SECRET, { event: "clock_in", employee: employeeId, at: "2026-09-14T04:00:00.000Z" });
    const result = await handleWingmanClock(SECRET, { event: "clock_out", employee: employeeId, at: "2026-09-14T13:00:00.000Z" });

    expect(result.status).toBe(200);
    expect(await active(userId)).toBeNull();
    const closed = await TimeEntry.findOne({ userId }).lean();
    expect(closed!.totalHours).toBe(9);
  });

  // ------------------------------------------------------------- retries

  it("treats a repeated clock_in as done rather than as a failure", async () => {
    const body = { event: "clock_in", employee: employeeId };
    expect((await handleWingmanClock(SECRET, body)).status).toBe(200);

    const again = await handleWingmanClock(SECRET, body);

    expect(again.status).toBe(200);
    expect(again.body.unchanged).toBe(true);
    // And it did not open a second session.
    expect(await TimeEntry.countDocuments({ userId })).toBe(1);
  });

  it("treats a clock_out for someone already out as done", async () => {
    const result = await handleWingmanClock(SECRET, { event: "clock_out", employee: employeeId });
    expect(result).toMatchObject({ status: 200, body: { ok: true, unchanged: true } });
  });

  it("still reports a clock_out that is earlier than the clock_in", async () => {
    await handleWingmanClock(SECRET, { event: "clock_in", employee: employeeId, at: "2026-09-14T10:00:00.000Z" });
    const result = await handleWingmanClock(SECRET, { event: "clock_out", employee: employeeId, at: "2026-09-14T09:00:00.000Z" });

    expect(result.status).toBe(400);
    expect(await active(userId)).toBeTruthy();
  });

  // ------------------------------------------------------- outbound webhook

  it("tells Wingman when someone clocks in, identifying them by company email", async () => {
    const hook = await startHook("ok");
    try {
      // The shared company endpoint matches on email, and authenticates the
      // webhook by the secret header.
      configure({ wingmanUrl: hook.url, wingmanSecret: SECRET });
      await clockInUser(userId);
      await hook.waitForHits(1);
      expect(hook.hits[0]).toMatchObject({ event: "clock_in", employee: email });
      // Not the employee id, which for real people is just their name.
      expect(hook.hits[0].employee).not.toBe(employeeId);
      expect(hook.headers[0]["x-wingman-secret"]).toBe(SECRET);
    } finally {
      await hook.close();
    }
  });

  it("does not echo a clock that Wingman itself made", async () => {
    const hook = await startHook("ok");
    try {
      configure({ wingmanUrl: hook.url });
      await handleWingmanClock(SECRET, { event: "clock_in", employee: employeeId });
      await new Promise(r => setTimeout(r, 400));
      expect(hook.hits).toHaveLength(0);
    } finally {
      await hook.close();
    }
  });

  it("does not make the person wait on a slow Wingman", async () => {
    const hook = await startHook("hang");
    try {
      configure({ wingmanUrl: hook.url, wingmanTimeoutMs: 8000 });
      vi.spyOn(console, "error").mockImplementation(() => {});

      const started = Date.now();
      await clockInUser(userId);

      // Awaiting the webhook would have taken the full eight seconds.
      expect(Date.now() - started).toBeLessThan(6000);
    } finally {
      await hook.close();
    }
  });

  it("gives up on an unresponsive Wingman instead of hanging", async () => {
    const hook = await startHook("hang");
    try {
      configure({ wingmanUrl: hook.url, wingmanTimeoutMs: 300 });
      vi.spyOn(console, "error").mockImplementation(() => {});

      const started = Date.now();
      await notifyWingman("clock_out", userId, new Date());

      expect(Date.now() - started).toBeLessThan(3000);
    } finally {
      await hook.close();
    }
  });

  it("never writes the secret or the URL token to the logs", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    configure({ wingmanSecret: SECRET });

    for (const mode of ["500", "hang"] as const) {
      const hook = await startHook(mode);
      try {
        configure({ wingmanUrl: hook.url, wingmanSecret: SECRET, wingmanTimeoutMs: 300 });
        await notifyWingman("clock_in", userId, new Date());
      } finally {
        await hook.close();
      }
    }
    // An address nothing is listening on, with a token in the path for good measure.
    configure({ wingmanUrl: `http://127.0.0.1:1/work/event/${TOKEN}`, wingmanSecret: SECRET, wingmanTimeoutMs: 300 });
    await notifyWingman("clock_in", userId, new Date());

    expect(spy).toHaveBeenCalled();
    const logged = spy.mock.calls
      .flat()
      .map(arg => (arg instanceof Error ? `${arg.message} ${arg.stack}` : String(arg)))
      .join("\n");
    expect(logged).not.toContain(TOKEN);
    // The secret now travels as a header, so it too must never surface in a log.
    expect(logged).not.toContain(SECRET);
  });
});
