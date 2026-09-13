/**
 * Who is allowed to do what.
 *
 * The portal had two roles, user and admin, and thirty-nine separate
 * `role !== "admin"` checks. Adding a level in the middle would have silently
 * locked the new level out of all of them, so the checks are expressed as "at
 * least this rank" instead of "is exactly admin".
 *
 *   admin         super admin: everything, including who gets which role
 *   head_of_ops   every department, but cannot hand out roles
 *   dept_head     their own department only
 *   user          themselves only
 */
export const ROLES = ["user", "dept_head", "head_of_ops", "admin"] as const;

export type Role = (typeof ROLES)[number];

/** Higher outranks lower. Only ever compared, never stored. */
const RANK: Record<Role, number> = {
  user: 0,
  dept_head: 1,
  head_of_ops: 2,
  admin: 3,
};

/** Anything unrecognised is treated as the least privileged, never the most. */
export function rankOf(role: string | undefined | null): number {
  return RANK[(role ?? "") as Role] ?? 0;
}

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && value in RANK;
}

/** True when `role` is at least `minimum` in the hierarchy. */
export function hasRank(role: string | undefined | null, minimum: Role): boolean {
  return rankOf(role) >= RANK[minimum];
}

/**
 * Reaches across departments: the whole-organisation views - payslips,
 * reports, every employee. What used to be "admin only".
 */
export function isOrgWide(role: string | undefined | null): boolean {
  return hasRank(role, "head_of_ops");
}

/** Super admin alone. Handing out roles is the thing this guards. */
export function isSuperAdmin(role: string | undefined | null): boolean {
  return hasRank(role, "admin");
}

/** Leads at least one department: dept heads and everyone above them. */
export function isAnyHead(role: string | undefined | null): boolean {
  return hasRank(role, "dept_head");
}

/**
 * Which roles someone may assign. A role can only ever hand out roles strictly
 * below its own, so nobody can promote a peer to their own level or clone
 * themselves - that stays a super admin decision.
 */
export function assignableRoles(actorRole: string | undefined | null): Role[] {
  const actorRank = rankOf(actorRole);
  return ROLES.filter(role => RANK[role] < actorRank);
}

export function canAssignRole(
  actorRole: string | undefined | null,
  targetRole: string
): boolean {
  return isRole(targetRole) && assignableRoles(actorRole).includes(targetRole);
}

/** Human-readable, for pickers and audit lines. */
export const ROLE_LABELS: Record<Role, string> = {
  user: "Employee",
  dept_head: "Department Head",
  head_of_ops: "Head of Operations",
  admin: "Administrator",
};
