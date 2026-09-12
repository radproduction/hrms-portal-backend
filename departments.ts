/**
 * Departments and who leads them.
 *
 * A department used to be a free-text string on each user, so there was
 * nowhere to record a head - and "send this person's leave to their head" has
 * no answer without one. The string stays as the display name that reports
 * already group by; this module owns the record that resolves to a head.
 */
import mongoose, { Types } from "mongoose";
import { Department, User } from "./models";
import { connectToMongoDB } from "./mongodb";
import { hasRank, isOrgWide } from "./roles";

async function requireDb() {
  const connected = await connectToMongoDB();
  if (!connected) throw new Error("Database not available");
}

function toId(id: string) {
  if (!mongoose.isValidObjectId(id)) throw new Error("Invalid id");
  return id;
}

export type DepartmentRecord = {
  id: string;
  name: string;
  headUserId: string | null;
  headName: string | null;
  canCreateProjects: boolean;
  memberCount: number;
};

/** Every department, with its head and how many people are in it. */
export async function listDepartments(): Promise<DepartmentRecord[]> {
  await requireDb();

  const departments = await Department.find().sort({ name: 1 }).lean();
  if (departments.length === 0) return [];

  const headIds = departments.map(d => d.headUserId).filter(Boolean);
  const heads = await User.find({ _id: { $in: headIds } }, { name: 1 }).lean();
  const headName = new Map(heads.map(h => [String(h._id), h.name ?? ""]));

  // One grouped count rather than a query per department.
  const counts = await User.aggregate<{ _id: Types.ObjectId | null; n: number }>([
    { $match: { departmentId: { $in: departments.map(d => d._id) } } },
    { $group: { _id: "$departmentId", n: { $sum: 1 } } },
  ]);
  const countBy = new Map(counts.map(c => [String(c._id), c.n]));

  return departments.map(d => ({
    id: String(d._id),
    name: d.name,
    headUserId: d.headUserId ? String(d.headUserId) : null,
    headName: d.headUserId ? headName.get(String(d.headUserId)) ?? null : null,
    canCreateProjects: Boolean(d.canCreateProjects),
    memberCount: countBy.get(String(d._id)) ?? 0,
  }));
}

export async function createDepartment(name: string) {
  await requireDb();
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Department name is required");

  const existing = await Department.findOne({
    name: new RegExp(`^${trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"),
  }).lean();
  if (existing) throw new Error(`A department called "${existing.name}" already exists`);

  const created = await Department.create({ name: trimmed });
  return { id: String(created._id), name: created.name };
}

export async function renameDepartment(departmentId: string, name: string) {
  await requireDb();
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Department name is required");

  const saved = await Department.findByIdAndUpdate(
    toId(departmentId),
    { name: trimmed },
    { returnDocument: "after" }
  ).lean();
  if (!saved) return null;

  // The denormalised display name on each user has to follow, or reports keep
  // grouping people under the old spelling.
  await User.updateMany({ departmentId: saved._id }, { department: trimmed });
  return { id: String(saved._id), name: saved.name };
}

/**
 * Puts someone in charge of a department, or clears the post.
 *
 * The head is given the dept_head role if they do not already outrank it, so
 * "make them the head" is one action rather than two that can be half-done.
 */
export async function setDepartmentHead(departmentId: string, userId: string | null) {
  await requireDb();
  const id = toId(departmentId);

  if (userId === null) {
    const saved = await Department.findByIdAndUpdate(
      id,
      { $unset: { headUserId: "" } },
      { returnDocument: "after" }
    ).lean();
    return saved ? { id: String(saved._id), headUserId: null } : null;
  }

  const user = await User.findById(toId(userId)).lean();
  if (!user) throw new Error("No such employee");

  const saved = await Department.findByIdAndUpdate(
    id,
    { headUserId: user._id },
    { returnDocument: "after" }
  ).lean();
  if (!saved) return null;

  // Promote, never demote: an admin or head of operations running a department
  // keeps their higher role.
  if (!hasRank(user.role, "dept_head")) {
    await User.findByIdAndUpdate(user._id, { role: "dept_head" });
  }

  return { id: String(saved._id), headUserId: String(user._id) };
}

export async function setDepartmentProjectRights(departmentId: string, allowed: boolean) {
  await requireDb();
  const saved = await Department.findByIdAndUpdate(
    toId(departmentId),
    { canCreateProjects: allowed },
    { returnDocument: "after" }
  ).lean();
  return saved
    ? { id: String(saved._id), canCreateProjects: Boolean(saved.canCreateProjects) }
    : null;
}

/** Moves someone into a department, keeping the display name in step. */
export async function setUserDepartment(userId: string, departmentId: string | null) {
  await requireDb();

  if (departmentId === null) {
    await User.findByIdAndUpdate(toId(userId), {
      $unset: { departmentId: "" },
      department: "",
    });
    return;
  }

  const department = await Department.findById(toId(departmentId)).lean();
  if (!department) throw new Error("No such department");

  await User.findByIdAndUpdate(toId(userId), {
    departmentId: department._id,
    department: department.name,
  });
}

export type ApproverChain = {
  departmentId: string | null;
  departmentName: string | null;
  headUserId: string | null;
};

/** The department a person belongs to, and who leads it. */
export async function getDepartmentOf(userId: string): Promise<ApproverChain> {
  await requireDb();

  const user = await User.findById(toId(userId), { departmentId: 1 }).lean();
  if (!user?.departmentId) {
    return { departmentId: null, departmentName: null, headUserId: null };
  }

  const department = await Department.findById(user.departmentId).lean();
  if (!department) {
    return { departmentId: null, departmentName: null, headUserId: null };
  }

  return {
    departmentId: String(department._id),
    departmentName: department.name,
    headUserId: department.headUserId ? String(department.headUserId) : null,
  };
}

/** The departments someone leads. Empty for everyone below dept_head. */
export async function departmentsLedBy(userId: string): Promise<string[]> {
  await requireDb();
  const led = await Department.find({ headUserId: toId(userId) }, { _id: 1 }).lean();
  return led.map(d => String(d._id));
}

/**
 * Whether `actor` may act on `target`'s records.
 *
 * Org-wide roles reach everyone. A department head reaches the people in the
 * departments they lead. Everyone else reaches only themselves.
 */
export async function canActOnUser(
  actor: { id: string; role?: string },
  targetUserId: string
): Promise<boolean> {
  if (actor.id === targetUserId) return true;
  if (isOrgWide(actor.role)) return true;
  if (!hasRank(actor.role, "dept_head")) return false;

  const led = await departmentsLedBy(actor.id);
  if (led.length === 0) return false;

  const target = await User.findById(toId(targetUserId), { departmentId: 1 }).lean();
  if (!target?.departmentId) return false;

  return led.includes(String(target.departmentId));
}
