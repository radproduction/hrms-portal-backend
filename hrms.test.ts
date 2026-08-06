import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mongoose from "mongoose";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { User } from "./models";
import { describeWithDb } from "./test-utils";
type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

function createAuthContext(
  userId: string = "000000000000000000000001"
): { ctx: TrpcContext } {
  const user: AuthenticatedUser = {
    id: userId,
    openId: "hrms-hassan",
    email: "hassan@rad.com",
    name: "Hassan",
    loginMethod: "custom",
    role: "user",
    employeeId: "EMP001",
    password: "123",
    department: "Engineering",
    position: "Software Developer",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  };

  const ctx: TrpcContext = {
    user,
    req: {
      protocol: "https",
      headers: {},
    } as TrpcContext["req"],
    res: {
      cookie: () => {},
      clearCookie: () => {},
    } as unknown as TrpcContext["res"],
  };

  return { ctx };
}

describe("HRMS Authentication", () => {
  it("should return authenticated user info", async () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.auth.me();

    expect(result).toBeDefined();
    expect(result?.name).toBe("Hassan");
    expect(result?.employeeId).toBe("EMP001");
  });

  it("should logout successfully", async () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.auth.logout();

    expect(result).toEqual({ success: true });
  });
});

describe("Time Tracking", () => {
  it("should get active time entry", async () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.timeTracking.getActive();

    // Should return undefined or an active entry
    expect(result === undefined || typeof result === "object").toBe(true);
  });

  it("should get attendance for date range", async () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    const startDate = new Date("2026-02-01");
    const endDate = new Date("2026-02-28");

    const result = await caller.timeTracking.getAttendance({
      startDate,
      endDate,
    });

    expect(Array.isArray(result)).toBe(true);
  });

  it("should get break logs", async () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.timeTracking.getBreakLogs();

    expect(Array.isArray(result)).toBe(true);
  });
});

describe("Dashboard", () => {
  it("should get announcements", async () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.dashboard.getAnnouncements();

    expect(Array.isArray(result)).toBe(true);
  });

  it("should get payslip", async () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.dashboard.getPayslip();

    // Should return undefined or a payslip object
    expect(result === undefined || typeof result === "object").toBe(true);
  });

  it("should get users list", async () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.dashboard.getUsers();

    expect(Array.isArray(result)).toBe(true);
  });
});

// Reads real rows, so it needs a database. It seeds the row it asserts on
// rather than assuming the database already has one; depending on ambient data
// made this fail the moment the other suites started cleaning up after
// themselves.
describeWithDb("Dashboard (requires database)", () => {
  let seededId: string;

  beforeAll(async () => {
    await mongoose.connect(process.env.MONGODB_URI as string);
    const created = await User.create({
      openId: `hrms-test-${Date.now()}`,
      name: "Seeded User",
      role: "user",
      employeeId: `HT${Date.now()}`,
    });
    seededId = String(created._id);
  });

  afterAll(async () => {
    // Only the seeded row is removed. The connection is shared with the other
    // suites in this file, so closing it here would break them.
    if (seededId) await User.deleteMany({ _id: seededId });
  });

  it("returns the users it can see", async () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.dashboard.getUsers();

    expect(result.length).toBeGreaterThan(0);
    expect(result.some((u: any) => u.id === seededId)).toBe(true);
  });

  it("never exposes password or two-factor fields", async () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.dashboard.getUsers();

    for (const user of result as any[]) {
      expect(user.password).toBeUndefined();
      expect(user.twoFactorSecret).toBeUndefined();
    }
  });
});

describe("Leave Management", () => {
  it("should get user leave applications", async () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.leaves.getMyLeaves();

    expect(Array.isArray(result)).toBe(true);
  });
});

describe("Forms", () => {
  it("should get user form submissions", async () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.forms.getMyForms();

    expect(Array.isArray(result)).toBe(true);
  });
});

describe("Chat", () => {
  it("should get chat messages", async () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.chat.getMessages({ limit: 50 });

    expect(Array.isArray(result)).toBe(true);
  });
});
