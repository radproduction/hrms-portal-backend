import "dotenv/config";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import { connectToMongoDB } from "../mongodb";
import {
  AnnouncementRead,
  BreakLog,
  CalendarEvent,
  ChatMessage,
  Compensation,
  ComplianceRecord,
  EmployeeAuditLog,
  EmployeeDocument,
  EmployeeProfile,
  EmploymentDetail,
  FormSubmission,
  JobHistory,
  LeaveApplication,
  Meeting,
  MeetingParticipant,
  Note,
  Notification,
  OvertimeEntry,
  Payslip,
  PerformanceRecord,
  Project,
  ProjectAssignment,
  ProjectTask,
  Qualification,
  TimeEntry,
  User,
  WorkSession,
} from "../models";
import { adminFallbackSeed, employeeSeeds } from "./manus-data";

async function ensureAdminUser() {
  const existingAdmin = await User.findOne({ role: "admin" });
  if (existingAdmin) {
    return existingAdmin;
  }

  const passwordHash = await bcrypt.hash(adminFallbackSeed.password, 10);
  return await User.create({
    openId: adminFallbackSeed.openId,
    name: adminFallbackSeed.name,
    email: adminFallbackSeed.email,
    loginMethod: "custom",
    role: "admin",
    employeeId: adminFallbackSeed.employeeId,
    password: passwordHash,
    department: adminFallbackSeed.department,
    position: adminFallbackSeed.position,
    lastSignedIn: new Date(),
  });
}

async function purgeNonAdminData() {
  const existingEmployees = await User.find({ role: { $ne: "admin" } }).select("_id").lean();
  const employeeIds = existingEmployees.map(user => user._id);

  if (employeeIds.length === 0) {
    return;
  }

  const timeEntryIds = (await TimeEntry.find({ userId: { $in: employeeIds } }).select("_id").lean()).map(
    entry => entry._id
  );
  const meetingIds = (await Meeting.find({ organizerId: { $in: employeeIds } }).select("_id").lean()).map(
    meeting => meeting._id
  );
  const projectIds = (await Project.find({ createdBy: { $in: employeeIds } }).select("_id").lean()).map(
    project => project._id
  );

  await BreakLog.deleteMany({
    $or: [{ userId: { $in: employeeIds } }, { timeEntryId: { $in: timeEntryIds } }],
  });
  await OvertimeEntry.deleteMany({
    $or: [{ userId: { $in: employeeIds } }, { projectId: { $in: projectIds } }],
  });
  await WorkSession.deleteMany({ userId: { $in: employeeIds } });
  await TimeEntry.deleteMany({ userId: { $in: employeeIds } });
  await LeaveApplication.deleteMany({
    $or: [{ userId: { $in: employeeIds } }, { approvedBy: { $in: employeeIds } }],
  });
  await FormSubmission.deleteMany({
    $or: [{ userId: { $in: employeeIds } }, { respondedBy: { $in: employeeIds } }],
  });
  await ChatMessage.deleteMany({
    $or: [{ senderId: { $in: employeeIds } }, { recipientId: { $in: employeeIds } }],
  });
  await Note.deleteMany({ userId: { $in: employeeIds } });
  await Payslip.deleteMany({ userId: { $in: employeeIds } });
  await Notification.deleteMany({ userId: { $in: employeeIds } });
  await AnnouncementRead.deleteMany({ userId: { $in: employeeIds } });
  await EmployeeProfile.deleteMany({ userId: { $in: employeeIds } });
  await EmploymentDetail.deleteMany({
    $or: [{ userId: { $in: employeeIds } }, { supervisorId: { $in: employeeIds } }],
  });
  await JobHistory.deleteMany({ userId: { $in: employeeIds } });
  await Compensation.deleteMany({ userId: { $in: employeeIds } });
  await PerformanceRecord.deleteMany({
    $or: [{ userId: { $in: employeeIds } }, { reviewerId: { $in: employeeIds } }],
  });
  await Qualification.deleteMany({ userId: { $in: employeeIds } });
  await EmployeeDocument.deleteMany({
    $or: [{ userId: { $in: employeeIds } }, { uploadedBy: { $in: employeeIds } }],
  });
  await ComplianceRecord.deleteMany({ userId: { $in: employeeIds } });
  await EmployeeAuditLog.deleteMany({
    $or: [{ userId: { $in: employeeIds } }, { changedBy: { $in: employeeIds } }],
  });
  await CalendarEvent.deleteMany({ userId: { $in: employeeIds } });
  await MeetingParticipant.deleteMany({
    $or: [{ userId: { $in: employeeIds } }, { meetingId: { $in: meetingIds } }],
  });
  await Meeting.deleteMany({ organizerId: { $in: employeeIds } });
  await ProjectTask.deleteMany({
    $or: [
      { userId: { $in: employeeIds } },
      { assigneeIds: { $in: employeeIds } },
      { projectId: { $in: projectIds } },
    ],
  });
  await ProjectAssignment.deleteMany({
    $or: [{ userId: { $in: employeeIds } }, { projectId: { $in: projectIds } }],
  });
  await Project.deleteMany({ createdBy: { $in: employeeIds } });
  await User.deleteMany({ _id: { $in: employeeIds } });
}

async function seedEmployees() {
  const createdUsers: Array<{
    name: string;
    employeeId: string;
    password: string;
  }> = [];

  for (const employee of employeeSeeds) {
    const passwordHash = await bcrypt.hash(employee.password, 10);
    const created = await User.create({
      openId: employee.openId,
      name: employee.name,
      email: employee.email,
      loginMethod: "custom",
      role: "user",
      employeeId: employee.employeeId,
      password: passwordHash,
      department: employee.department,
      position: employee.position,
      lastSignedIn: new Date(0),
    });

    await EmployeeProfile.create({
      userId: created._id,
      cnic: employee.cnic,
      personalEmail: employee.email,
      mobilePhone: employee.mobilePhone,
    });

    await EmploymentDetail.create({
      userId: created._id,
      jobTitle: employee.position,
      department: employee.department,
      employmentStatus: "full_time",
      weeklyHours: 40,
      joinedDate: new Date(),
    });

    createdUsers.push({
      name: employee.name,
      employeeId: employee.employeeId,
      password: employee.password,
    });
  }

  return createdUsers;
}

async function run() {
  const connected = await connectToMongoDB();
  if (!connected) {
    console.error("[Seed] MongoDB not connected. Check MONGODB_URI.");
    process.exit(1);
  }

  await ensureAdminUser();
  await purgeNonAdminData();
  const createdUsers = await seedEmployees();

  console.log("[Seed] Employee data seeded successfully.");
  console.log("[Seed] Credentials:");
  createdUsers.forEach(user => {
    console.log(`- ${user.name} | Login: ${user.employeeId} | Password: ${user.password}`);
  });
  await mongoose.connection.close();
}

run().catch(error => {
  console.error("[Seed] Failed:", error);
  process.exit(1);
});
