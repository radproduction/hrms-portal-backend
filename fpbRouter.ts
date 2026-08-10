/**
 * Flow Project Board API.
 *
 * Ported from the Manus reference, with two deliberate differences:
 *
 *  - Every id is a string (ObjectId), not an int.
 *  - Destructive and structural actions are gated. The reference exposed
 *    deleteColumn, deleteProject and updateProject to any signed-in user, so an
 *    employee could delete the whole board. Columns and project deletion are
 *    admin-only; project edits are limited to admins, the creator, or a member.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router } from "./_core/trpc";
import * as fpb from "./fpbDb";
import * as db from "./db";
import { emitNotification } from "./_core/realtime";
import { storagePut } from "./storage";

const PRIORITY = z.enum(["low", "medium", "high", "urgent"]);
const WORK_STATUS = z.enum(["todo", "in_progress", "in_review", "blocked", "done"]);
const PROJECT_TYPE = z.enum(["dev", "lead", "management", "accounting", "other"]);
const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, "Invalid id");

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

/**
 * Admins, the creator, or anyone on the project may see and edit it.
 *
 * Anyone can create a space now, so this is also the read gate: a space is
 * private to the people in it, and "adding" someone would mean nothing if
 * outsiders could open it anyway.
 */
async function requireProjectAccess(
  ctx: { user: { id: string; role?: string } },
  projectId: string
) {
  const project = await fpb.getProject(projectId);
  if (!project) throw new TRPCError({ code: "NOT_FOUND", message: "Project not found" });
  if (ctx.user.role === "admin") return project;
  const isCreator = String((project as any).createdBy) === ctx.user.id;
  const isMember = ((project as any).memberIds ?? []).includes(ctx.user.id);
  if (!isCreator && !isMember) {
    throw new TRPCError({ code: "FORBIDDEN", message: "You are not on this project" });
  }
  return project;
}

/**
 * Deleting a whole space is the owner's call, not every member's — otherwise
 * anyone you invited could destroy the space you made.
 */
async function requireProjectOwner(
  ctx: { user: { id: string; role?: string } },
  projectId: string
) {
  const project = await fpb.getProject(projectId);
  if (!project) throw new TRPCError({ code: "NOT_FOUND", message: "Project not found" });
  if (ctx.user.role === "admin") return project;
  if (String((project as any).createdBy) !== ctx.user.id) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Only the person who created this project, or an admin, can do that",
    });
  }
  return project;
}

/** Columns are gated by the project they belong to. */
async function requireColumnAccess(
  ctx: { user: { id: string; role?: string } },
  columnId: string
) {
  const projectId = await fpb.getColumnProjectId(columnId);
  if (!projectId) throw new TRPCError({ code: "NOT_FOUND", message: "Column not found" });
  await requireProjectAccess(ctx, projectId);
  return projectId;
}

/**
 * Board changes are only useful if the people affected hear about them, so
 * assignment and membership raise a notification and a realtime ping. Never
 * notify the person who performed the action.
 */
async function notify(
  userIds: string[],
  actorId: string,
  payload: { title: string; message: string; projectId: string }
) {
  const targets = [...new Set(userIds)].filter(id => id && id !== actorId);
  for (const userId of targets) {
    try {
      await db.createNotification({
        userId,
        type: "task_assigned",
        title: payload.title,
        message: payload.message,
        priority: "medium",
        relatedId: payload.projectId,
        relatedType: "fpb_project",
      });
      emitNotification({ userId });
    } catch (error) {
      // A failed notification must not roll back the work it describes.
      console.error("[FPB] failed to notify", userId, error);
    }
  }
}

async function projectIdForTask(taskId: string) {
  const found = await fpb.getTask(taskId);
  if (!found) throw new TRPCError({ code: "NOT_FOUND", message: "Task not found" });
  return String((found.task as any).projectId);
}

export const fpbRouter = router({
  // ==================== Board & columns ====================

  /** One project's board: its columns and the task cards sitting in them. */
  getBoard: protectedProcedure
    .input(z.object({ projectId: objectId }))
    .query(async ({ ctx, input }) => {
      const project = await requireProjectAccess(ctx, input.projectId);
      const [columns, tasks] = await Promise.all([
        fpb.getColumns(input.projectId),
        fpb.getTasks(input.projectId),
      ]);
      return { project, columns, tasks };
    }),

  createColumn: protectedProcedure
    .input(
      z.object({
        projectId: objectId,
        name: z.string().min(1).max(100),
        color: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireProjectAccess(ctx, input.projectId);
      return fpb.createColumn(input.projectId, input.name, input.color);
    }),

  updateColumn: protectedProcedure
    .input(
      z.object({
        id: objectId,
        name: z.string().min(1).max(100).optional(),
        color: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireColumnAccess(ctx, input.id);
      const { id, ...updates } = input;
      const saved = await fpb.updateColumn(id, updates);
      if (!saved) throw new TRPCError({ code: "NOT_FOUND", message: "Column not found" });
      return saved;
    }),

  deleteColumn: protectedProcedure
    .input(z.object({ id: objectId }))
    .mutation(async ({ ctx, input }) => {
      await requireColumnAccess(ctx, input.id);
      try {
        // Tasks move to the neighbouring column rather than being orphaned.
        return await fpb.deleteColumn(input.id);
      } catch (error) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: error instanceof Error ? error.message : "Could not delete column",
        });
      }
    }),

  reorderColumns: protectedProcedure
    .input(z.array(z.object({ id: objectId, position: z.number().int().min(0) })))
    .mutation(async ({ ctx, input }) => {
      for (const item of input) await requireColumnAccess(ctx, item.id);
      await fpb.reorderColumns(input);
      return { success: true };
    }),

  // ==================== Projects ====================

  getProjects: protectedProcedure
    .input(
      z
        .object({
          projectType: PROJECT_TYPE.optional(),
          status: z.enum(["active", "on_hold", "completed", "archived"]).optional(),
        })
        .optional()
    )
    .query(async ({ ctx, input }) =>
      // Admins see every space; everyone else sees their own and the ones
      // they were added to.
      fpb.getProjects({
        ...input,
        visibleTo: ctx.user.role === "admin" ? undefined : ctx.user.id,
      })
    ),

  getProject: protectedProcedure
    .input(z.object({ id: objectId }))
    .query(async ({ ctx, input }) => requireProjectAccess(ctx, input.id)),

  createProject: protectedProcedure
    .input(
      z.object({
        title: z.string().min(1).max(255),
        description: z.string().optional(),
        projectType: PROJECT_TYPE,
        priority: PRIORITY.optional(),
        dueDate: z.date().optional(),
        memberIds: z.array(objectId).optional(),
        // Optional custom workflow; omitted means the default five columns.
        columns: z
          .array(z.object({ name: z.string().min(1).max(100), color: z.string() }))
          .max(12)
          .optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Anyone can open a space of their own and invite whoever they need;
      // this is not an admin-only action.
      const project = await fpb.createProject({
        title: input.title,
        columns: input.columns,
        description: input.description,
        projectType: input.projectType,
        priority: input.priority,
        dueDate: input.dueDate,
        createdBy: ctx.user.id,
        memberIds: input.memberIds,
      });
      await fpb.logActivity(project.id!, ctx.user.id, "created project", input.title);

      await notify(input.memberIds ?? [], ctx.user.id, {
        title: "Added to a project",
        message: `You have been added to ${input.title}.`,
        projectId: project.id!,
      });
      return project;
    }),

  updateProject: protectedProcedure
    .input(
      z.object({
        id: objectId,
        title: z.string().min(1).max(255).optional(),
        description: z.string().optional(),
        projectType: PROJECT_TYPE.optional(),
        priority: PRIORITY.optional(),
        status: z.enum(["active", "on_hold", "completed", "archived"]).optional(),
        dueDate: z.date().nullable().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireProjectAccess(ctx, input.id);
      const { id, ...updates } = input;
      const saved = await fpb.updateProject(id, updates);
      await fpb.logActivity(id, ctx.user.id, "updated project");
      return saved;
    }),

  deleteProject: protectedProcedure
    .input(z.object({ id: objectId }))
    .mutation(async ({ ctx, input }) => {
      await requireProjectOwner(ctx, input.id);
      await fpb.deleteProject(input.id);
      return { success: true };
    }),

  /** Drag a task card between the columns of its project's board. */
  moveTask: protectedProcedure
    .input(
      z.object({
        id: objectId,
        columnId: objectId,
        position: z.number().int().min(0),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const projectId = await projectIdForTask(input.id);
      await requireProjectAccess(ctx, projectId);
      try {
        const moved = await fpb.moveTask(input.id, input.columnId, input.position);
        if (!moved) throw new TRPCError({ code: "NOT_FOUND", message: "Task not found" });
        await fpb.logActivity(projectId, ctx.user.id, "moved task", moved.title as string);
        return moved;
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: error instanceof Error ? error.message : "Could not move the task",
        });
      }
    }),

  updateProjectMembers: protectedProcedure
    .input(z.object({ projectId: objectId, memberIds: z.array(objectId) }))
    .mutation(async ({ ctx, input }) => {
      const project = await requireProjectAccess(ctx, input.projectId);
      const before: string[] = ((project as any).memberIds ?? []) as string[];
      const saved = await fpb.setProjectMembers(input.projectId, input.memberIds);
      await fpb.logActivity(input.projectId, ctx.user.id, "updated members");

      // Only the people who were not already on it.
      const added = saved.filter(id => !before.includes(id));
      await notify(added, ctx.user.id, {
        title: "Added to a project",
        message: `You have been added to ${(project as any).title}.`,
        projectId: input.projectId,
      });
      return { memberIds: saved };
    }),

  // ==================== Tasks ====================

  getTasks: protectedProcedure
    .input(z.object({ projectId: objectId }))
    .query(async ({ ctx, input }) => {
      await requireProjectAccess(ctx, input.projectId);
      return fpb.getTasks(input.projectId);
    }),

  getTask: protectedProcedure
    .input(z.object({ id: objectId }))
    .query(async ({ ctx, input }) => {
      const found = await fpb.getTask(input.id);
      if (!found) throw new TRPCError({ code: "NOT_FOUND", message: "Task not found" });
      await requireProjectAccess(ctx, String((found.task as any).projectId));
      return found;
    }),

  createTask: protectedProcedure
    .input(
      z.object({
        projectId: objectId,
        // Omitted means the first column, so a card always lands on the board.
        columnId: objectId.optional(),
        title: z.string().min(1).max(500),
        description: z.string().optional(),
        priority: PRIORITY.optional(),
        dueDate: z.date().optional(),
        assignedTo: objectId.optional(),
        memberIds: z.array(objectId).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const project = await requireProjectAccess(ctx, input.projectId);
      const task = await fpb.createTask({ ...input, createdBy: ctx.user.id });
      await fpb.logActivity(input.projectId, ctx.user.id, "added task", input.title);

      await notify(
        [input.assignedTo ?? "", ...(input.memberIds ?? [])],
        ctx.user.id,
        {
          title: "New task assigned",
          message: `You have been assigned "${input.title}" in ${(project as any).title}.`,
          projectId: input.projectId,
        }
      );
      return task;
    }),

  updateTask: protectedProcedure
    .input(
      z.object({
        id: objectId,
        title: z.string().min(1).max(500).optional(),
        description: z.string().optional(),
        completed: z.boolean().optional(),
        status: WORK_STATUS.optional(),
        progress: z.number().int().min(0).max(100).optional(),
        priority: PRIORITY.optional(),
        dueDate: z.date().nullable().optional(),
        assignedTo: objectId.nullable().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const before = await fpb.getTask(input.id);
      if (!before) throw new TRPCError({ code: "NOT_FOUND", message: "Task not found" });
      const projectId = String((before.task as any).projectId);
      const project = await requireProjectAccess(ctx, projectId);

      const { id, ...updates } = input;
      const saved = await fpb.updateTask(id, updates);
      await fpb.logActivity(projectId, ctx.user.id, "updated task", saved?.title as string);

      // Only on a genuine change of hands, not on every save.
      const previous = (before.task as any).assignedTo;
      if (input.assignedTo && String(previous ?? "") !== input.assignedTo) {
        await notify([input.assignedTo], ctx.user.id, {
          title: "Task assigned to you",
          message: `You have been assigned "${saved?.title}" in ${(project as any).title}.`,
          projectId,
        });
      }
      return saved;
    }),

  deleteTask: protectedProcedure
    .input(z.object({ id: objectId }))
    .mutation(async ({ ctx, input }) => {
      const projectId = await projectIdForTask(input.id);
      await requireProjectAccess(ctx, projectId);
      await fpb.deleteTask(input.id);
      await fpb.logActivity(projectId, ctx.user.id, "deleted task");
      return { success: true };
    }),

  updateTaskMembers: protectedProcedure
    .input(z.object({ taskId: objectId, memberIds: z.array(objectId) }))
    .mutation(async ({ ctx, input }) => {
      const projectId = await projectIdForTask(input.taskId);
      await requireProjectAccess(ctx, projectId);
      const saved = await fpb.setTaskMembers(input.taskId, input.memberIds);
      return { memberIds: saved };
    }),

  // ==================== Subtasks ====================

  createSubtask: protectedProcedure
    .input(z.object({ taskId: objectId, title: z.string().min(1).max(500) }))
    .mutation(async ({ ctx, input }) => {
      const projectId = await projectIdForTask(input.taskId);
      await requireProjectAccess(ctx, projectId);
      return fpb.createSubtask(input.taskId, input.title);
    }),

  getSubtask: protectedProcedure
    .input(z.object({ id: objectId }))
    .query(async ({ ctx, input }) => {
      const found = await fpb.getSubtask(input.id);
      if (!found) throw new TRPCError({ code: "NOT_FOUND", message: "Subtask not found" });
      const projectId = await projectIdForTask(String((found.subtask as any).taskId));
      await requireProjectAccess(ctx, projectId);
      return found;
    }),

  updateSubtask: protectedProcedure
    .input(
      z.object({
        id: objectId,
        title: z.string().min(1).max(500).optional(),
        description: z.string().optional(),
        completed: z.boolean().optional(),
        status: WORK_STATUS.optional(),
        progress: z.number().int().min(0).max(100).optional(),
        assignedTo: objectId.nullable().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const found = await fpb.getSubtask(input.id);
      if (!found) throw new TRPCError({ code: "NOT_FOUND", message: "Subtask not found" });
      const projectId = await projectIdForTask(String((found.subtask as any).taskId));
      await requireProjectAccess(ctx, projectId);
      const { id, ...updates } = input;
      return fpb.updateSubtask(id, updates);
    }),

  deleteSubtask: protectedProcedure
    .input(z.object({ id: objectId }))
    .mutation(async ({ ctx, input }) => {
      const found = await fpb.getSubtask(input.id);
      if (!found) throw new TRPCError({ code: "NOT_FOUND", message: "Subtask not found" });
      const projectId = await projectIdForTask(String((found.subtask as any).taskId));
      await requireProjectAccess(ctx, projectId);
      await fpb.deleteSubtask(input.id);
      return { success: true };
    }),

  // ==================== Comments ====================

  addTaskComment: protectedProcedure
    .input(z.object({ taskId: objectId, comment: z.string().min(1).max(5000) }))
    .mutation(async ({ ctx, input }) => {
      const projectId = await projectIdForTask(input.taskId);
      await requireProjectAccess(ctx, projectId);
      return fpb.addTaskComment(input.taskId, ctx.user.id, input.comment);
    }),

  deleteTaskComment: protectedProcedure
    .input(z.object({ id: objectId }))
    .mutation(async ({ ctx, input }) => {
      const removed = await fpb.deleteTaskComment(input.id, ctx.user.id);
      if (!removed) {
        throw new TRPCError({ code: "FORBIDDEN", message: "You can only delete your own comment" });
      }
      return { success: true };
    }),

  addSubtaskComment: protectedProcedure
    .input(z.object({ subtaskId: objectId, comment: z.string().min(1).max(5000) }))
    .mutation(async ({ ctx, input }) => {
      const found = await fpb.getSubtask(input.subtaskId);
      if (!found) throw new TRPCError({ code: "NOT_FOUND", message: "Subtask not found" });
      const projectId = await projectIdForTask(String((found.subtask as any).taskId));
      await requireProjectAccess(ctx, projectId);
      return fpb.addSubtaskComment(input.subtaskId, ctx.user.id, input.comment);
    }),

  deleteSubtaskComment: protectedProcedure
    .input(z.object({ id: objectId }))
    .mutation(async ({ ctx, input }) => {
      const removed = await fpb.deleteSubtaskComment(input.id, ctx.user.id);
      if (!removed) {
        throw new TRPCError({ code: "FORBIDDEN", message: "You can only delete your own comment" });
      }
      return { success: true };
    }),

  // ==================== Annotations ====================

  getAnnotations: protectedProcedure
    .input(z.object({ projectId: objectId }))
    .query(async ({ ctx, input }) => {
      await requireProjectAccess(ctx, input.projectId);
      return fpb.getAnnotations(input.projectId);
    }),

  uploadAnnotation: protectedProcedure
    .input(
      z.object({
        projectId: objectId,
        fileName: z.string().min(1),
        fileBase64: z.string().min(1),
        mimeType: z.string().default("image/jpeg"),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireProjectAccess(ctx, input.projectId);

      if (!input.mimeType.startsWith("image/")) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Only images can be annotated" });
      }
      const buffer = Buffer.from(input.fileBase64, "base64");
      if (buffer.length === 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "File is empty" });
      }
      if (buffer.length > MAX_UPLOAD_BYTES) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "File must be 8MB or smaller" });
      }

      // The extension is derived from the mime type rather than the supplied
      // filename, so a client cannot land a .html file under /uploads.
      const ext = input.mimeType.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "img";
      const key = `fpb-annotations/${input.projectId}/${Date.now()}.${ext}`;
      const { url } = await storagePut(key, buffer, input.mimeType);

      const annotation = await fpb.createAnnotation({
        projectId: input.projectId,
        fileName: input.fileName,
        fileUrl: url,
        uploadedBy: ctx.user.id,
      });
      await fpb.logActivity(input.projectId, ctx.user.id, "uploaded design file", input.fileName);
      return annotation;
    }),

  addAnnotationComment: protectedProcedure
    .input(
      z.object({
        annotationId: objectId,
        comment: z.string().min(1).max(5000),
        posX: z.number().min(0).max(100),
        posY: z.number().min(0).max(100),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const projectId = await fpb.getAnnotationProjectId(input.annotationId);
      if (!projectId) throw new TRPCError({ code: "NOT_FOUND", message: "File not found" });
      await requireProjectAccess(ctx, projectId);
      return fpb.addAnnotationComment({ ...input, userId: ctx.user.id });
    }),

  resolveAnnotationComment: protectedProcedure
    .input(z.object({ id: objectId, resolved: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const projectId = await fpb.getAnnotationCommentProjectId(input.id);
      if (!projectId) throw new TRPCError({ code: "NOT_FOUND", message: "Comment not found" });
      await requireProjectAccess(ctx, projectId);
      const saved = await fpb.resolveAnnotationComment(input.id, input.resolved);
      if (!saved) throw new TRPCError({ code: "NOT_FOUND", message: "Comment not found" });
      return saved;
    }),

  deleteAnnotation: protectedProcedure
    .input(z.object({ id: objectId }))
    .mutation(async ({ ctx, input }) => {
      const projectId = await fpb.getAnnotationProjectId(input.id);
      if (!projectId) throw new TRPCError({ code: "NOT_FOUND", message: "File not found" });
      await requireProjectAccess(ctx, projectId);
      await fpb.deleteAnnotation(input.id);
      return { success: true };
    }),

  // ==================== Activity & users ====================

  getActivity: protectedProcedure
    .input(z.object({ projectId: objectId, limit: z.number().int().min(1).max(100).default(20) }))
    .query(async ({ ctx, input }) => {
      await requireProjectAccess(ctx, input.projectId);
      return fpb.getActivity(input.projectId, input.limit);
    }),

  getUsers: protectedProcedure.query(async () => fpb.getBoardUsers()),
});
