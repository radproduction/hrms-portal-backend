import { describe, expect, it } from "vitest";
import { computePayslipAmounts, formatPayPeriod } from "./payroll";

describe("computePayslipAmounts", () => {
  it("derives net salary from basic + allowances - deductions", () => {
    const result = computePayslipAmounts({
      basicSalary: 80000,
      allowances: 15000,
      deductions: 5000,
    });

    expect(result).toEqual({
      basicSalary: 80000,
      allowances: 15000,
      deductions: 5000,
      netSalary: 90000,
    });
  });

  it("defaults allowances and deductions to zero", () => {
    const result = computePayslipAmounts({ basicSalary: 50000 });

    expect(result.allowances).toBe(0);
    expect(result.deductions).toBe(0);
    expect(result.netSalary).toBe(50000);
  });

  it("ignores non-finite values instead of producing NaN", () => {
    const result = computePayslipAmounts({
      basicSalary: Number.NaN,
      allowances: Number.POSITIVE_INFINITY,
      deductions: undefined,
    });

    expect(result.netSalary).toBe(0);
    expect(Number.isNaN(result.netSalary)).toBe(false);
  });

  it("rounds away floating point noise", () => {
    const result = computePayslipAmounts({
      basicSalary: 0.1,
      allowances: 0.2,
      deductions: 0,
    });

    // 0.1 + 0.2 === 0.30000000000000004 without rounding.
    expect(result.netSalary).toBe(0.3);
  });

  it("returns a negative net when deductions exceed earnings", () => {
    // The router rejects this; the helper stays honest so it can be detected.
    const result = computePayslipAmounts({
      basicSalary: 1000,
      allowances: 0,
      deductions: 2500,
    });

    expect(result.netSalary).toBe(-1500);
  });
});

describe("formatPayPeriod", () => {
  it("formats a month/year pair for notification copy", () => {
    expect(formatPayPeriod(1, 2026)).toBe("January 2026");
    expect(formatPayPeriod(3, 2026)).toBe("March 2026");
    expect(formatPayPeriod(12, 2025)).toBe("December 2025");
  });

  it("falls back to the year for an out-of-range month", () => {
    expect(formatPayPeriod(0, 2026)).toBe("2026");
    expect(formatPayPeriod(13, 2026)).toBe("2026");
  });
});
