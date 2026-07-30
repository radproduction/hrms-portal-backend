import { afterAll, beforeAll, expect, it } from "vitest";
import mongoose from "mongoose";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { Notification, Payslip, User } from "./models";
import { describeWithDb } from "./test-utils";

/**
 * End-to-end cover for the bug this feature fixed: an admin issuing a payslip
 * must persist it, surface it to the admin list AND the employee's own list, and
 * notify the employee.
 *
 * Needs a throwaway database — run with:
 *   TEST_MONGODB_URI="mongodb://.../hrms_test" pnpm test
 */
describeWithDb("Admin payslip issuing flow", () => {
  let adminId: string;
  let employeeId: string;

  const ctxFor = (id: string, role: "admin" | "user") =>
    ({
      user: { id, role },
      req: { protocol: "https", headers: {} },
      res: { cookie: () => {}, clearCookie: () => {} },
    }) as unknown as TrpcContext;

  beforeAll(async () => {
    await mongoose.connect(process.env.MONGODB_URI as string);

    const admin = await User.create({
      openId: `test-admin-${Date.now()}`,
      name: "Test Admin",
      role: "admin",
      employeeId: `TADMIN${Date.now()}`,
    });
    const employee = await User.create({
      openId: `test-emp-${Date.now()}`,
      name: "Test Employee",
      role: "user",
      employeeId: `TEMP${Date.now()}`,
    });

    adminId = String(admin._id);
    employeeId = String(employee._id);
  });

  afterAll(async () => {
    if (!adminId) return;
    // Mongoose casts these id strings for us, avoiding a manual ObjectId ctor.
    const ids = [adminId, employeeId];
    await Payslip.deleteMany({ userId: { $in: ids } });
    await Notification.deleteMany({ userId: { $in: ids } });
    await User.deleteMany({ _id: { $in: ids } });
    await mongoose.connection.close();
  });

  it("persists the payslip, shows it to both sides, and notifies the employee", async () => {
    const admin = appRouter.createCaller(ctxFor(adminId, "admin"));
    const employee = appRouter.createCaller(ctxFor(employeeId, "user"));

    // Employee starts with nothing.
    expect(await employee.dashboard.getPayslips()).toHaveLength(0);

    const created = await admin.admin.createPayslip({
      userId: employeeId,
      month: 3,
      year: 2026,
      basicSalary: 80000,
      allowances: 15000,
      deductions: 5000,
      markPaid: true,
    });

    expect(created.success).toBe(true);
    expect(created.wasReplaced).toBe(false);
    expect((created.payslip as any)?.netSalary).toBe(90000);
    // markPaid drives the "paid" vs "pending" badge on the employee portal.
    expect((created.payslip as any)?.paidAt).toBeInstanceOf(Date);

    // Employee can now see it, with the full breakdown their page renders.
    const employeePayslips = await employee.dashboard.getPayslips();
    expect(employeePayslips).toHaveLength(1);
    expect((employeePayslips[0] as any).basicSalary).toBe(80000);
    expect((employeePayslips[0] as any).allowances).toBe(15000);
    expect((employeePayslips[0] as any).deductions).toBe(5000);
    expect((employeePayslips[0] as any).netSalary).toBe(90000);
    expect((employeePayslips[0] as any).month).toBe(3);
    expect((employeePayslips[0] as any).year).toBe(2026);

    // ...and it is the "latest payslip" the dashboard widget reads.
    expect((await employee.dashboard.getPayslip() as any)?.netSalary).toBe(90000);

    // Admin list includes it with the employee joined on.
    const adminPayslips = await admin.admin.getPayslips();
    const mine = adminPayslips.find((p: any) => p.user?.id === employeeId);
    expect(mine).toBeDefined();
    expect((mine as any).netSalary).toBe(90000);

    // Employee was notified.
    const notifications = await employee.notifications.getAll();
    const payslipNotification = notifications.find(
      (n: any) => n.type === "payslip_issued"
    );
    expect(payslipNotification).toBeDefined();
    expect((payslipNotification as any).title).toContain("March 2026");
    expect(await employee.notifications.getUnreadCount()).toBeGreaterThan(0);
  });

  it("replaces an existing payslip for the same month instead of duplicating", async () => {
    const admin = appRouter.createCaller(ctxFor(adminId, "admin"));
    const employee = appRouter.createCaller(ctxFor(employeeId, "user"));

    const updated = await admin.admin.createPayslip({
      userId: employeeId,
      month: 3,
      year: 2026,
      basicSalary: 85000,
      allowances: 15000,
      deductions: 5000,
    });

    expect(updated.wasReplaced).toBe(true);
    expect((updated.payslip as any)?.netSalary).toBe(95000);

    const payslips = await employee.dashboard.getPayslips();
    expect(payslips).toHaveLength(1);
    expect((payslips[0] as any).netSalary).toBe(95000);
  });

  it("rejects deductions larger than basic salary plus allowances", async () => {
    const admin = appRouter.createCaller(ctxFor(adminId, "admin"));

    await expect(
      admin.admin.createPayslip({
        userId: employeeId,
        month: 4,
        year: 2026,
        basicSalary: 1000,
        allowances: 0,
        deductions: 5000,
      })
    ).rejects.toThrow(/Deductions cannot exceed/);
  });

  it("rejects an unknown employee", async () => {
    const admin = appRouter.createCaller(ctxFor(adminId, "admin"));

    await expect(
      admin.admin.createPayslip({
        userId: "0123456789abcdef01234567",
        month: 5,
        year: 2026,
        basicSalary: 1000,
      })
    ).rejects.toThrow(/Employee not found/);
  });

  it("refuses a non-admin caller", async () => {
    const employee = appRouter.createCaller(ctxFor(employeeId, "user"));

    await expect(
      employee.admin.createPayslip({
        userId: employeeId,
        month: 6,
        year: 2026,
        basicSalary: 1000,
      })
    ).rejects.toThrow(/Admin access required/);
  });
});
