import { Schema, model, Document, Types } from 'mongoose';

// ==================== User Model ====================
export interface IUser extends Document {
  _id: Types.ObjectId;
  openId: string;
  name?: string;
  email?: string;
  loginMethod?: string;
  role: 'user' | 'admin';
  employeeId?: string;
  password?: string;
  twoFactorEnabled?: boolean;
  twoFactorSecret?: string;
  avatar?: string;
  department?: string;
  position?: string;
  createdAt: Date;
  updatedAt: Date;
  lastSignedIn: Date;
}

const userSchema = new Schema<IUser>({
  openId: { type: String, required: true, unique: true },
  name: String,
  email: String,
  loginMethod: String,
  role: { type: String, enum: ['user', 'admin'], default: 'user', required: true },
  employeeId: { type: String, unique: true, sparse: true },
  password: String,
  twoFactorEnabled: { type: Boolean, default: false },
  twoFactorSecret: String,
  avatar: String,
  department: String,
  position: String,
  lastSignedIn: { type: Date, default: Date.now },
}, { timestamps: true });

export const User = model<IUser>('User', userSchema);

// ==================== Time Entry Model ====================
export interface ITimeEntry extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  timeIn: Date;
  timeOut?: Date;
  totalHours?: number;
  status: 'active' | 'completed' | 'early_out';
  notes?: string;
  location?: {
    lat: number;
    lng: number;
    accuracy?: number;
    address?: string;
    source?: 'gps' | 'manual';
    capturedAt?: Date;
  };
  createdAt: Date;
  updatedAt: Date;
}

const timeEntrySchema = new Schema<ITimeEntry>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  timeIn: { type: Date, required: true },
  timeOut: Date,
  totalHours: Number,
  status: { type: String, enum: ['active', 'completed', 'early_out'], default: 'active', required: true },
  notes: String,
  location: {
    lat: Number,
    lng: Number,
    accuracy: Number,
    address: String,
    source: { type: String, enum: ['gps', 'manual'] },
    capturedAt: Date,
  },
}, { timestamps: true });

export const TimeEntry = model<ITimeEntry>('TimeEntry', timeEntrySchema);

// ==================== Work Session Model ====================
export interface IWorkSession extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  sessionDate: Date;
  startTime: Date;
  endTime: Date;
  totalHours: number;
  sessionType: 'remote' | 'onsite';
  description?: string;
  createdAt: Date;
  updatedAt: Date;
}

const workSessionSchema = new Schema<IWorkSession>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  sessionDate: { type: Date, required: true },
  startTime: { type: Date, required: true },
  endTime: { type: Date, required: true },
  totalHours: { type: Number, required: true },
  sessionType: { type: String, enum: ['remote', 'onsite'], default: 'remote', required: true },
  description: String,
}, { timestamps: true });

export const WorkSession = model<IWorkSession>('WorkSession', workSessionSchema);

// ==================== Overtime Entry Model ====================
export interface IOvertimeEntry extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  projectId: Types.ObjectId;
  taskId: Types.ObjectId;
  workDate: Date;
  hours: number;
  description?: string;
  createdAt: Date;
  updatedAt: Date;
}

const overtimeEntrySchema = new Schema<IOvertimeEntry>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
  taskId: { type: Schema.Types.ObjectId, ref: 'ProjectTask', required: true },
  workDate: { type: Date, required: true },
  hours: { type: Number, required: true },
  description: String,
}, { timestamps: true });

export const OvertimeEntry = model<IOvertimeEntry>('OvertimeEntry', overtimeEntrySchema);

// ==================== Break Log Model ====================
export interface IBreakLog extends Document {
  _id: Types.ObjectId;
  timeEntryId: Types.ObjectId;
  userId: Types.ObjectId;
  breakStart: Date;
  reason?: string;
  breakEnd?: Date;
  duration?: number;
  createdAt: Date;
}

const breakLogSchema = new Schema<IBreakLog>({
  timeEntryId: { type: Schema.Types.ObjectId, ref: 'TimeEntry', required: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  breakStart: { type: Date, required: true },
  reason: String,
  breakEnd: Date,
  duration: Number,
  createdAt: { type: Date, default: Date.now },
});

export const BreakLog = model<IBreakLog>('BreakLog', breakLogSchema);

// ==================== Leave Application Model ====================
export interface ILeaveApplication extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  leaveType: 'sick' | 'casual' | 'annual' | 'unpaid' | 'other';
  startDate: Date;
  endDate: Date;
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  approvedBy?: Types.ObjectId;
  approvedAt?: Date;
  rejectionReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

const leaveApplicationSchema = new Schema<ILeaveApplication>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  leaveType: { type: String, enum: ['sick', 'casual', 'annual', 'unpaid', 'other'], required: true },
  startDate: { type: Date, required: true },
  endDate: { type: Date, required: true },
  reason: { type: String, required: true },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', required: true },
  approvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  approvedAt: Date,
  rejectionReason: String,
}, { timestamps: true });

export const LeaveApplication = model<ILeaveApplication>('LeaveApplication', leaveApplicationSchema);

// ==================== Form Submission Model ====================
export interface IFormSubmission extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  formType: 'resignation' | 'leave' | 'grievance' | 'feedback';
  subject: string;
  content: string;
  status: 'submitted' | 'under_review' | 'resolved' | 'closed';
  priority?: 'low' | 'medium' | 'high';
  respondedBy?: Types.ObjectId;
  response?: string;
  createdAt: Date;
  updatedAt: Date;
}

const formSubmissionSchema = new Schema<IFormSubmission>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  formType: { type: String, enum: ['resignation', 'leave', 'grievance', 'feedback'], required: true },
  subject: { type: String, required: true },
  content: { type: String, required: true },
  status: { type: String, enum: ['submitted', 'under_review', 'resolved', 'closed'], default: 'submitted', required: true },
  priority: { type: String, enum: ['low', 'medium', 'high'], default: 'medium' },
  respondedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  response: String,
}, { timestamps: true });

export const FormSubmission = model<IFormSubmission>('FormSubmission', formSubmissionSchema);

// ==================== Chat Message Model ====================
export interface IChatMessage extends Document {
  _id: Types.ObjectId;
  senderId: Types.ObjectId;
  recipientId?: Types.ObjectId;
  message: string;
  isRead: boolean;
  createdAt: Date;
}

const chatMessageSchema = new Schema<IChatMessage>({
  senderId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  recipientId: { type: Schema.Types.ObjectId, ref: 'User' },
  message: { type: String, required: true },
  isRead: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
});

export const ChatMessage = model<IChatMessage>('ChatMessage', chatMessageSchema);

// ==================== Note Model ====================
export interface INote extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  title: string;
  content: string;
  createdAt: Date;
  updatedAt: Date;
}

const noteSchema = new Schema<INote>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  title: { type: String, required: true },
  content: { type: String, default: "" },
}, { timestamps: true });

export const Note = model<INote>('Note', noteSchema);

// ==================== Payslip Model ====================
export interface IPayslip extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  month: number;
  year: number;
  basicSalary: number;
  allowances: number;
  deductions: number;
  netSalary: number;
  workingDays: number;
  presentDays: number;
  paidAt?: Date;
  createdAt: Date;
}

const payslipSchema = new Schema<IPayslip>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  month: { type: Number, required: true, min: 1, max: 12 },
  year: { type: Number, required: true },
  basicSalary: { type: Number, required: true },
  allowances: { type: Number, default: 0 },
  deductions: { type: Number, default: 0 },
  netSalary: { type: Number, required: true },
  workingDays: { type: Number, required: true },
  presentDays: { type: Number, required: true },
  paidAt: Date,
  createdAt: { type: Date, default: Date.now },
});

export const Payslip = model<IPayslip>('Payslip', payslipSchema);

// ==================== Announcement Model ====================
export interface IAnnouncement extends Document {
  _id: Types.ObjectId;
  title: string;
  content: string;
  priority: 'low' | 'medium' | 'high';
  isActive: boolean;
  createdBy: Types.ObjectId;
  expiresAt?: Date;
  createdAt: Date;
}

const announcementSchema = new Schema<IAnnouncement>({
  title: { type: String, required: true },
  content: { type: String, required: true },
  priority: { type: String, enum: ['low', 'medium', 'high'], default: 'medium', required: true },
  isActive: { type: Boolean, default: true },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  expiresAt: Date,
  createdAt: { type: Date, default: Date.now },
});

export const Announcement = model<IAnnouncement>('Announcement', announcementSchema);

// ==================== Project Model ====================
export interface IProject extends Document {
  _id: Types.ObjectId;
  name: string;
  description?: string;
  status: 'active' | 'on_hold' | 'completed' | 'cancelled';
  priority: 'low' | 'medium' | 'high';
  source: 'team_lead' | 'employee';
  startDate?: Date;
  endDate?: Date;
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const projectSchema = new Schema<IProject>({
  name: { type: String, required: true },
  description: String,
  status: { type: String, enum: ['active', 'on_hold', 'completed', 'cancelled'], default: 'active', required: true },
  priority: { type: String, enum: ['low', 'medium', 'high'], default: 'medium', required: true },
  source: { type: String, enum: ['team_lead', 'employee'], default: 'team_lead', required: true },
  startDate: Date,
  endDate: Date,
  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });

export const Project = model<IProject>('Project', projectSchema);

// ==================== Project Assignment Model ====================
export interface IProjectAssignment extends Document {
  _id: Types.ObjectId;
  projectId: Types.ObjectId;
  userId: Types.ObjectId;
  role?: string;
  assignedAt: Date;
}

const projectAssignmentSchema = new Schema<IProjectAssignment>({
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  role: String,
  assignedAt: { type: Date, default: Date.now },
});

export const ProjectAssignment = model<IProjectAssignment>('ProjectAssignment', projectAssignmentSchema);

// ==================== Project Task Model ====================
export interface IProjectTask extends Document {
  _id: Types.ObjectId;
  projectId: Types.ObjectId;
  userId: Types.ObjectId;
  assigneeIds?: Types.ObjectId[];
  timeEntryId?: Types.ObjectId;
  title: string;
  description?: string;
  status: 'todo' | 'in_progress' | 'completed' | 'blocked';
  priority: 'low' | 'medium' | 'high';
  completionDate?: Date;
  completedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const projectTaskSchema = new Schema<IProjectTask>({
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  assigneeIds: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  timeEntryId: { type: Schema.Types.ObjectId, ref: 'TimeEntry' },
  title: { type: String, required: true },
  description: String,
  status: { type: String, enum: ['todo', 'in_progress', 'completed', 'blocked'], default: 'todo', required: true },
  priority: { type: String, enum: ['low', 'medium', 'high'], default: 'medium', required: true },
  completionDate: Date,
  completedAt: Date,
}, { timestamps: true });

export const ProjectTask = model<IProjectTask>('ProjectTask', projectTaskSchema);

// ==================== Notification Model ====================
export interface INotification extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  type: 'project_assigned' | 'attendance_issue' | 'hours_shortfall' | 'leave_approved' | 'leave_rejected' | 'announcement' | 'system_alert';
  title: string;
  message: string;
  priority: 'low' | 'medium' | 'high';
  isRead: boolean;
  relatedId?: Types.ObjectId;
  relatedType?: string;
  createdAt: Date;
}

const notificationSchema = new Schema<INotification>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  type: { 
    type: String, 
    enum: ['project_assigned', 'attendance_issue', 'hours_shortfall', 'leave_approved', 'leave_rejected', 'announcement', 'system_alert'], 
    required: true 
  },
  title: { type: String, required: true },
  message: { type: String, required: true },
  priority: { type: String, enum: ['low', 'medium', 'high'], default: 'medium', required: true },
  isRead: { type: Boolean, default: false },
  relatedId: Schema.Types.ObjectId,
  relatedType: String,
  createdAt: { type: Date, default: Date.now },
});

export const Notification = model<INotification>('Notification', notificationSchema);

// ==================== Announcement Read Model ====================
export interface IAnnouncementRead extends Document {
  _id: Types.ObjectId;
  announcementId: Types.ObjectId;
  userId: Types.ObjectId;
  readAt: Date;
}

const announcementReadSchema = new Schema<IAnnouncementRead>({
  announcementId: { type: Schema.Types.ObjectId, ref: 'Announcement', required: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  readAt: { type: Date, default: Date.now },
});

export const AnnouncementRead = model<IAnnouncementRead>('AnnouncementRead', announcementReadSchema);

// Continue in next part...

// ==================== Employee Profile Model ====================
export interface IEmployeeProfile extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  dateOfBirth?: Date;
  gender?: 'male' | 'female' | 'other';
  maritalStatus?: 'single' | 'married' | 'divorced' | 'widowed';
  nationality?: string;
  personalEmail?: string;
  homePhone?: string;
  mobilePhone?: string;
  currentAddress?: string;
  permanentAddress?: string;
  emergencyContactName?: string;
  emergencyContactRelationship?: string;
  emergencyContactPhone?: string;
  profileImageUrl?: string;
  createdAt: Date;
  updatedAt: Date;
}

const employeeProfileSchema = new Schema<IEmployeeProfile>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  dateOfBirth: Date,
  gender: { type: String, enum: ['male', 'female', 'other'] },
  maritalStatus: { type: String, enum: ['single', 'married', 'divorced', 'widowed'] },
  nationality: String,
  personalEmail: String,
  homePhone: String,
  mobilePhone: String,
  currentAddress: String,
  permanentAddress: String,
  emergencyContactName: String,
  emergencyContactRelationship: String,
  emergencyContactPhone: String,
  profileImageUrl: String,
}, { timestamps: true });

export const EmployeeProfile = model<IEmployeeProfile>('EmployeeProfile', employeeProfileSchema);

// ==================== Employment Detail Model ====================
export interface IEmploymentDetail extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  jobTitle?: string;
  department?: string;
  subUnit?: string;
  employmentStatus?: 'full_time' | 'part_time' | 'contract' | 'intern';
  supervisorId?: Types.ObjectId;
  teamStructure?: string;
  joinedDate?: Date;
  probationEndDate?: Date;
  contractEndDate?: Date;
  workLocation?: string;
  shift?: string;
  weeklyHours?: number;
  createdAt: Date;
  updatedAt: Date;
}

const employmentDetailSchema = new Schema<IEmploymentDetail>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  jobTitle: String,
  department: String,
  subUnit: String,
  employmentStatus: { type: String, enum: ['full_time', 'part_time', 'contract', 'intern'], default: 'full_time' },
  supervisorId: { type: Schema.Types.ObjectId, ref: 'User' },
  teamStructure: String,
  joinedDate: Date,
  probationEndDate: Date,
  contractEndDate: Date,
  workLocation: String,
  shift: String,
  weeklyHours: { type: Number, default: 40 },
}, { timestamps: true });

export const EmploymentDetail = model<IEmploymentDetail>('EmploymentDetail', employmentDetailSchema);

// ==================== Job History Model ====================
export interface IJobHistory extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  previousTitle?: string;
  newTitle?: string;
  previousDepartment?: string;
  newDepartment?: string;
  changeType?: 'promotion' | 'transfer' | 'demotion' | 'role_change';
  effectiveDate: Date;
  notes?: string;
  createdAt: Date;
}

const jobHistorySchema = new Schema<IJobHistory>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  previousTitle: String,
  newTitle: String,
  previousDepartment: String,
  newDepartment: String,
  changeType: { type: String, enum: ['promotion', 'transfer', 'demotion', 'role_change'] },
  effectiveDate: { type: Date, required: true },
  notes: String,
  createdAt: { type: Date, default: Date.now },
});

export const JobHistory = model<IJobHistory>('JobHistory', jobHistorySchema);

// ==================== Compensation Model ====================
export interface ICompensation extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  annualSalary?: number;
  monthlySalary?: number;
  payFrequency?: 'monthly' | 'bi_weekly' | 'weekly';
  basicPay?: number;
  conveyanceAllowance?: number;
  medicalAllowance?: number;
  housingAllowance?: number;
  otherAllowances?: number;
  bankName?: string;
  accountNumber?: string;
  routingNumber?: string;
  swiftCode?: string;
  taxId?: string;
  taxDeclarations?: string;
  withholdingDetails?: string;
  healthInsurance?: string;
  retirementPlan?: string;
  otherBenefits?: string;
  effectiveDate?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const compensationSchema = new Schema<ICompensation>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  annualSalary: Number,
  monthlySalary: Number,
  payFrequency: { type: String, enum: ['monthly', 'bi_weekly', 'weekly'], default: 'monthly' },
  basicPay: Number,
  conveyanceAllowance: Number,
  medicalAllowance: Number,
  housingAllowance: Number,
  otherAllowances: Number,
  bankName: String,
  accountNumber: String,
  routingNumber: String,
  swiftCode: String,
  taxId: String,
  taxDeclarations: String,
  withholdingDetails: String,
  healthInsurance: String,
  retirementPlan: String,
  otherBenefits: String,
  effectiveDate: Date,
}, { timestamps: true });

export const Compensation = model<ICompensation>('Compensation', compensationSchema);

// ==================== Performance Record Model ====================
export interface IPerformanceRecord extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  reviewDate: Date;
  reviewPeriod?: string;
  rating?: number;
  goals?: string;
  achievements?: string;
  feedback?: string;
  reviewerId?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const performanceRecordSchema = new Schema<IPerformanceRecord>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  reviewDate: { type: Date, required: true },
  reviewPeriod: String,
  rating: Number,
  goals: String,
  achievements: String,
  feedback: String,
  reviewerId: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

export const PerformanceRecord = model<IPerformanceRecord>('PerformanceRecord', performanceRecordSchema);

// ==================== Qualification Model ====================
export interface IQualification extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  type: 'education' | 'certification' | 'training' | 'skill' | 'language';
  title: string;
  institution?: string;
  completionDate?: Date;
  expiryDate?: Date;
  level?: string;
  documentUrl?: string;
  createdAt: Date;
}

const qualificationSchema = new Schema<IQualification>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  type: { type: String, enum: ['education', 'certification', 'training', 'skill', 'language'], required: true },
  title: { type: String, required: true },
  institution: String,
  completionDate: Date,
  expiryDate: Date,
  level: String,
  documentUrl: String,
  createdAt: { type: Date, default: Date.now },
});

export const Qualification = model<IQualification>('Qualification', qualificationSchema);

// ==================== Employee Document Model ====================
export interface IEmployeeDocument extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  documentType: 'offer_letter' | 'contract' | 'id_proof' | 'id_proof_front' | 'id_proof_back' | 'policy_acknowledgment' | 'other';
  title: string;
  documentUrl: string;
  uploadedBy: Types.ObjectId;
  createdAt: Date;
}

const employeeDocumentSchema = new Schema<IEmployeeDocument>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  documentType: { type: String, enum: ['offer_letter', 'contract', 'id_proof', 'id_proof_front', 'id_proof_back', 'policy_acknowledgment', 'other'], required: true },
  title: { type: String, required: true },
  documentUrl: { type: String, required: true },
  uploadedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  createdAt: { type: Date, default: Date.now },
});

export const EmployeeDocument = model<IEmployeeDocument>('EmployeeDocument', employeeDocumentSchema);

// ==================== Compliance Record Model ====================
export interface IComplianceRecord extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  backgroundCheckStatus?: 'pending' | 'in_progress' | 'completed' | 'failed';
  backgroundCheckDate?: Date;
  backgroundCheckNotes?: string;
  workPermitNumber?: string;
  workPermitExpiryDate?: Date;
  visaNumber?: string;
  visaExpiryDate?: Date;
  visaType?: string;
  createdAt: Date;
  updatedAt: Date;
}

const complianceRecordSchema = new Schema<IComplianceRecord>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  backgroundCheckStatus: { type: String, enum: ['pending', 'in_progress', 'completed', 'failed'] },
  backgroundCheckDate: Date,
  backgroundCheckNotes: String,
  workPermitNumber: String,
  workPermitExpiryDate: Date,
  visaNumber: String,
  visaExpiryDate: Date,
  visaType: String,
}, { timestamps: true });

export const ComplianceRecord = model<IComplianceRecord>('ComplianceRecord', complianceRecordSchema);

// ==================== Employee Audit Log Model ====================
export interface IEmployeeAuditLog extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  changedBy: Types.ObjectId;
  tableName: string;
  fieldName: string;
  oldValue?: string;
  newValue?: string;
  changeReason?: string;
  createdAt: Date;
}

const employeeAuditLogSchema = new Schema<IEmployeeAuditLog>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  changedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  tableName: { type: String, required: true },
  fieldName: { type: String, required: true },
  oldValue: String,
  newValue: String,
  changeReason: String,
  createdAt: { type: Date, default: Date.now },
});

export const EmployeeAuditLog = model<IEmployeeAuditLog>('EmployeeAuditLog', employeeAuditLogSchema);

// ==================== Meeting Model ====================
export interface IMeeting extends Document {
  _id: Types.ObjectId;
  title: string;
  description?: string;
  agenda?: string;
  startTime: Date;
  endTime: Date;
  location?: string;
  meetingLink?: string;
  organizerId: Types.ObjectId;
  status: 'scheduled' | 'in_progress' | 'completed' | 'cancelled';
  meetingMinutes?: string;
  actionItems?: string;
  createdAt: Date;
  updatedAt: Date;
}

const meetingSchema = new Schema<IMeeting>({
  title: { type: String, required: true },
  description: String,
  agenda: String,
  startTime: { type: Date, required: true },
  endTime: { type: Date, required: true },
  location: String,
  meetingLink: String,
  organizerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  status: { type: String, enum: ['scheduled', 'in_progress', 'completed', 'cancelled'], default: 'scheduled', required: true },
  meetingMinutes: String,
  actionItems: String,
}, { timestamps: true });

export const Meeting = model<IMeeting>('Meeting', meetingSchema);

// ==================== Meeting Participant Model ====================
export interface IMeetingParticipant extends Document {
  _id: Types.ObjectId;
  meetingId: Types.ObjectId;
  userId: Types.ObjectId;
  responseStatus: 'pending' | 'accepted' | 'declined' | 'tentative';
  createdAt: Date;
  updatedAt: Date;
}

const meetingParticipantSchema = new Schema<IMeetingParticipant>({
  meetingId: { type: Schema.Types.ObjectId, ref: 'Meeting', required: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  responseStatus: { type: String, enum: ['pending', 'accepted', 'declined', 'tentative'], default: 'pending', required: true },
}, { timestamps: true });

export const MeetingParticipant = model<IMeetingParticipant>('MeetingParticipant', meetingParticipantSchema);

// ==================== Meeting Minutes Model ====================
export interface IMeetingMinutes extends Document {
  _id: Types.ObjectId;
  meetingId: Types.ObjectId;
  summary: string;
  discussion?: string;
  decisions?: string;
  createdById: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const meetingMinutesSchema = new Schema<IMeetingMinutes>({
  meetingId: { type: Schema.Types.ObjectId, ref: 'Meeting', required: true, unique: true },
  summary: { type: String, required: true },
  discussion: String,
  decisions: String,
  createdById: { type: Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });

export const MeetingMinutes = model<IMeetingMinutes>('MeetingMinutes', meetingMinutesSchema);

// ==================== Action Item Model ====================
export interface IActionItem extends Document {
  _id: Types.ObjectId;
  meetingId: Types.ObjectId;
  title: string;
  description?: string;
  assignedToId: Types.ObjectId;
  dueDate?: Date;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  priority: 'low' | 'medium' | 'high';
  createdAt: Date;
  updatedAt: Date;
}

const actionItemSchema = new Schema<IActionItem>({
  meetingId: { type: Schema.Types.ObjectId, ref: 'Meeting', required: true },
  title: { type: String, required: true },
  description: String,
  assignedToId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  dueDate: Date,
  status: { type: String, enum: ['pending', 'in_progress', 'completed', 'cancelled'], default: 'pending', required: true },
  priority: { type: String, enum: ['low', 'medium', 'high'], default: 'medium', required: true },
}, { timestamps: true });

export const ActionItem = model<IActionItem>('ActionItem', actionItemSchema);

// ==================== Calendar Event Model ====================
export interface ICalendarEvent extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  title: string;
  description?: string;
  eventType: 'reminder' | 'personal' | 'deadline' | 'holiday';
  startTime: Date;
  endTime?: Date;
  isAllDay: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const calendarEventSchema = new Schema<ICalendarEvent>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  title: { type: String, required: true },
  description: String,
  eventType: { type: String, enum: ['reminder', 'personal', 'deadline', 'holiday'], required: true },
  startTime: { type: Date, required: true },
  endTime: Date,
  isAllDay: { type: Boolean, default: false },
}, { timestamps: true });

export const CalendarEvent = model<ICalendarEvent>('CalendarEvent', calendarEventSchema);
