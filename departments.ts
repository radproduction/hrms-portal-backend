/**
 * Departments and who leads them.
 *
 * A department used to be a free-text string on each user, so there was
 * nowhere to record a head - and "send this person's leave to their head" has
 * no answer without one. The string stays as the display name that reports
 * already group by; this module owns the record that resolves to a head.
 */
import mongoose, { Types } from "mongoose";
import { Department, LeaveApplication, TimeEntry, User } from "./models";
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

/**
 * Removes a department.
 *
 * Refuses while anyone is still in it: a user left pointing at a department
 * that no longer exists has no head, so their leave would silently stop
 * routing anywhere. Move people out first, and the error says how many.
 */
export async function deleteDepartment(departmentId: string) {
  await requireDb();
  const id = toId(departmentId);

  const remaining = await User.countDocuments({ departmentId: id });
  if (remaining > 0) {
    throw new Error(
      `${remaining} ${remaining === 1 ? "person is" : "people are"} still in this department. Move them first.`
    );
  }

  const removed = await Department.findByIdAndDelete(id).lean();
  return removed ? { id: String(removed._id), name: removed.name } : null;
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

export type TeamMemberOverview = {
  id: string;
  name: string;
  employeeId: string;
  email: string;
  position: string;
  role: string;
  departmentId: string | null;
  departmentName: string | null;
  isHead: boolean;
  /** ISO time the current open session started, or null when clocked out. */
  clockedInSince: string | null;
  /** Raw entries for this member in the window, for the summariser. */
  entries: {
    userId: string;
    timeIn: Date;
    timeOut: Date | null;
    totalHours: number | null;
    status: string;
    autoClockedOut: boolean;
  }[];
  leaveDates: { startDate: Date; endDate: Date }[];
  pendingLeaveCount: number;
};

/**
 * Everything a "my team" view needs, scoped to a set of departments, in a
 * handful of queries rather than one per member. The caller (team router)
 * decides which departments are in scope; this does not itself check who is
 * asking.
 *
 * Unlike getAttendanceReportData this is not limited to role "user" - a team
 * can contain someone who is also an admin, and the head still needs to see
 * them - and it carries autoClockedOut so a forgotten clock-out still shows.
 */
export async function getTeamOverviewData(
  departmentIds: string[],
  windowStart: Date,
  windowEnd: Date
): Promise<{ departments: { id: string; name: string }[]; members: TeamMemberOverview[] }> {
  await requireDb();

  const validIds = departmentIds.filter(id => mongoose.isValidObjectId(id)).map(toId);
  if (validIds.length === 0) return { departments: [], members: [] };

  const departments = await Department.find({ _id: { $in: validIds } }).lean();
  const deptById = new Map(departments.map(d => [String(d._id), d]));
  const headByDept = new Map(
    departments.filter(d => d.headUserId).map(d => [String(d._id), String(d.headUserId)])
  );

  const users = await User.find({ departmentId: { $in: validIds } }).sort({ name: 1 }).lean();
  if (users.length === 0) {
    return {
      departments: departments.map(d => ({ id: String(d._id), name: d.name })),
      members: [],
    };
  }
  const userIds = users.map(u => u._id);

  const [entries, activeEntries, monthLeaves, pendingLeaves] = await Promise.all([
    TimeEntry.find({
      userId: { $in: userIds },
      timeIn: { $gte: windowStart, $lte: windowEnd },
    }).sort({ timeIn: 1 }).lean(),
    TimeEntry.find({ userId: { $in: userIds }, status: "active" }).lean(),
    LeaveApplication.find({
      userId: { $in: userIds },
      status: "approved",
      startDate: { $lte: windowEnd },
      endDate: { $gte: windowStart },
    }).lean(),
    LeaveApplication.find({ userId: { $in: userIds }, status: "pending" }, { userId: 1 }).lean(),
  ]);

  const entriesByUser = new Map<string, any[]>();
  for (const e of entries) {
    const key = String(e.userId);
    (entriesByUser.get(key) ?? entriesByUser.set(key, []).get(key)!).push(e);
  }
  const activeSince = new Map<string, Date>();
  for (const e of activeEntries) activeSince.set(String(e.userId), e.timeIn as Date);
  const leavesByUser = new Map<string, any[]>();
  for (const l of monthLeaves) {
    const key = String(l.userId);
    (leavesByUser.get(key) ?? leavesByUser.set(key, []).get(key)!).push(l);
  }
  const pendingByUser = new Map<string, number>();
  for (const l of pendingLeaves) {
    const key = String(l.userId);
    pendingByUser.set(key, (pendingByUser.get(key) ?? 0) + 1);
  }

  const members: TeamMemberOverview[] = users.map(u => {
    const id = String(u._id);
    const deptId = u.departmentId ? String(u.departmentId) : null;
    const dept = deptId ? deptById.get(deptId) : null;
    const since = activeSince.get(id);
    return {
      id,
      name: u.name ?? "",
      employeeId: u.employeeId ?? "",
      email: u.email ?? "",
      position: u.position ?? "",
      role: u.role ?? "user",
      departmentId: deptId,
      departmentName: dept?.name ?? null,
      isHead: deptId ? headByDept.get(deptId) === id : false,
      clockedInSince: since ? new Date(since).toISOString() : null,
      entries: (entriesByUser.get(id) ?? []).map((e: any) => ({
        userId: id,
        timeIn: e.timeIn,
        timeOut: e.timeOut ?? null,
        totalHours: e.totalHours ?? null,
        status: e.status,
        autoClockedOut: Boolean(e.autoClockedOut),
      })),
      leaveDates: (leavesByUser.get(id) ?? []).map((l: any) => ({
        startDate: l.startDate,
        endDate: l.endDate,
      })),
      pendingLeaveCount: pendingByUser.get(id) ?? 0,
    };
  });

  return {
    departments: departments.map(d => ({ id: String(d._id), name: d.name })),
    members,
  };
}

/**
 * Whether someone may open a project on the board.
 *
 * Anyone could, for a while. The client now wants it to be a grant a super
 * admin hands to a department head, so the board reflects who actually runs
 * things rather than filling up with a space per person.
 *
 * Org-wide roles are always allowed; a head needs the grant on at least one
 * department they lead.
 */
export async function canOpenProjects(actor: {
  id: string;
  role?: string;
}): Promise<boolean> {
  if (isOrgWide(actor.role)) return true;
  if (!hasRank(actor.role, "dept_head")) return false;

  await requireDb();
  const granted = await Department.countDocuments({
    headUserId: toId(actor.id),
    canCreateProjects: true,
  });
  return granted > 0;
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
