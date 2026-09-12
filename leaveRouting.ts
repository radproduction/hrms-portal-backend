/**
 * Who a leave application goes to.
 *
 * Approval used to be flat: every application landed in one admin queue. The
 * chain is now the applicant's department head, with two cases that have to
 * escalate rather than dead-end:
 *
 *   - A head's own leave. Sending it to themselves would let them approve it,
 *     which is not an approval at all.
 *   - Somebody with no department, or a department with no head. There is
 *     nobody below to ask, so it goes up.
 *
 * Escalation is to a head of operations, then to a super admin.
 */
import { User } from "./models";
import { connectToMongoDB } from "./mongodb";
import { getDepartmentOf } from "./departments";
import { hasRank } from "./roles";

export type RoutingInput = {
  applicantId: string;
  /** Head of the applicant's department, if the department has one. */
  departmentHeadId: string | null;
  /** Candidates to escalate to, in the order they should be tried. */
  escalation: string[];
};

export type RoutingResult = {
  approverId: string | null;
  reason: "department_head" | "escalated_self" | "escalated_no_head" | "unassigned";
};

/**
 * Pure so the branching can be tested without a database.
 *
 * A null approver is a real outcome, not a failure: the application is still
 * recorded and stays visible to everyone org-wide, who can act on anything.
 */
export function resolveApprover(input: RoutingInput): RoutingResult {
  const escalate = input.escalation.filter(id => id && id !== input.applicantId);
  const first = escalate[0] ?? null;

  if (!input.departmentHeadId) {
    return { approverId: first, reason: first ? "escalated_no_head" : "unassigned" };
  }

  if (input.departmentHeadId === input.applicantId) {
    // Nobody approves their own leave.
    return { approverId: first, reason: first ? "escalated_self" : "unassigned" };
  }

  return { approverId: input.departmentHeadId, reason: "department_head" };
}

/** Everyone who could take an escalated application, most junior first. */
export async function escalationCandidates(): Promise<string[]> {
  const connected = await connectToMongoDB();
  if (!connected) return [];

  const seniors = await User.find(
    { role: { $in: ["head_of_ops", "admin"] } },
    { _id: 1, role: 1 }
  ).lean();

  // head_of_ops before admin: the smallest step up that still has the reach.
  return seniors
    .sort((a, b) => hasRank(a.role, "admin") === hasRank(b.role, "admin") ? 0 : hasRank(a.role, "admin") ? 1 : -1)
    .map(u => String(u._id));
}

/** Looks up the chain and decides, for a real applicant. */
export async function routeLeaveFor(applicantId: string): Promise<RoutingResult> {
  const [chain, escalation] = await Promise.all([
    getDepartmentOf(applicantId),
    escalationCandidates(),
  ]);

  return resolveApprover({
    applicantId,
    departmentHeadId: chain.headUserId,
    escalation,
  });
}
