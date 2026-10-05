/**
 * Collections added for the Now workspace screens: employee requests that had
 * no home before (attendance corrections and support tickets), and Wingman's
 * in-portal chat and per-person settings.
 *
 * Kept apart from models.ts so the older collections are untouched.
 */
import { Schema, model, Document, Types } from 'mongoose';

// ==================== Employee Request ====================
export type EmployeeRequestKind = 'attendance_correction' | 'support_ticket';
export type EmployeeRequestStatus = 'pending' | 'approved' | 'rejected' | 'resolved';

export interface IEmployeeRequest extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  kind: EmployeeRequestKind;
  subject: string;
  details?: string;
  /** Attendance corrections: the working day being corrected. */
  workDate?: Date;
  /** Attendance corrections: the times the person says are right. */
  requestedTimeIn?: Date;
  requestedTimeOut?: Date;
  /** Support tickets: what kind of problem it is. */
  category?: 'it' | 'equipment' | 'portal' | 'other';
  status: EmployeeRequestStatus;
  /** Who it was sent to when it was raised, same routing as leave. */
  approverUserId?: Types.ObjectId;
  reviewedBy?: Types.ObjectId;
  reviewedAt?: Date;
  reviewNote?: string;
  /** True once an approved correction was written onto the attendance record. */
  appliedToAttendance?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const employeeRequestSchema = new Schema<IEmployeeRequest>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  kind: { type: String, enum: ['attendance_correction', 'support_ticket'], required: true },
  subject: { type: String, required: true },
  details: String,
  workDate: Date,
  requestedTimeIn: Date,
  requestedTimeOut: Date,
  category: { type: String, enum: ['it', 'equipment', 'portal', 'other'] },
  status: { type: String, enum: ['pending', 'approved', 'rejected', 'resolved'], default: 'pending', required: true },
  approverUserId: { type: Schema.Types.ObjectId, ref: 'User', index: true },
  reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  reviewedAt: Date,
  reviewNote: String,
  appliedToAttendance: { type: Boolean, default: false },
}, { timestamps: true });

export const EmployeeRequest = model<IEmployeeRequest>('EmployeeRequest', employeeRequestSchema);

// ==================== Wingman Settings ====================
export interface IWingmanSettings extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  askBeforeSending: boolean;
  morningBrief: boolean;
  clockOutReminder: boolean;
  whatsapp: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const wingmanSettingsSchema = new Schema<IWingmanSettings>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  askBeforeSending: { type: Boolean, default: true },
  morningBrief: { type: Boolean, default: true },
  clockOutReminder: { type: Boolean, default: true },
  whatsapp: { type: Boolean, default: false },
}, { timestamps: true });

export const WingmanSettings = model<IWingmanSettings>('WingmanSettings', wingmanSettingsSchema);

// ==================== Wingman Message ====================
export interface IWingmanMessage extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  role: 'user' | 'wingman';
  text: string;
  /** Short rows shown under the text, e.g. tasks or meetings. */
  items?: { label: string; meta?: string; tone?: 'plain' | 'warn' | 'muted' }[];
  /** A page in the portal the answer points to. */
  link?: { label: string; href: string };
  /**
   * Something Wingman has prepared but not sent. It stays "ready" until the
   * person confirms it, so nothing reaches HR on a misread sentence.
   */
  action?: {
    kind: 'leave' | 'support_ticket';
    title: string;
    detail: string;
    payload: Record<string, unknown>;
    status: 'ready' | 'sent' | 'cancelled';
  };
  createdAt: Date;
}

const wingmanMessageSchema = new Schema<IWingmanMessage>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  role: { type: String, enum: ['user', 'wingman'], required: true },
  text: { type: String, required: true },
  items: [{ label: String, meta: String, tone: String, _id: false }],
  link: { label: String, href: String },
  action: {
    kind: { type: String, enum: ['leave', 'support_ticket'] },
    title: String,
    detail: String,
    payload: Schema.Types.Mixed,
    status: { type: String, enum: ['ready', 'sent', 'cancelled'] },
  },
  createdAt: { type: Date, default: Date.now },
});

export const WingmanMessage = model<IWingmanMessage>('WingmanMessage', wingmanMessageSchema);
