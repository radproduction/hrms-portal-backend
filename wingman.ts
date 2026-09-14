import crypto from "node:crypto";
import { z } from "zod";
import * as db from "./db";
import { ENV } from "./_core/env";

export type WorkClockLocation = {
  lat: number;
  lng: number;
  accuracy?: number;
  address?: string;
  source?: "gps" | "manual";
};

export class WorkClockError extends Error {
  statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

/**
 * What Wingman sends. `employee` is optional: Wingman acts for one person, and
 * when it leaves the field out the clock goes to WINGMAN_DEFAULT_EMPLOYEE.
 */
const wingmanPayloadSchema = z.object({
  event: z.enum(["clock_in", "clock_out"]),
  employee: z.string().min(1).optional(),
  at: z.union([z.string(), z.date()]).optional(),
});

export function parseWingmanPayload(input: unknown) {
  return wingmanPayloadSchema.safeParse(input);
}

type ClockInOptions = {
  at?: Date;
  location?: WorkClockLocation;
  /**
   * Whether to tell Wingman about this clock. False when Wingman is the one
   * doing the clocking: echoing its own action back to it is noise at best,
   * and a loop if it ever reacts to the echo.
   */
  notifyWingman?: boolean;
};

type ClockOutOptions = {
  at?: Date;
  notes?: string;
  notifyWingman?: boolean;
};

export async function clockInUser(userId: string, input?: ClockInOptions) {
  const activeEntry = await db.getActiveTimeEntry(userId);
  if (activeEntry) {
    throw new WorkClockError(400, "You are already clocked in");
  }

  const timeIn = input?.at ?? new Date();
  const location = input?.location
    ? { ...input.location, capturedAt: timeIn }
    : undefined;

  await db.createTimeEntry({
    userId,
    timeIn,
    status: "active",
    location,
  });

  // Not awaited: the person's own clock must never wait on Wingman.
  if (input?.notifyWingman !== false) void notifyWingman("clock_in", userId, timeIn);

  return { success: true } as const;
}

export async function clockOutUser(userId: string, input?: ClockOutOptions) {
  const activeEntry = (await db.getActiveTimeEntry(userId)) as
    | { id: string; timeIn: Date | string }
    | undefined;
  if (!activeEntry) {
    throw new WorkClockError(400, "No active time entry found");
  }

  const timeOut = input?.at ?? new Date();
  const timeIn = new Date(activeEntry.timeIn);
  if (timeOut < timeIn) {
    throw new WorkClockError(400, "Clock out time cannot be before clock in");
  }

  const totalHours = (timeOut.getTime() - timeIn.getTime()) / (1000 * 60 * 60);
  const status = totalHours < 6.5 ? "early_out" : "completed";

  await db.updateTimeEntry(activeEntry.id, {
    timeOut,
    totalHours: Number(totalHours.toFixed(2)),
    status,
    notes: input?.notes,
  });

  if (input?.notifyWingman !== false) void notifyWingman("clock_out", userId, timeOut);

  return {
    success: true,
    totalHours: parseFloat(totalHours.toFixed(2)),
    status,
  } as const;
}

export async function getUserByWingmanEmployeeIdentifier(identifier: string) {
  return db.getUserByEmployeeIdentifier(identifier);
}

/** Constant-time, so the secret cannot be worked out by timing the 401s. */
function secretMatches(provided: string | undefined, expected: string) {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export type WingmanClockResponse = {
  status: number;
  body: { ok: boolean; at?: string; error?: string; unchanged?: boolean };
};

/**
 * POST /api/wingman/clock - Wingman clocking someone in or out.
 *
 * Kept free of Express so it can be tested without starting the server; the
 * route only hands the header and body in and writes the result back out.
 *
 * Retries are safe. Wingman gives up after roughly eight seconds and may send
 * the same request again, so a clock_in for someone already in, or a clock_out
 * for someone already out, answers 200 with `unchanged: true`. An error there
 * would read as a failure for a request that had in fact already worked.
 */
export async function handleWingmanClock(
  secretHeader: string | string[] | undefined,
  rawBody: unknown
): Promise<WingmanClockResponse> {
  if (!ENV.wingmanSecret) {
    return { status: 503, body: { ok: false, error: "wingman_not_configured" } };
  }

  const provided = Array.isArray(secretHeader) ? secretHeader[0] : secretHeader;
  if (!secretMatches(provided, ENV.wingmanSecret)) {
    return { status: 401, body: { ok: false, error: "unauthorized" } };
  }

  const parsed = parseWingmanPayload(rawBody);
  if (!parsed.success) {
    return { status: 400, body: { ok: false, error: "invalid_payload" } };
  }

  const { event, employee, at } = parsed.data;
  const atDate = at ? new Date(at) : new Date();
  if (Number.isNaN(atDate.getTime())) {
    return { status: 400, body: { ok: false, error: "invalid_at" } };
  }

  // Never guess: with no named employee and no configured default, clocking
  // anyone at all would put hours on the wrong person's attendance.
  const identifier = employee ?? ENV.wingmanDefaultEmployee;
  if (!identifier) {
    return { status: 400, body: { ok: false, error: "employee_required" } };
  }

  const user = await getUserByWingmanEmployeeIdentifier(identifier);
  if (!user?.id) {
    return { status: 404, body: { ok: false, error: "employee_not_found" } };
  }

  const settled = async () => {
    const active = await db.getActiveTimeEntry(user.id);
    return event === "clock_in" ? Boolean(active) : !active;
  };

  try {
    if (await settled()) {
      return { status: 200, body: { ok: true, at: atDate.toISOString(), unchanged: true } };
    }

    if (event === "clock_in") {
      await clockInUser(user.id, { at: atDate, notifyWingman: false });
    } else {
      await clockOutUser(user.id, { at: atDate, notifyWingman: false });
    }
    return { status: 200, body: { ok: true, at: atDate.toISOString() } };
  } catch (error) {
    if (error instanceof WorkClockError) {
      // Two retries racing can both pass the check above; if the other one
      // got there first, this request's goal is still met.
      if (await settled().catch(() => false)) {
        return { status: 200, body: { ok: true, at: atDate.toISOString(), unchanged: true } };
      }
      return { status: error.statusCode, body: { ok: false, error: error.message } };
    }
    console.error(
      "[Wingman] inbound clock failed",
      error instanceof Error ? error.name : "unknown error"
    );
    return { status: 500, body: { ok: false, error: "internal_error" } };
  }
}

/**
 * Tells Wingman a real clock happened, so it can chase a forgotten clock-out.
 *
 * Best effort and bounded. It never throws, and it gives up after
 * WINGMAN_WEBHOOK_TIMEOUT_MS so an unreachable Wingman cannot leave requests
 * hanging. It used to be awaited with no timeout, which put the person's own
 * clock-in at the mercy of Wingman's response time.
 *
 * WINGMAN_URL carries a private token and this repository is public, so the
 * URL is never logged: failures report the status or the error's name only.
 */
export async function notifyWingman(event: "clock_in" | "clock_out", userId: string, at: Date) {
  if (!ENV.wingmanUrl) return;

  try {
    const user = await db.getUserById(userId);
    const employee = user?.employeeId || user?.email || userId;

    const response = await fetch(ENV.wingmanUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event, employee, at: at.toISOString() }),
      signal: AbortSignal.timeout(ENV.wingmanTimeoutMs),
    });

    if (!response.ok) {
      console.error(`[Wingman] ${event} webhook failed with HTTP ${response.status}`);
    }
  } catch (error) {
    const name = error instanceof Error ? error.name : "unknown error";
    console.error(`[Wingman] ${event} webhook did not complete (${name})`);
  }
}
