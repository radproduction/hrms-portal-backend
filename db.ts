import bcrypt from "bcryptjs";
import { Types } from "mongoose";
import { connectToMongoDB } from "./mongodb";
import {
  Announcement,
  AnnouncementRead,
  BreakLog,
  CalendarEvent,
  ChatMessage,
  FormSubmission,
  LeaveApplication,
  Meeting,
  MeetingParticipant,
  Note,
  Notification,
  OvertimeEntry,
  Payslip,
  Project,
  ProjectAssignment,
  ProjectTask,
  TimeEntry,
  User,
  EmployeeDocument,
  WorkSession,
} from "./models";
import { ENV } from "./_core/env";

type UpsertUserInput = {
  openId: string;
  name?: string | null;
  email?: string | null;
  loginMethod?: string | null;
  role?: "user" | "admin";
  employeeId?: string | null;
  password?: string | null;
  avatar?: string | null;
  department?: string | null;
  position?: string | null;
  lastSignedIn?: Date;
};

const PRIORITY_RANK: Record<string, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

async function requireDb() {
  const connected = await connectToMongoDB();
  if (!connected) {
    throw new Error("Database not available");
  }
}

async function optionalDb(): Promise<boolean> {
  return connectToMongoDB();
}

function toObjectId(id: string) {
  if (!Types.ObjectId.isValid(id)) {
    throw new Error("Invalid id");
  }
  return new Types.ObjectId(id);
}

function normalizeValue(value: unknown): unknown {
  if (value instanceof Types.ObjectId) {
    return value.toString();
  }
  if (value instanceof Date) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(normalizeValue);
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      result[key] = normalizeValue(entry);
    }
    return result;
  }
  return value;
}

function normalizeDoc<T extends { _id?: Types.ObjectId }>(
  doc: T | null | undefined
) {
  if (!doc) return undefined;
  const raw = typeof (doc as any).toObject === "function" ? (doc as any).toObject() : doc;
  const { _id, __v, ...rest } = raw as any;
  const normalized = normalizeValue(rest) as Record<string, unknown>;
  return {
    id: _id ? _id.toString() : undefined,
    ...normalized,
  };
}

function normalizeDocs<T extends { _id?: Types.ObjectId }>(docs: T[]) {
  return docs.map(doc => normalizeDoc(doc)).filter(Boolean);
}

function sanitizeUser(user: any) {
  if (!user) return user;
  const { password, twoFactorSecret, ...rest } = user;
  return rest;
}

export async function upsertUser(user: UpsertUserInput): Promise<void> {
  await requireDb();
  if (!user.openId) {
    throw new Error("User openId is required for upsert");
  }

  const payload: Record<string, unknown> = {
    openId: user.openId,
  };

  const fields: Array<keyof UpsertUserInput> = [
    "name",
    "email",
    "loginMethod",
    "role",
    "employeeId",
    "password",
    "avatar",
    "department",
    "position",
    "lastSignedIn",
  ];

  for (const field of fields) {
    const value = user[field];
    if (value !== undefined) {
      payload[field] = value ?? null;
    }
  }

  if (!payload.lastSignedIn) {
    payload.lastSignedIn = new Date();
  }

  await User.updateOne(
    { openId: user.openId },
    { $set: payload, $setOnInsert: { openId: user.openId } },
    { upsert: true }
  );
}

export async function getUserByOpenId(openId: string) {
  if (!(await optionalDb())) return undefined;
  const user = await User.findOne({ openId }).lean();
  return sanitizeUser(normalizeDoc(user));
}

export async function getUserByEmployeeIdAndPassword(
  employeeId: string,
  password: string
) {
  if (!(await optionalDb())) return undefined;
  const user = await User.findOne({ employeeId }).lean();
  if (!user) return undefined;

  const hashed = user.password || "";
  const isPasswordValid = await bcrypt.compare(password, hashed).catch(() => false);
  const isPlainMatch = hashed.length === 0 ? false : hashed === password;

  if (!isPasswordValid && !isPlainMatch) return undefined;
  return sanitizeUser(normalizeDoc(user));
}

export async function verifyUserPassword(userId: string, password: string) {
  if (!(await optionalDb())) return false;
  const user = await User.findById(toObjectId(userId)).lean();
  if (!user) return false;

  const hashed = user.password || "";
  const isPasswordValid = await bcrypt.compare(password, hashed).catch(() => false);
  const isPlainMatch = hashed.length === 0 ? false : hashed === password;

  return isPasswordValid || isPlainMatch;
}

export async function updateUserPassword(userId: string, newPassword: string) {
  await requireDb();
  const hashed = await bcrypt.hash(newPassword, 10);
  await User.findByIdAndUpdate(toObjectId(userId), { password: hashed });
}

export async function createEmployee(input: {
  name: string;
  email: string;
  employeeId: string;
  password: string;
  department?: string;
  position?: string;
  role?: "user" | "admin";
}) {
  await requireDb();
  const hashed = await bcrypt.hash(input.password, 10);
  const openId = `emp-${input.employeeId.toLowerCase()}`;
  const created = await User.create({
    openId,
    name: input.name,
    email: input.email,
    loginMethod: "custom",
    role: input.role || "user",
    employeeId: input.employeeId,
    password: hashed,
    department: input.department,
    position: input.position,
    lastSignedIn: new Date(0),
  });
  return sanitizeUser(normalizeDoc(created));
}

export async function updateEmployee(userId: string, updates: {
  name?: string;
  email?: string;
  employeeId?: string;
  password?: string;
  department?: string;
  position?: string;
}) {
  await requireDb();
  const payload: Record<string, unknown> = {};
  if (updates.name !== undefined) payload.name = updates.name;
  if (updates.email !== undefined) payload.email = updates.email;
  if (updates.employeeId !== undefined) payload.employeeId = updates.employeeId;
  if (updates.department !== undefined) payload.department = updates.department;
  if (updates.position !== undefined) payload.position = updates.position;
  if (updates.password) {
    payload.password = await bcrypt.hash(updates.password, 10);
  }
  await User.findByIdAndUpdate(toObjectId(userId), payload);
  return getUserById(userId);
}

export async function upsertEmployeeDocument(input: {
  userId: string;
  documentType:
    | "offer_letter"
    | "contract"
    | "id_proof"
    | "id_proof_front"
    | "id_proof_back"
    | "policy_acknowledgment"
    | "other";
  title: string;
  documentUrl: string;
  uploadedBy: string;
}) {
  await requireDb();
  await EmployeeDocument.findOneAndUpdate(
    { userId: toObjectId(input.userId), documentType: input.documentType },
    {
      $set: {
        title: input.title,
        documentUrl: input.documentUrl,
        uploadedBy: toObjectId(input.uploadedBy),
      },
    },
    { upsert: true }
  );
}

export async function getUserById(id: string) {
  if (!(await optionalDb())) return undefined;
  const user = await User.findById(toObjectId(id)).lean();
  return sanitizeUser(normalizeDoc(user));
}

export async function getUserByIdWithSecret(id: string) {
  if (!(await optionalDb())) return undefined;
  const user = await User.findById(toObjectId(id)).lean();
  return normalizeDoc(user);
}

export async function setUserTwoFactorSecret(userId: string, secret: string) {
  await requireDb();
  await User.findByIdAndUpdate(toObjectId(userId), {
    twoFactorSecret: secret,
  });
}

export async function setUserTwoFactorEnabled(userId: string, enabled: boolean) {
  await requireDb();
  await User.findByIdAndUpdate(toObjectId(userId), {
    twoFactorEnabled: enabled,
  });
}

export async function updateUserAvatar(userId: string, avatar: string) {
  await requireDb();
  await User.findByIdAndUpdate(toObjectId(userId), { avatar });
}

export async function createTimeEntry(entry: {
  userId: string;
  timeIn: Date;
  status: "active" | "completed" | "early_out";
  notes?: string;
  location?: {
    lat: number;
    lng: number;
    accuracy?: number;
    address?: string;
    source?: "gps" | "manual";
    capturedAt?: Date;
  };
}) {
  await requireDb();
  const created = await TimeEntry.create({
    ...entry,
    userId: toObjectId(entry.userId),
  });
  return normalizeDoc(created);
}

export async function getActiveTimeEntry(userId: string) {
  if (!(await optionalDb())) return undefined;
  const entry = await TimeEntry.findOne({
    userId: toObjectId(userId),
    status: "active",
  })
    .sort({ createdAt: -1 })
    .lean();
  return normalizeDoc(entry);
}

export async function updateTimeEntry(id: string, updates: Record<string, unknown>) {
  await requireDb();
  await TimeEntry.findByIdAndUpdate(toObjectId(id), updates);
}

export async function createWorkSession(session: {
  userId: string;
  startTime: Date;
  endTime: Date;
  sessionType: "remote" | "onsite";
  description?: string;
}) {
  await requireDb();
  const startTime = new Date(session.startTime);
  const endTime = new Date(session.endTime);
  const sessionDate = new Date(startTime);
  sessionDate.setHours(0, 0, 0, 0);
  const totalHours = (endTime.getTime() - startTime.getTime()) / (1000 * 60 * 60);

  const created = await WorkSession.create({
    userId: toObjectId(session.userId),
    sessionDate,
    startTime,
    endTime,
    totalHours: Number(totalHours.toFixed(2)),
    sessionType: session.sessionType,
    description: session.description,
  });
  return normalizeDoc(created);
}

export async function createOvertimeEntry(entry: {
  userId: string;
  projectId: string;
  taskId: string;
  workDate: Date;
  hours: number;
  description?: string;
}) {
  await requireDb();
  const created = await OvertimeEntry.create({
    userId: toObjectId(entry.userId),
    projectId: toObjectId(entry.projectId),
    taskId: toObjectId(entry.taskId),
    workDate: entry.workDate,
    hours: Number(entry.hours.toFixed(2)),
    description: entry.description,
  });
  return normalizeDoc(created);
}

export async function getOvertimeEntriesByDateRange(
  userId: string,
  startDate: Date,
  endDate: Date
) {
  if (!(await optionalDb())) return [];
  const entries = await OvertimeEntry.find({
    userId: toObjectId(userId),
    workDate: { $gte: startDate, $lte: endDate },
  })
    .sort({ workDate: -1, createdAt: -1 })
    .lean();
  return normalizeDocs(entries);
}

export async function getTimeEntriesByDateRange(
  userId: string,
  startDate: Date,
  endDate: Date
) {
  if (!(await optionalDb())) return [];
  const entries = await TimeEntry.find({
    userId: toObjectId(userId),
    timeIn: { $gte: startDate, $lte: endDate },
  })
    .sort({ timeIn: -1 })
    .lean();
  return normalizeDocs(entries);
}

export async function createBreakLog(breakLog: {
  timeEntryId: string;
  userId: string;
  breakStart: Date;
  reason?: string;
}) {
  await requireDb();
  const created = await BreakLog.create({
    ...breakLog,
    timeEntryId: toObjectId(breakLog.timeEntryId),
    userId: toObjectId(breakLog.userId),
  });
  return normalizeDoc(created);
}

export async function getActiveBreak(timeEntryId: string) {
  if (!(await optionalDb())) return undefined;
  const result = await BreakLog.findOne({
    timeEntryId: toObjectId(timeEntryId),
    $or: [{ breakEnd: { $exists: false } }, { breakEnd: null }],
  }).lean();
  return normalizeDoc(result);
}

export async function updateBreakLog(id: string, updates: Record<string, unknown>) {
  await requireDb();
  await BreakLog.findByIdAndUpdate(toObjectId(id), updates);
}

export async function getBreakLogsByTimeEntry(timeEntryId: string) {
  if (!(await optionalDb())) return [];
  const logs = await BreakLog.find({ timeEntryId: toObjectId(timeEntryId) })
    .sort({ breakStart: -1 })
    .lean();
  return normalizeDocs(logs);
}

export async function createLeaveApplication(leave: {
  userId: string;
  leaveType: "sick" | "casual" | "annual" | "unpaid" | "other";
  startDate: Date;
  endDate: Date;
  reason: string;
}) {
  await requireDb();
  const created = await LeaveApplication.create({
    ...leave,
    userId: toObjectId(leave.userId),
  });
  return normalizeDoc(created);
}

export async function getLeaveApplicationsByUser(userId: string) {
  if (!(await optionalDb())) return [];
  const leaves = await LeaveApplication.find({ userId: toObjectId(userId) })
    .sort({ createdAt: -1 })
    .lean();
  return normalizeDocs(leaves);
}

export async function createFormSubmission(form: {
  userId: string;
  formType: "resignation" | "leave" | "grievance" | "feedback";
  subject: string;
  content: string;
  priority?: "low" | "medium" | "high";
}) {
  await requireDb();
  const created = await FormSubmission.create({
    ...form,
    userId: toObjectId(form.userId),
  });
  return normalizeDoc(created);
}

export async function getFormSubmissionsByUser(userId: string) {
  if (!(await optionalDb())) return [];
  const submissions = await FormSubmission.find({ userId: toObjectId(userId) })
    .sort({ createdAt: -1 })
    .lean();
  return normalizeDocs(submissions);
}

export async function createChatMessage(message: {
  senderId: string;
  recipientId?: string;
  message: string;
}) {
  await requireDb();
  const created = await ChatMessage.create({
    senderId: toObjectId(message.senderId),
    recipientId: message.recipientId ? toObjectId(message.recipientId) : undefined,
    message: message.message,
  });
  return normalizeDoc(created);
}

export async function getChatMessages(userId: string, limit: number = 50) {
  if (!(await optionalDb())) return [];
  const userObjectId = toObjectId(userId);
  const messages = await ChatMessage.find({
    $or: [
      { senderId: userObjectId },
      { recipientId: userObjectId },
      { recipientId: { $exists: false } },
      { recipientId: null },
    ],
  })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
  return normalizeDocs(messages);
}

export async function markMessageAsRead(id: string) {
  await requireDb();
  await ChatMessage.findByIdAndUpdate(toObjectId(id), { isRead: true });
}

export async function getNotesByUser(userId: string) {
  if (!(await optionalDb())) return [];
  const notes = await Note.find({ userId: toObjectId(userId) })
    .sort({ updatedAt: -1, createdAt: -1 })
    .lean();
  return normalizeDocs(notes);
}

export async function createNote(note: {
  userId: string;
  title: string;
  content?: string;
}) {
  await requireDb();
  const created = await Note.create({
    userId: toObjectId(note.userId),
    title: note.title,
    content: note.content || "",
  });
  return normalizeDoc(created);
}

export async function updateNote(
  noteId: string,
  userId: string,
  updates: { title?: string; content?: string }
) {
  await requireDb();
  const payload: Record<string, unknown> = {};
  if (updates.title !== undefined) payload.title = updates.title;
  if (updates.content !== undefined) payload.content = updates.content;

  const updated = await Note.findOneAndUpdate(
    { _id: toObjectId(noteId), userId: toObjectId(userId) },
    { $set: payload },
    { new: true }
  ).lean();
  return normalizeDoc(updated);
}

export async function deleteNote(noteId: string, userId: string) {
  await requireDb();
  await Note.findOneAndDelete({
    _id: toObjectId(noteId),
    userId: toObjectId(userId),
  });
  return true;
}

export async function getLatestPayslip(userId: string) {
  if (!(await optionalDb())) return undefined;
  const payslip = await Payslip.findOne({ userId: toObjectId(userId) })
    .sort({ year: -1, month: -1 })
    .lean();
  return normalizeDoc(payslip);
}

export async function getPayslipsByUser(userId: string) {
  if (!(await optionalDb())) return [];
  const payslips = await Payslip.find({ userId: toObjectId(userId) })
    .sort({ year: -1, month: -1, createdAt: -1 })
    .lean();
  return normalizeDocs(payslips);
}

export async function getActiveAnnouncements() {
  if (!(await optionalDb())) return [];
  const now = new Date();
  const announcements = await Announcement.find({
    isActive: true,
    $or: [{ expiresAt: { $exists: false } }, { expiresAt: null }, { expiresAt: { $gt: now } }],
  })
    .sort({ createdAt: -1 })
    .lean();

  const normalized = normalizeDocs(announcements);
  return normalized.sort((a: any, b: any) => {
    const rankDiff = (PRIORITY_RANK[b.priority] || 0) - (PRIORITY_RANK[a.priority] || 0);
    if (rankDiff !== 0) return rankDiff;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
}

export async function getAnnouncementReadIds(userId: string) {
  if (!(await optionalDb())) return [];
  const reads = await AnnouncementRead.find({ userId: toObjectId(userId) }).lean();
  return reads.map((read: any) => read.announcementId?.toString()).filter(Boolean);
}

export async function getAnnouncementsWithReadCounts() {
  if (!(await optionalDb())) return [];
  const announcements = await Announcement.find()
    .sort({ createdAt: -1 })
    .populate("createdBy")
    .lean();

  const ids = announcements.map((a: any) => a._id).filter(Boolean);
  const readCounts = await AnnouncementRead.aggregate([
    { $match: { announcementId: { $in: ids } } },
    { $group: { _id: "$announcementId", count: { $sum: 1 } } },
  ]);
  const readCountMap = new Map(readCounts.map((entry: any) => [entry._id.toString(), entry.count]));

  return announcements.map((announcement: any) => ({
    ...normalizeDoc(announcement),
    createdBy: announcement.createdBy ? normalizeDoc(announcement.createdBy as any) : undefined,
    readCount: readCountMap.get(announcement._id.toString()) || 0,
  }));
}

export async function createAnnouncement(data: {
  title: string;
  content: string;
  priority: "low" | "medium" | "high";
  createdBy: string;
  expiresAt?: Date | null;
  isActive?: boolean;
}) {
  await requireDb();
  const created = await Announcement.create({
    title: data.title,
    content: data.content,
    priority: data.priority,
    createdBy: toObjectId(data.createdBy),
    expiresAt: data.expiresAt || undefined,
    isActive: data.isActive ?? true,
  });
  return normalizeDoc(created);
}

export async function deleteAnnouncement(id: string) {
  await requireDb();
  await Announcement.findByIdAndDelete(toObjectId(id));
  await AnnouncementRead.deleteMany({ announcementId: toObjectId(id) });
  return { success: true };
}

export async function getAllUsers() {
  if (!(await optionalDb())) return [];
  const users = await User.find().lean();
  return normalizeDocs(users).map(sanitizeUser);
}

export async function getUserProjects(userId: string) {
  if (!(await optionalDb())) return [];
  const assignments = await ProjectAssignment.find({ userId: toObjectId(userId) })
    .populate("projectId")
    .lean();

  return assignments
    .map((assignment: any) => {
      if (!assignment.projectId) return undefined;
      const project = assignment.projectId as any;
      return normalizeDoc({ ...project, role: assignment.role });
    })
    .filter(Boolean);
}

export async function getProjectsForEmployee(userId: string) {
  if (!(await optionalDb())) return [];
  const assignments = await ProjectAssignment.find({ userId: toObjectId(userId) })
    .populate("projectId")
    .lean();

  return assignments
    .map((assignment: any) => {
      if (!assignment.projectId) return undefined;
      const project = assignment.projectId as any;
      return normalizeDoc({ ...project, role: assignment.role });
    })
    .filter(Boolean);
}

export async function getProjectTasks(projectId: string, userId: string) {
  if (!(await optionalDb())) return [];
  const userObjectId = toObjectId(userId);
  const tasks = await ProjectTask.find({
    projectId: toObjectId(projectId),
    $or: [
      { assigneeIds: userObjectId },
      {
        $and: [
          {
            $or: [
              { assigneeIds: { $exists: false } },
              { assigneeIds: { $size: 0 } },
            ],
          },
          { userId: userObjectId },
        ],
      },
    ],
  }).lean();
  return normalizeDocs(tasks);
}

export async function getAllProjectTasks(projectId: string) {
  if (!(await optionalDb())) return [];
  const tasks = await ProjectTask.find({ projectId: toObjectId(projectId) })
    .sort({ createdAt: -1 })
    .populate("assigneeIds")
    .populate("userId")
    .lean();

  return tasks.map((task: any) => {
    const assignees =
      Array.isArray(task.assigneeIds) && task.assigneeIds.length > 0
        ? task.assigneeIds
        : task.userId
          ? [task.userId]
          : [];
    return {
      ...normalizeDoc(task),
      assignees: assignees.map((u: any) => normalizeDoc(u as any)).filter(Boolean),
    };
  });
}

export async function getTasksByEmployee(userId: string) {
  if (!(await optionalDb())) return [];
  const userObjectId = toObjectId(userId);
  const tasks = await ProjectTask.find({
    $or: [
      { assigneeIds: userObjectId },
      {
        $and: [
          {
            $or: [
              { assigneeIds: { $exists: false } },
              { assigneeIds: { $size: 0 } },
            ],
          },
          { userId: userObjectId },
        ],
      },
    ],
  })
    .populate("projectId")
    .populate("assigneeIds")
    .sort({ createdAt: -1 })
    .lean();

  return tasks.map((task: any) => ({
    ...normalizeDoc(task),
    project: task.projectId ? normalizeDoc(task.projectId as any) : undefined,
    assignees: Array.isArray(task.assigneeIds)
      ? task.assigneeIds.map((u: any) => normalizeDoc(u as any)).filter(Boolean)
      : [],
  }));
}

export async function createProject(project: Record<string, unknown>) {
  await requireDb();
  const created = await Project.create({
    ...project,
    createdBy: project.createdBy ? toObjectId(project.createdBy as string) : undefined,
  });
  const normalized = normalizeDoc(created);
  return normalized?.id as string;
}

export async function assignUserToProject(projectId: string, userId: string) {
  await requireDb();
  await ProjectAssignment.create({
    projectId: toObjectId(projectId),
    userId: toObjectId(userId),
    role: "member",
  });
}

export async function createProjectTask(task: Record<string, unknown>) {
  await requireDb();
  const rawAssigneeIds = Array.isArray((task as any).assigneeIds)
    ? ((task as any).assigneeIds as string[])
    : [];
  const uniqueAssignees = Array.from(
    new Set(
      rawAssigneeIds
        .filter(Boolean)
        .filter(id => Types.ObjectId.isValid(id))
    )
  );
  const fallbackAssignees =
    uniqueAssignees.length === 0 && typeof task.userId === "string" && Types.ObjectId.isValid(task.userId)
      ? [task.userId]
      : uniqueAssignees;

  const created = await ProjectTask.create({
    ...task,
    projectId: task.projectId ? toObjectId(task.projectId as string) : undefined,
    userId: task.userId ? toObjectId(task.userId as string) : undefined,
    timeEntryId: task.timeEntryId ? toObjectId(task.timeEntryId as string) : undefined,
    assigneeIds: fallbackAssignees.map(toObjectId),
  });
  return normalizeDoc(created);
}

export async function deleteProjectTask(taskId: string) {
  await requireDb();
  const taskObjectId = toObjectId(taskId);
  await OvertimeEntry.deleteMany({ taskId: taskObjectId });
  await ProjectTask.findByIdAndDelete(taskObjectId);
  return true;
}

export async function deleteProject(projectId: string) {
  await requireDb();
  const projectObjectId = toObjectId(projectId);
  const tasks = await ProjectTask.find({ projectId: projectObjectId }).select("_id").lean();
  const taskIds = tasks.map((t: any) => t._id);
  if (taskIds.length > 0) {
    await OvertimeEntry.deleteMany({ taskId: { $in: taskIds } });
  }
  await ProjectTask.deleteMany({ projectId: projectObjectId });
  await ProjectAssignment.deleteMany({ projectId: projectObjectId });
  await OvertimeEntry.deleteMany({ projectId: projectObjectId });
  await Project.findByIdAndDelete(projectObjectId);
  return true;
}

export async function getTasksCreatedByDate(startDate: Date, endDate: Date) {
  await requireDb();
  const tasks = await ProjectTask.find({
    createdAt: { $gte: startDate, $lte: endDate },
  })
    .populate("projectId")
    .populate("assigneeIds")
    .populate("userId")
    .sort({ createdAt: -1 })
    .lean();

  return tasks.map((task: any) => {
    const assigneeList =
      Array.isArray(task.assigneeIds) && task.assigneeIds.length > 0
        ? task.assigneeIds
        : task.userId
          ? [task.userId]
          : [];

    return {
      ...normalizeDoc(task),
      project: task.projectId ? normalizeDoc(task.projectId as any) : undefined,
      assignees: assigneeList
        .map((u: any) => normalizeDoc(u as any))
        .filter(Boolean),
    };
  });
}

export async function updateProjectTask(id: string, updates: Record<string, unknown>) {
  await requireDb();
  const payload: Record<string, unknown> = { ...updates };
  if (Array.isArray((payload as any).assigneeIds)) {
    const rawIds = (payload as any).assigneeIds as string[];
    const unique = Array.from(
      new Set(rawIds.filter(Boolean).filter(id => Types.ObjectId.isValid(id)))
    );
    payload.assigneeIds = unique.map(toObjectId);
  }
  await ProjectTask.findByIdAndUpdate(toObjectId(id), payload);
}

export async function getCompletedTasksForUserByDate(userId: string, date: Date) {
  if (!(await optionalDb())) return [];
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(date);
  end.setHours(23, 59, 59, 999);

  const userObjectId = toObjectId(userId);
  const tasks = await ProjectTask.find({
    status: "completed",
    $and: [
      {
        $or: [
          { assigneeIds: userObjectId },
          {
            $and: [
              {
                $or: [
                  { assigneeIds: { $exists: false } },
                  { assigneeIds: { $size: 0 } },
                ],
              },
              { userId: userObjectId },
            ],
          },
        ],
      },
      {
        $or: [
          { completedAt: { $gte: start, $lte: end } },
          { completedAt: { $exists: false }, updatedAt: { $gte: start, $lte: end } },
          { completedAt: null, updatedAt: { $gte: start, $lte: end } },
        ],
      },
    ],
  })
    .populate("projectId")
    .sort({ completedAt: -1, updatedAt: -1 })
    .lean();

  return tasks.map((task: any) => ({
    ...normalizeDoc(task),
    project: task.projectId ? normalizeDoc(task.projectId as any) : undefined,
  }));
}

export async function getProjectStats(userId: string) {
  if (!(await optionalDb())) {
    return { totalAssigned: 0, activeProjects: 0, completedTasks: 0 };
  }

  const userObjectId = toObjectId(userId);
  const assignments = await ProjectAssignment.find({ userId: userObjectId })
    .select("projectId")
    .lean();
  const projectIds = assignments.map((assignment: any) => assignment.projectId);

  const [totalAssigned, activeProjects, completedTasks] = await Promise.all([
    ProjectAssignment.countDocuments({ userId: userObjectId }),
    projectIds.length > 0
      ? Project.countDocuments({ _id: { $in: projectIds }, status: "active" })
      : Promise.resolve(0),
    ProjectTask.countDocuments({
      status: "completed",
      $or: [
        { assigneeIds: userObjectId },
        {
          $and: [
            {
              $or: [
                { assigneeIds: { $exists: false } },
                { assigneeIds: { $size: 0 } },
              ],
            },
            { userId: userObjectId },
          ],
        },
      ],
    }),
  ]);

  return {
    totalAssigned,
    activeProjects,
    completedTasks,
  };
}

export async function getTaskStatsForUser(userId: string) {
  if (!(await optionalDb())) {
    return { total: 0, completed: 0 };
  }

  const userObjectId = toObjectId(userId);
  const assignmentFilter = {
    $or: [
      { assigneeIds: userObjectId },
      {
        $and: [
          {
            $or: [
              { assigneeIds: { $exists: false } },
              { assigneeIds: { $size: 0 } },
            ],
          },
          { userId: userObjectId },
        ],
      },
    ],
  };

  const [total, completed] = await Promise.all([
    ProjectTask.countDocuments(assignmentFilter),
    ProjectTask.countDocuments({ ...assignmentFilter, status: "completed" }),
  ]);

  return { total, completed };
}

export async function getTaskStatsForAll() {
  if (!(await optionalDb())) {
    return { total: 0, completed: 0 };
  }

  const [total, completed] = await Promise.all([
    ProjectTask.countDocuments({}),
    ProjectTask.countDocuments({ status: "completed" }),
  ]);

  return { total, completed };
}

export async function createNotification(notification: {
  userId: string;
  type: string;
  title: string;
  message: string;
  priority?: "low" | "medium" | "high";
  relatedId?: string;
  relatedType?: string;
}) {
  await requireDb();
  await Notification.create({
    ...notification,
    userId: toObjectId(notification.userId),
    relatedId: notification.relatedId ? toObjectId(notification.relatedId) : undefined,
  });
}

export async function getNotifications(userId: string) {
  if (!(await optionalDb())) return [];
  const list = await Notification.find({ userId: toObjectId(userId) })
    .sort({ createdAt: -1 })
    .lean();
  return normalizeDocs(list);
}

export async function getUnreadNotificationCount(userId: string) {
  if (!(await optionalDb())) return 0;
  return Notification.countDocuments({
    userId: toObjectId(userId),
    isRead: false,
  });
}

export async function markNotificationAsRead(notificationId: string, userId: string) {
  await requireDb();
  await Notification.findOneAndUpdate(
    { _id: toObjectId(notificationId), userId: toObjectId(userId) },
    { isRead: true }
  );
}

export async function markAllNotificationsAsRead(userId: string) {
  await requireDb();
  await Notification.updateMany({ userId: toObjectId(userId) }, { isRead: true });
}

export async function deleteNotification(notificationId: string, userId: string) {
  await requireDb();
  await Notification.findOneAndDelete({
    _id: toObjectId(notificationId),
    userId: toObjectId(userId),
  });
}

export async function markAnnouncementAsRead(announcementId: string, userId: string) {
  await requireDb();
  const exists = await AnnouncementRead.findOne({
    announcementId: toObjectId(announcementId),
    userId: toObjectId(userId),
  }).lean();

  if (!exists) {
    await AnnouncementRead.create({
      announcementId: toObjectId(announcementId),
      userId: toObjectId(userId),
    });
  }
}

export async function getAnnouncementReadStatus(announcementId: string, userId: string) {
  if (!(await optionalDb())) return false;
  const existing = await AnnouncementRead.findOne({
    announcementId: toObjectId(announcementId),
    userId: toObjectId(userId),
  }).lean();
  return Boolean(existing);
}

export async function createMeeting(data: {
  title: string;
  description?: string;
  agenda?: string;
  startTime: Date;
  endTime: Date;
  location?: string;
  meetingLink?: string;
  organizerId: string;
}) {
  await requireDb();
  const created = await Meeting.create({
    ...data,
    organizerId: toObjectId(data.organizerId),
  });
  return normalizeDoc(created);
}

export async function getMeetingById(id: string) {
  if (!(await optionalDb())) return null;
  const meeting = await Meeting.findById(toObjectId(id)).lean();
  return normalizeDoc(meeting) ?? null;
}

export async function getMeetingsByUserId(userId: string) {
  if (!(await optionalDb())) return [];
  const userObjectId = toObjectId(userId);
  const organizerMeetings = await Meeting.find({ organizerId: userObjectId }).lean();

  const participantMeetings = await MeetingParticipant.find({ userId: userObjectId })
    .populate("meetingId")
    .lean();

  const combined: Record<string, any> = {};

  organizerMeetings.forEach(meeting => {
    const normalized = normalizeDoc(meeting);
    if (normalized?.id) combined[normalized.id] = normalized;
  });

  participantMeetings.forEach((participant: any) => {
    if (!participant.meetingId) return;
    const normalized = normalizeDoc(participant.meetingId as any);
    if (normalized?.id) combined[normalized.id] = normalized;
  });

  return Object.values(combined).sort((a: any, b: any) => {
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
}

export async function getMeetingsByDateRange(startDate: Date, endDate: Date) {
  if (!(await optionalDb())) return [];
  const meetings = await Meeting.find({
    startTime: { $gte: startDate, $lte: endDate },
  })
    .sort({ startTime: 1 })
    .lean();
  return normalizeDocs(meetings);
}

export async function updateMeeting(id: string, data: Record<string, unknown>) {
  await requireDb();
  await Meeting.findByIdAndUpdate(toObjectId(id), data);
  return getMeetingById(id);
}

export async function deleteMeeting(id: string) {
  await requireDb();
  const meetingId = toObjectId(id);
  await MeetingParticipant.deleteMany({ meetingId });
  await Meeting.findByIdAndDelete(meetingId);
  return true;
}

export async function addMeetingParticipant(data: {
  meetingId: string;
  userId: string;
  responseStatus?: "pending" | "accepted" | "declined" | "tentative";
}) {
  await requireDb();
  return MeetingParticipant.create({
    meetingId: toObjectId(data.meetingId),
    userId: toObjectId(data.userId),
    responseStatus: data.responseStatus || "pending",
  });
}

export async function getMeetingParticipants(meetingId: string) {
  if (!(await optionalDb())) return [];
  const participants = await MeetingParticipant.find({ meetingId: toObjectId(meetingId) })
    .populate("userId")
    .lean();
  return participants.map((participant: any) => {
    const normalizedParticipant = normalizeDoc(participant);
    const normalizedUser = participant.userId ? normalizeDoc(participant.userId as any) : null;
    return { participant: normalizedParticipant, user: normalizedUser };
  });
}

export async function updateParticipantResponse(
  meetingId: string,
  userId: string,
  responseStatus: string
) {
  await requireDb();
  await MeetingParticipant.findOneAndUpdate(
    {
      meetingId: toObjectId(meetingId),
      userId: toObjectId(userId),
    },
    { responseStatus }
  );
  return true;
}

export async function removeMeetingParticipant(meetingId: string, userId: string) {
  await requireDb();
  await MeetingParticipant.findOneAndDelete({
    meetingId: toObjectId(meetingId),
    userId: toObjectId(userId),
  });
  return true;
}

export async function createCalendarEvent(data: {
  userId: string;
  title: string;
  description?: string;
  startTime: Date;
  endTime: Date;
  eventType: "reminder" | "personal" | "deadline" | "holiday";
  isAllDay?: boolean;
}) {
  await requireDb();
  const created = await CalendarEvent.create({
    ...data,
    userId: toObjectId(data.userId),
    isAllDay: Boolean(data.isAllDay),
  });
  return normalizeDoc(created);
}

export async function getCalendarEventById(id: string) {
  if (!(await optionalDb())) return null;
  const event = await CalendarEvent.findById(toObjectId(id)).lean();
  return normalizeDoc(event) ?? null;
}

export async function getCalendarEventsByUserId(userId: string) {
  if (!(await optionalDb())) return [];
  const events = await CalendarEvent.find({ userId: toObjectId(userId) })
    .sort({ startTime: -1 })
    .lean();
  return normalizeDocs(events);
}

export async function getCalendarEventsByDateRange(
  userId: string,
  startDate: Date,
  endDate: Date
) {
  if (!(await optionalDb())) return [];
  const events = await CalendarEvent.find({
    userId: toObjectId(userId),
    startTime: { $gte: startDate, $lte: endDate },
  })
    .sort({ startTime: 1 })
    .lean();
  return normalizeDocs(events);
}

export async function updateCalendarEvent(id: string, data: Record<string, unknown>) {
  await requireDb();
  await CalendarEvent.findByIdAndUpdate(toObjectId(id), data);
  return getCalendarEventById(id);
}

export async function deleteCalendarEvent(id: string) {
  await requireDb();
  await CalendarEvent.findByIdAndDelete(toObjectId(id));
  return true;
}

export async function getAllLeaveApplicationsWithUsers() {
  await requireDb();
  const leaves = await LeaveApplication.find()
    .sort({ createdAt: -1 })
    .populate("userId")
    .lean();

  return leaves.map((leave: any) => ({
    ...normalizeDoc(leave),
    user: leave.userId ? normalizeDoc(leave.userId as any) : undefined,
  }));
}

export async function updateLeaveApplicationStatus(
  id: string,
  status: "pending" | "approved" | "rejected",
  approverId: string,
  rejectionReason?: string
) {
  await requireDb();
  await LeaveApplication.findByIdAndUpdate(toObjectId(id), {
    status,
    approvedBy: toObjectId(approverId),
    approvedAt: status === "approved" ? new Date() : undefined,
    rejectionReason: status === "rejected" ? rejectionReason || "Rejected" : undefined,
  });
}

export async function getAllFormSubmissionsWithUsers() {
  await requireDb();
  const forms = await FormSubmission.find()
    .sort({ createdAt: -1 })
    .populate("userId")
    .lean();

  return forms.map((form: any) => ({
    ...normalizeDoc(form),
    user: form.userId ? normalizeDoc(form.userId as any) : undefined,
  }));
}

export async function updateFormSubmissionStatus(
  id: string,
  status: "submitted" | "under_review" | "resolved" | "closed",
  responderId: string,
  response?: string
) {
  await requireDb();
  await FormSubmission.findByIdAndUpdate(toObjectId(id), {
    status,
    respondedBy: toObjectId(responderId),
    response: response || undefined,
  });
}

export async function getProjectsWithAssignments() {
  await requireDb();
  const projects = await Project.find().sort({ createdAt: -1 }).lean();
  const projectIds = projects.map((p: any) => p._id);
  const assignments = await ProjectAssignment.find({ projectId: { $in: projectIds } }).lean();
  const userIds = Array.from(new Set(assignments.map((a: any) => String(a.userId))));
  const users = await User.find({ _id: { $in: userIds.map(toObjectId) } }).lean();
  const userMap = new Map(users.map((u: any) => [String(u._id), u]));

  const tasks = await ProjectTask.find({ projectId: { $in: projectIds } }).lean();
  const tasksByProject = new Map<string, any[]>();
  tasks.forEach((task: any) => {
    const id = String(task.projectId);
    if (!tasksByProject.has(id)) tasksByProject.set(id, []);
    tasksByProject.get(id)!.push(task);
  });

  return projects.map((project: any) => {
    const projAssignments = assignments.filter((a: any) => String(a.projectId) === String(project._id));
    const assignees = projAssignments
      .map((a: any) => userMap.get(String(a.userId)))
      .filter(Boolean)
      .map((u: any) => u.name || u.employeeId || "Employee");

    const projectTasks = tasksByProject.get(String(project._id)) || [];
    const completed = projectTasks.filter((t: any) => t.status === "completed").length;
    const total = projectTasks.length;
    const progress = total > 0 ? Math.round((completed / total) * 100) : 0;

    return {
      ...normalizeDoc(project),
      assignees,
      tasks: total,
      progress,
    };
  });
}

export async function getResourcePerformance() {
  await requireDb();
  const users = await User.find({ role: "user" }).lean();
  const userIds = users.map((u: any) => u._id);
  const userIdSet = new Set(userIds.map((id: any) => String(id)));

  const assignments = await ProjectAssignment.find({ userId: { $in: userIds } }).lean();
  const projectIds = Array.from(
    new Set(assignments.map((a: any) => String(a.projectId)))
  );
  const projects = await Project.find({ _id: { $in: projectIds.map(toObjectId) } }).lean();
  const projectStatusMap = new Map(projects.map((p: any) => [String(p._id), p.status]));

  const tasks = await ProjectTask.find({
    $or: [
      { assigneeIds: { $in: userIds } },
      {
        $and: [
          {
            $or: [
              { assigneeIds: { $exists: false } },
              { assigneeIds: { $size: 0 } },
            ],
          },
          { userId: { $in: userIds } },
        ],
      },
    ],
  }).lean();

  const taskMap = new Map<string, { total: number; completed: number }>();
  const projectMap = new Map<string, number>();

  users.forEach((u: any) => {
    taskMap.set(String(u._id), { total: 0, completed: 0 });
    projectMap.set(String(u._id), 0);
  });

  assignments.forEach((assignment: any) => {
    const userId = String(assignment.userId);
    if (!userIdSet.has(userId)) return;
    const status = projectStatusMap.get(String(assignment.projectId));
    if (status === "active") {
      projectMap.set(userId, (projectMap.get(userId) || 0) + 1);
    }
  });

  tasks.forEach((task: any) => {
    const assignees =
      Array.isArray(task.assigneeIds) && task.assigneeIds.length > 0
        ? task.assigneeIds
        : task.userId
          ? [task.userId]
          : [];
    assignees
      .map((id: any) => String(id))
      .filter((id: string) => userIdSet.has(id))
      .forEach((id: string) => {
        const current = taskMap.get(id) || { total: 0, completed: 0 };
        current.total += 1;
        if (task.status === "completed") {
          current.completed += 1;
        }
        taskMap.set(id, current);
      });
  });

  return users.map((u: any) => {
    const key = String(u._id);
    const taskStats = taskMap.get(key) || { total: 0, completed: 0 };
    const activeProjects = projectMap.get(key) || 0;
    const completionRate = taskStats.total
      ? Math.round((taskStats.completed / taskStats.total) * 100)
      : 0;

    return {
      userId: key,
      name: u.name || u.employeeId || "Employee",
      tasksTotal: taskStats.total,
      tasksCompleted: taskStats.completed,
      tasksPending: Math.max(0, taskStats.total - taskStats.completed),
      completionRate,
      activeProjects,
    };
  });
}

export async function getOngoingTasksWithAssignments() {
  await requireDb();
  const tasks = await ProjectTask.find({ status: { $ne: "completed" } })
    .sort({ createdAt: -1 })
    .lean();
  const userIds = Array.from(
    new Set(
      tasks.flatMap((t: any) => {
        const assignees =
          Array.isArray(t.assigneeIds) && t.assigneeIds.length > 0
            ? t.assigneeIds
            : t.userId
              ? [t.userId]
              : [];
        return assignees.map((id: any) => String(id));
      })
    )
  );
  const projectIds = Array.from(new Set(tasks.map((t: any) => String(t.projectId))));
  const users = await User.find({ _id: { $in: userIds.map(toObjectId) } }).lean();
  const projects = await Project.find({ _id: { $in: projectIds.map(toObjectId) } }).lean();
  const userMap = new Map(users.map((u: any) => [String(u._id), u]));
  const projectMap = new Map(projects.map((p: any) => [String(p._id), p]));

  return tasks.map((task: any) => ({
    ...normalizeDoc(task),
    assignees: Array.from(
      new Set(
        (
          Array.isArray(task.assigneeIds) && task.assigneeIds.length > 0
            ? task.assigneeIds
            : task.userId
              ? [task.userId]
              : []
        )
          .filter(Boolean)
          .map((id: any) => userMap.get(String(id)))
          .filter(Boolean)
      )
    ),
    project: projectMap.get(String(task.projectId)),
  }));
}

export async function getEmployeeStatusSnapshot() {
  await requireDb();
  const users = await User.find({ role: "user" }).lean();
  const userIds = users.map((u: any) => u._id);
  const now = new Date();
  const officeLat = Number.isFinite(ENV.officeLat) ? ENV.officeLat : null;
  const officeLng = Number.isFinite(ENV.officeLng) ? ENV.officeLng : null;
  const officeRadiusKm =
    typeof ENV.officeRadiusKm === "number" && !Number.isNaN(ENV.officeRadiusKm)
      ? ENV.officeRadiusKm
      : 0.5;

  const activeEntries = await TimeEntry.find({ userId: { $in: userIds }, status: "active" }).lean();
  const activeEntryByUser = new Map(activeEntries.map((e: any) => [String(e.userId), e]));
  const activeEntryIds = activeEntries.map((e: any) => e._id);
  const activeBreaks = await BreakLog.find({
    timeEntryId: { $in: activeEntryIds },
    $or: [{ breakEnd: { $exists: false } }, { breakEnd: null }],
  }).lean();
  const breakEntrySet = new Set(activeBreaks.map((b: any) => String(b.timeEntryId)));

  const leaveToday = await LeaveApplication.find({
    userId: { $in: userIds },
    status: "approved",
    startDate: { $lte: now },
    endDate: { $gte: now },
  }).lean();
  const leaveUserSet = new Set(leaveToday.map((l: any) => String(l.userId)));

  return users.map((u: any) => {
    const activeEntry = activeEntryByUser.get(String(u._id));
    const status = activeEntry
      ? breakEntrySet.has(String(activeEntry._id))
        ? "on_break"
        : "timed_in"
      : leaveUserSet.has(String(u._id))
        ? "on_leave"
        : "offline";
    let timeIn = null;
    let hours = null;
    if (activeEntry) {
      timeIn = activeEntry.timeIn;
      const diffMs = now.getTime() - new Date(activeEntry.timeIn).getTime();
      hours = `${(diffMs / (1000 * 60 * 60)).toFixed(1)}h`;
    }

    const location = activeEntry?.location ?? null;
    let distanceKm: number | null = null;
    let locationTag: "office" | "remote" | null = null;
    if (
      location &&
      typeof location.lat === "number" &&
      typeof location.lng === "number" &&
      officeLat !== null &&
      officeLng !== null
    ) {
      const toRad = (deg: number) => (deg * Math.PI) / 180;
      const dLat = toRad(location.lat - officeLat);
      const dLng = toRad(location.lng - officeLng);
      const lat1 = toRad(officeLat);
      const lat2 = toRad(location.lat);
      const a =
        Math.sin(dLat / 2) ** 2 +
        Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      const km = 6371 * c;
      distanceKm = Number(km.toFixed(1));
      locationTag = km <= officeRadiusKm ? "office" : "remote";
    }

    return {
      id: String(u._id),
      name: u.name,
      designation: u.position || "Employee",
      status,
      timeIn,
      hours,
      location,
      locationDistanceKm: distanceKm,
      locationTag,
    };
  });
}

export async function getAverageHoursByDay(days = 5) {
  await requireDb();
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - (days - 1));
  start.setHours(0, 0, 0, 0);

  const entries = await TimeEntry.find({
    timeIn: { $gte: start, $lte: end },
    status: { $ne: "active" },
  }).lean();

  const dayMap = new Map<string, { total: number; count: number }>();
  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const key = d.toISOString().slice(0, 10);
    dayMap.set(key, { total: 0, count: 0 });
  }

  entries.forEach((entry: any) => {
    const key = new Date(entry.timeIn).toISOString().slice(0, 10);
    const bucket = dayMap.get(key);
    if (!bucket) return;
    const hours = entry.totalHours
      ? Number(entry.totalHours)
      : entry.timeOut
        ? (new Date(entry.timeOut).getTime() - new Date(entry.timeIn).getTime()) / (1000 * 60 * 60)
        : 0;
    bucket.total += hours;
    bucket.count += 1;
  });

  const labels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return Array.from(dayMap.entries()).map(([key, bucket]) => {
    const d = new Date(key);
    const avg = bucket.count ? bucket.total / bucket.count : 0;
    return { day: labels[d.getDay()], hours: Number(avg.toFixed(1)) };
  });
}

export async function getTimeEntriesByRangeForAll(startDate: Date, endDate: Date) {
  await requireDb();
  const entries = await TimeEntry.find({
    timeIn: { $gte: startDate, $lte: endDate },
  }).lean();
  return normalizeDocs(entries);
}

export async function getAllPayslipsWithUsers() {
  await requireDb();
  const payslips = await Payslip.find()
    .sort({ createdAt: -1 })
    .populate("userId")
    .lean();
  return payslips.map((p: any) => ({
    ...normalizeDoc(p),
    user: p.userId ? normalizeDoc(p.userId as any) : undefined,
  }));
}
