/**
 * Pure payroll helpers. Deliberately free of DB / network access so they can be
 * unit tested without touching MongoDB.
 */

export type PayslipAmountsInput = {
  basicSalary: number;
  allowances?: number;
  deductions?: number;
};

export type PayslipAmounts = {
  basicSalary: number;
  allowances: number;
  deductions: number;
  netSalary: number;
};

function toAmount(value: number | undefined, fallback = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  // Money is stored as a plain number here; keep it to 2 decimal places so
  // floating point noise never reaches the database.
  return Math.round(value * 100) / 100;
}

/**
 * Net salary is always derived on the server so a client can never post an
 * inconsistent basic/allowances/deductions/net combination.
 */
export function computePayslipAmounts(input: PayslipAmountsInput): PayslipAmounts {
  const basicSalary = toAmount(input.basicSalary);
  const allowances = toAmount(input.allowances);
  const deductions = toAmount(input.deductions);

  return {
    basicSalary,
    allowances,
    deductions,
    netSalary: toAmount(basicSalary + allowances - deductions),
  };
}

const MONTH_LABELS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** "2026-03" -> "March 2026". Used for notification copy. */
export function formatPayPeriod(month: number, year: number): string {
  const label = MONTH_LABELS[month - 1];
  if (!label) return String(year);
  return `${label} ${year}`;
}
