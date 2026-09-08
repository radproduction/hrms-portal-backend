import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import mongoose from "mongoose";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { Notification, Payslip, User } from "./models";
import { UPLOADS_DIR } from "./storage";
import { describeWithDb } from "./test-utils";

/**
 * Deleting a payslip has to take it off the employee's side too - that is the
 * whole reason the button exists. "Their side" is three things: the record
 * their payslip list reads, the notification that announced it, and the
 * uploaded PDF, which stays downloadable by URL otherwise.
 *
 *   TEST_MONGODB_URI="mongodb://.../hrms_test" npx vitest run payslip.delete.test.ts
 */
describeWithDb("Payslip deletion", () => {
  let adminId: string;
  let employeeId: string;

  const ctxFor = (id: string, role: "admin" | "user") =>
    ({
      user: { id, role },
      req: { protocol: "https", headers: {} },
      res: { cookie: () => {}, clearCookie: () => {} },
    }) as unknown as TrpcContext;

  const asAdmin = () => appRouter.createCaller(ctxFor(adminId, "admin"));
  const asEmployee = () => appRouter.createCaller(ctxFor(employeeId, "user"));

  beforeAll(async () => {
    await mongoose.connect(process.env.MONGODB_URI as string);
    const stamp = Date.now();
    const [admin, employee] = await User.create([
      { openId: `pay-adm-${stamp}`, name: "Pay Admin", role: "admin", employeeId: `PADM${stamp}` },
      { openId: `pay-emp-${stamp}`, name: "Pay Employee", role: "user", employeeId: `PEMP${stamp}` },
    ]);
    adminId = String(admin._id);
    employeeId = String(employee._id);
  });

  afterAll(async () => {
    if (!adminId) return;
    const ids = [adminId, employeeId];
    await Promise.all([
      Payslip.deleteMany({ userId: { $in: ids } }),
      Notification.deleteMany({ userId: { $in: ids } }),
    ]);
    await User.deleteMany({ _id: { $in: ids } });
    await mongoose.connection.close();
  });

  beforeEach(async () => {
    await Payslip.deleteMany({ userId: employeeId });
    await Notification.deleteMany({ userId: employeeId });
  });

  /** Issues a payslip, optionally with a real file on disk behind documentUrl. */
  async function issuePayslip(withFile = false) {
    let documentUrl: string | undefined;
    if (withFile) {
      const key = `payslips/test-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`;
      const filePath = path.join(UPLOADS_DIR, key);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, "not really a pdf");
      documentUrl = `/uploads/${key}`;
    }

    const result = await asAdmin().admin.createPayslip({
      userId: employeeId,
      month: 8,
      year: 2026,
      basicSalary: 100000,
      allowances: 0,
      deductions: 0,
      documentUrl,
      markPaid: false,
    });
    return { id: String((result.payslip as any).id), documentUrl };
  }

  it("takes the payslip off the employee's own list", async () => {
    const { id } = await issuePayslip();

    expect(await asEmployee().dashboard.getPayslips()).toHaveLength(1);

    await asAdmin().admin.deletePayslip({ payslipId: id });

    expect(await asEmployee().dashboard.getPayslips()).toHaveLength(0);
    expect(await asEmployee().dashboard.getPayslip()).toBeNull();
  });

  it("removes the notification that announced it", async () => {
    const { id } = await issuePayslip();

    const before = await Notification.countDocuments({
      userId: employeeId,
      relatedType: "payslip",
    });
    expect(before).toBeGreaterThan(0);

    await asAdmin().admin.deletePayslip({ payslipId: id });

    // Otherwise the employee keeps a "your payslip is available" entry
    // pointing at something that no longer exists.
    const after = await Notification.countDocuments({
      userId: employeeId,
      relatedType: "payslip",
    });
    expect(after).toBe(0);
  });

  it("deletes the uploaded PDF, which is reachable by URL otherwise", async () => {
    const { id, documentUrl } = await issuePayslip(true);
    const filePath = path.join(UPLOADS_DIR, documentUrl!.replace(/^\/uploads\//, ""));

    await expect(fs.access(filePath)).resolves.toBeUndefined();

    await asAdmin().admin.deletePayslip({ payslipId: id });

    await expect(fs.access(filePath)).rejects.toThrow();
  });

  it("refuses to delete for anyone who is not an admin", async () => {
    const { id } = await issuePayslip();

    await expect(
      asEmployee().admin.deletePayslip({ payslipId: id })
    ).rejects.toThrow(/Admin access required/);

    // Still there, which is the point.
    expect(await asEmployee().dashboard.getPayslips()).toHaveLength(1);
  });

  it("reports a payslip that is already gone rather than silently succeeding", async () => {
    const { id } = await issuePayslip();
    await asAdmin().admin.deletePayslip({ payslipId: id });

    await expect(
      asAdmin().admin.deletePayslip({ payslipId: id })
    ).rejects.toThrow(/not found/i);
  });
});
