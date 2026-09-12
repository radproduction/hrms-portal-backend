/**
 * Closes work sessions that were never clocked out.
 *
 * Nothing did this before. MAX_SHIFT_HOURS capped the hours that *reports*
 * showed, but the row itself stayed open for ever, so the database held
 * sessions running for weeks - the longest was 81 days - and anything reading
 * timeentries directly saw them as still at work.
 *
 * A session past the limit is closed at exactly limit hours after clock-in and
 * marked autoClockedOut, because the person's real finishing time is unknown.
 * The flag is the point: an honest cap that says "a human needs to confirm
 * this" is worth more than a number that looks like a measurement.
 */
import { TimeEntry } from "./models";
import { connectToMongoDB } from "./mongodb";

/** Hours after which an un-clocked-out session is closed automatically. */
function parseMaxSessionHours(): number {
  const raw = process.env.MAX_SESSION_HOURS;
  if (raw === undefined || raw === "") return 12;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 12;
}

export const MAX_SESSION_HOURS = parseMaxSessionHours();

/** How often the sweep runs. Fifteen minutes bounds the overshoot past the limit. */
function parseSweepIntervalMs(): number {
  const raw = process.env.SHIFT_SWEEP_INTERVAL_MINUTES;
  const minutes = raw === undefined || raw === "" ? 15 : Number(raw);
  const safe = Number.isFinite(minutes) && minutes > 0 ? minutes : 15;
  return safe * 60 * 1000;
}

export const SWEEP_INTERVAL_MS = parseSweepIntervalMs();

export type OpenSession = {
  id: string;
  timeIn: Date;
};

export type SweepDecision = {
  id: string;
  timeOut: Date;
  totalHours: number;
};

/**
 * Which open sessions are past the limit, and what they should be closed at.
 *
 * Pure, so the arithmetic can be tested without a database or a clock. The
 * close time is derived from timeIn rather than "now", so a sweep that runs
 * late - the process was down for a day, say - still records the limit and not
 * however long the outage lasted.
 */
export function decideSweep(
  sessions: OpenSession[],
  now: Date,
  maxHours: number = MAX_SESSION_HOURS
): SweepDecision[] {
  const limitMs = maxHours * 60 * 60 * 1000;

  return sessions.flatMap(session => {
    const timeIn = new Date(session.timeIn);
    if (Number.isNaN(timeIn.getTime())) return [];

    const elapsedMs = now.getTime() - timeIn.getTime();
    if (elapsedMs <= limitMs) return [];

    return [{
      id: session.id,
      timeOut: new Date(timeIn.getTime() + limitMs),
      totalHours: maxHours,
    }];
  });
}

/** Runs one sweep. Returns how many sessions were closed. */
export async function sweepStaleSessions(now: Date = new Date()): Promise<number> {
  const connected = await connectToMongoDB();
  if (!connected) return 0;

  const cutoff = new Date(now.getTime() - MAX_SESSION_HOURS * 60 * 60 * 1000);
  const stale = await TimeEntry.find(
    { status: "active", timeIn: { $lt: cutoff } },
    { _id: 1, timeIn: 1 }
  ).lean();
  if (stale.length === 0) return 0;

  const decisions = decideSweep(
    stale.map(s => ({ id: String(s._id), timeIn: s.timeIn as Date })),
    now
  );
  if (decisions.length === 0) return 0;

  await TimeEntry.bulkWrite(
    decisions.map(d => ({
      updateOne: {
        filter: { _id: d.id, status: "active" },
        update: {
          timeOut: d.timeOut,
          totalHours: d.totalHours,
          // Never "early_out": the session ran past a full day, and the flag
          // below already says the number is not a measurement.
          status: "completed",
          autoClockedOut: true,
        },
      },
    })) as any
  );

  console.log(
    `[ShiftSweep] closed ${decisions.length} session(s) left open past ${MAX_SESSION_HOURS}h`
  );
  return decisions.length;
}

let timer: NodeJS.Timeout | undefined;

/** Starts the periodic sweep. Safe to call once at startup. */
export function startShiftSweep() {
  if (timer) return;

  const run = () => {
    // A failed sweep must not take the server down with it.
    sweepStaleSessions().catch(error =>
      console.error("[ShiftSweep] failed", error)
    );
  };

  run();
  timer = setInterval(run, SWEEP_INTERVAL_MS);
  // Do not hold the process open just for this.
  timer.unref?.();

  console.log(
    `[ShiftSweep] every ${SWEEP_INTERVAL_MS / 60000}min, closing sessions past ${MAX_SESSION_HOURS}h`
  );
}

export function stopShiftSweep() {
  if (timer) clearInterval(timer);
  timer = undefined;
}
