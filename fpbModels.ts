/**
 * Flow Project Board (Kanban) models.
 *
 * Ported from the Manus reference build, which used Drizzle/MySQL with integer
 * primary keys. Here everything is Mongoose with ObjectIds, so every id that
 * crosses the API is a string.
 *
 * Deliberately namespaced (Fpb*) and kept apart from the legacy
 * Project/ProjectTask models, which remain in use by the dashboard, reports and
 * the clock-out flow.
 */
import { Schema, model, Document, Types } from "mongoose";

export type FpbProjectType = "dev" | "lead" | "management" | "accounting" | "other";
export type FpbPriority = "low" | "medium" | "high" | "urgent";
export type FpbWorkStatus = "todo" | "in_progress" | "in_review" | "blocked" | "done";

const PRIORITIES: FpbPriority[] = ["low", "medium", "high", "urgent"];
const WORK_STATUSES: FpbWorkStatus[] = ["todo", "in_progress", "in_review", "blocked", "done"];

// ==================== Column ====================
// A project owns its own columns, the way a Jira board belongs to one space.
// Teams run different processes, so one project's board can read
// Open / Dev / Testing while another reads Marketing / Design / Review.
export interface IFpbColumn extends Document {
  _id: Types.ObjectId;
  projectId: Types.ObjectId;
  name: string;
  color: string;
  position: number;
  createdAt: Date;
  updatedAt: Date;
}

const fpbColumnSchema = new Schema<IFpbColumn>(
  {
    projectId: { type: Schema.Types.ObjectId, ref: "FpbProject", required: true },
    name: { type: String, required: true },
    color: { type: String, default: "#6366f1" },
    position: { type: Number, default: 0, required: true },
  },
  { timestamps: true }
);
fpbColumnSchema.index({ projectId: 1, position: 1 });

export const FpbColumn = model<IFpbColumn>("FpbColumn", fpbColumnSchema);

// ==================== Project (a workspace, not a card) ====================
export interface IFpbProject extends Document {
  _id: Types.ObjectId;
  title: string;
  description?: string;
  projectType: FpbProjectType;
  priority: FpbPriority;
  status: "active" | "on_hold" | "completed" | "archived";
  dueDate?: Date;
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const fpbProjectSchema = new Schema<IFpbProject>(
  {
    title: { type: String, required: true },
    description: String,
    projectType: {
      type: String,
      enum: ["dev", "lead", "management", "accounting", "other"],
      default: "other",
      required: true,
    },
    priority: { type: String, enum: PRIORITIES, default: "medium" },
    status: {
      type: String,
      enum: ["active", "on_hold", "completed", "archived"],
      default: "active",
    },
    dueDate: Date,
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);
fpbProjectSchema.index({ status: 1, createdAt: -1 });

export const FpbProject = model<IFpbProject>("FpbProject", fpbProjectSchema);

// ==================== Project members ====================
export interface IFpbProjectMember extends Document {
  _id: Types.ObjectId;
  projectId: Types.ObjectId;
  userId: Types.ObjectId;
  createdAt: Date;
}

const fpbProjectMemberSchema = new Schema<IFpbProjectMember>(
  {
    projectId: { type: Schema.Types.ObjectId, ref: "FpbProject", required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);
// One membership row per person per project; the reference relied on
// application-level checks for this and could double-insert on a race.
fpbProjectMemberSchema.index({ projectId: 1, userId: 1 }, { unique: true });

export const FpbProjectMember = model<IFpbProjectMember>(
  "FpbProjectMember",
  fpbProjectMemberSchema
);

// ==================== Task (the draggable card) ====================
export interface IFpbTask extends Document {
  _id: Types.ObjectId;
  projectId: Types.ObjectId;
  /** Which column of its project's board the card currently sits in. */
  columnId: Types.ObjectId;
  title: string;
  description?: string;
  completed: boolean;
  status: FpbWorkStatus;
  progress: number;
  priority: FpbPriority;
  dueDate?: Date;
  position: number;
  assignedTo?: Types.ObjectId;
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const fpbTaskSchema = new Schema<IFpbTask>(
  {
    projectId: { type: Schema.Types.ObjectId, ref: "FpbProject", required: true },
    columnId: { type: Schema.Types.ObjectId, ref: "FpbColumn", required: true },
    title: { type: String, required: true },
    description: String,
    completed: { type: Boolean, default: false, required: true },
    status: { type: String, enum: WORK_STATUSES, default: "todo", required: true },
    progress: { type: Number, default: 0, min: 0, max: 100, required: true },
    priority: { type: String, enum: PRIORITIES, default: "medium" },
    dueDate: Date,
    position: { type: Number, default: 0, required: true },
    assignedTo: { type: Schema.Types.ObjectId, ref: "User" },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);
fpbTaskSchema.index({ projectId: 1, columnId: 1, position: 1 });

export const FpbTask = model<IFpbTask>("FpbTask", fpbTaskSchema);

// ==================== Subtask ====================
export interface IFpbSubtask extends Document {
  _id: Types.ObjectId;
  taskId: Types.ObjectId;
  title: string;
  description?: string;
  completed: boolean;
  status: FpbWorkStatus;
  progress: number;
  position: number;
  assignedTo?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const fpbSubtaskSchema = new Schema<IFpbSubtask>(
  {
    taskId: { type: Schema.Types.ObjectId, ref: "FpbTask", required: true },
    title: { type: String, required: true },
    description: String,
    completed: { type: Boolean, default: false, required: true },
    status: { type: String, enum: WORK_STATUSES, default: "todo", required: true },
    progress: { type: Number, default: 0, min: 0, max: 100, required: true },
    position: { type: Number, default: 0, required: true },
    assignedTo: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);
fpbSubtaskSchema.index({ taskId: 1, position: 1 });

export const FpbSubtask = model<IFpbSubtask>("FpbSubtask", fpbSubtaskSchema);

// ==================== Task members ====================
export interface IFpbTaskMember extends Document {
  _id: Types.ObjectId;
  taskId: Types.ObjectId;
  userId: Types.ObjectId;
  createdAt: Date;
}

const fpbTaskMemberSchema = new Schema<IFpbTaskMember>(
  {
    taskId: { type: Schema.Types.ObjectId, ref: "FpbTask", required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);
fpbTaskMemberSchema.index({ taskId: 1, userId: 1 }, { unique: true });

export const FpbTaskMember = model<IFpbTaskMember>("FpbTaskMember", fpbTaskMemberSchema);

// ==================== Comments ====================
export interface IFpbTaskComment extends Document {
  _id: Types.ObjectId;
  taskId: Types.ObjectId;
  userId: Types.ObjectId;
  comment: string;
  createdAt: Date;
  updatedAt: Date;
}

const fpbTaskCommentSchema = new Schema<IFpbTaskComment>(
  {
    taskId: { type: Schema.Types.ObjectId, ref: "FpbTask", required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    comment: { type: String, required: true },
  },
  { timestamps: true }
);
fpbTaskCommentSchema.index({ taskId: 1, createdAt: 1 });

export const FpbTaskComment = model<IFpbTaskComment>("FpbTaskComment", fpbTaskCommentSchema);

export interface IFpbSubtaskComment extends Document {
  _id: Types.ObjectId;
  subtaskId: Types.ObjectId;
  userId: Types.ObjectId;
  comment: string;
  createdAt: Date;
  updatedAt: Date;
}

const fpbSubtaskCommentSchema = new Schema<IFpbSubtaskComment>(
  {
    subtaskId: { type: Schema.Types.ObjectId, ref: "FpbSubtask", required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    comment: { type: String, required: true },
  },
  { timestamps: true }
);
fpbSubtaskCommentSchema.index({ subtaskId: 1, createdAt: 1 });

export const FpbSubtaskComment = model<IFpbSubtaskComment>(
  "FpbSubtaskComment",
  fpbSubtaskCommentSchema
);

// ==================== Design annotations ====================
export interface IFpbAnnotation extends Document {
  _id: Types.ObjectId;
  projectId: Types.ObjectId;
  fileName: string;
  fileUrl: string;
  uploadedBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const fpbAnnotationSchema = new Schema<IFpbAnnotation>(
  {
    projectId: { type: Schema.Types.ObjectId, ref: "FpbProject", required: true },
    fileName: { type: String, required: true },
    fileUrl: { type: String, required: true },
    uploadedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);
fpbAnnotationSchema.index({ projectId: 1, createdAt: -1 });

export const FpbAnnotation = model<IFpbAnnotation>("FpbAnnotation", fpbAnnotationSchema);

export interface IFpbAnnotationComment extends Document {
  _id: Types.ObjectId;
  annotationId: Types.ObjectId;
  userId: Types.ObjectId;
  comment: string;
  /** Pin position as a percentage of the image, so it survives any resize. */
  posX: number;
  posY: number;
  resolved: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const fpbAnnotationCommentSchema = new Schema<IFpbAnnotationComment>(
  {
    annotationId: { type: Schema.Types.ObjectId, ref: "FpbAnnotation", required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    comment: { type: String, required: true },
    // The reference stored these as strings, which made them unsortable and
    // unfilterable; numbers are the honest type for a coordinate.
    posX: { type: Number, required: true },
    posY: { type: Number, required: true },
    resolved: { type: Boolean, default: false },
  },
  { timestamps: true }
);
fpbAnnotationCommentSchema.index({ annotationId: 1, createdAt: 1 });

export const FpbAnnotationComment = model<IFpbAnnotationComment>(
  "FpbAnnotationComment",
  fpbAnnotationCommentSchema
);

// ==================== Activity log ====================
export interface IFpbActivity extends Document {
  _id: Types.ObjectId;
  projectId: Types.ObjectId;
  userId: Types.ObjectId;
  action: string;
  detail?: string;
  createdAt: Date;
}

const fpbActivitySchema = new Schema<IFpbActivity>({
  projectId: { type: Schema.Types.ObjectId, ref: "FpbProject", required: true },
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  action: { type: String, required: true },
  detail: String,
  createdAt: { type: Date, default: Date.now },
});
fpbActivitySchema.index({ projectId: 1, createdAt: -1 });

export const FpbActivity = model<IFpbActivity>("FpbActivity", fpbActivitySchema);
