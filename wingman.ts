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

const wingmanPayloadSchema = z.object({
  event: z.enum(["clock_in", "clock_out"]),
  employee: z.string().min(1),
  at: z.union([z.string(), z.date()]).optional(),
});

export function parseWingmanPayload(input: unknown) {
  return wingmanPayloadSchema.safeParse(input);
}

export async function clockInUser(
  userId: string,
  input?: {
    at?: Date;
    location?: WorkClockLocation;
  }
) {
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

  await notifyWingman("clock_in", userId, timeIn);

  return { success: true } as const;
}

export async function clockOutUser(
  userId: string,
  input?: {
    at?: Date;
    notes?: string;
  }
) {
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

  await notifyWingman("clock_out", userId, timeOut);

  return {
    success: true,
    totalHours: parseFloat(totalHours.toFixed(2)),
    status,
  } as const;
}

export async function getUserByWingmanEmployeeIdentifier(identifier: string) {
  return db.getUserByEmployeeIdentifier(identifier);
}

async function notifyWingman(event: "clock_in" | "clock_out", userId: string, at: Date) {
  if (!ENV.wingmanUrl) return;

  try {
    const user = await db.getUserById(userId);
    const employee = user?.employeeId || user?.email || userId;

    const response = await fetch(ENV.wingmanUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event,
        employee,
        at: at.toISOString(),
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.error(`[Wingman] ${event} webhook failed`, response.status, body);
    }
  } catch (error) {
    console.error(`[Wingman] ${event} webhook error`, error);
  }
}
