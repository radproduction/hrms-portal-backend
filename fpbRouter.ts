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
 *
 * Structural deletes (a column, a sub-project and its cards, removing someone
 * from the project) are the project owner's or an org-wide role's call; members
 * can still add and rename columns, reorder them and work the cards.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router } from "./_core/trpc";
import * as fpb from "./fpbDb";
import * as db from "./db";
import { isAnyHead, isOrgWide } from "./roles";
import { canOpenProjects, departmentsLedBy, listDepartments } from "./departments";
import { getMonthRange } from "./attendance";
import { summarizePerformance } from "./fpbMetrics";
import { emitNotification } from "./_core/realtime";
import { storagePut } from "./storage";
import { deleteRoundsForProject } from "./clientRounds";
import type { NotificationType } from "./models";
import {
  boardLink,
  canDeleteComment,
  isLabelColor,
  labelsBelong,
  mentionTargets,
  plainText,
  presentComment,
  safeImageExtension,
  taskAudience,
  type CommentRecord,
} from "./fpbRules";

const PRIORITY = z.enum(["low", "medium", "high", "urgent"]);
const WORK_STATUS = z.enum(["todo", "in_progress", "in_review", "blocked", "done"]);
const PROJECT_TYPE = z.enum(["dev", "lead", "management", "accounting", "other"]);
const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, "Invalid id");

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

/**
 * Org-wide roles, the creator, or anyone on the project may see and edit it.
 *
 * This is also the read gate: a project is private to the people in it, and
 * "adding" someone would mean nothing if outsiders could open it anyway.
 */
export async function requireProjectAccess(
  ctx: { user: { id: string; role?: string } },
  projectId: string
) {
  const project = await fpb.getProject(projectId);
  if (!project) throw new TRPCError({ code: "NOT_FOUND", message: "Project not found" });
  if (isOrgWide(ctx.user.role)) return project;
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
export async function requireProjectOwner(
  ctx: { user: { id: string; role?: string } },
  projectId: string
) {
  const project = await fpb.getProject(projectId);
  if (!project) throw new TRPCError({ code: "NOT_FOUND", message: "Project not found" });
  if (isOrgWide(ctx.user.role)) return project;
  if (String((project as any).createdBy) === ctx.user.id) return project;
  // Department heads run their teams' boards: on a project they can open, they
  // may restructure it too (delete columns, sub-projects, labels, the project).
  if (isAnyHead(ctx.user.role)) return requireProjectAccess(ctx, projectId);
  throw new TRPCError({
    code: "FORBIDDEN",
    message: "Only the person who created this project, a department head or an admin can do that",
  });
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

/** Sub-projects are gated by the project they belong to. */
async function requireSubprojectAccess(
  ctx: { user: { id: string; role?: string } },
  subprojectId: string
) {
  const projectId = await fpb.getSubprojectProjectId(subprojectId);
  if (!projectId) throw new TRPCError({ code: "NOT_FOUND", message: "Sub-project not found" });
  await requireProjectAccess(ctx, projectId);
  return projectId;
}

/**
 * Board changes are only useful if the people affected hear about them, so
 * assignment, membership, comments and completion raise a notification and a
 * realtime ping. Never notify the person who performed the action.
 *
 * Every board notification carries a link that opens the project — and the
 * task, when there is one — so clicking it lands on the card itself.
 */
async function notify(
  userIds: string[],
  actorId: string,
  payload: {
    title: string;
    message: string;
    projectId: string;
    taskId?: string;
    type?: NotificationType;
  }
) {
  const targets = [...new Set(userIds)].filter(id => id && id !== actorId);
  for (const userId of targets) {
    try {
      await db.createNotification({
        userId,
        type: payload.type ?? "task_assigned",
        title: payload.title,
        message: payload.message,
        priority: "medium",
        relatedId: payload.taskId ?? payload.projectId,
        relatedType: payload.taskId ? "fpb_task" : "fpb_project",
        link: boardLink(payload.projectId, payload.taskId),
      });
      emitNotification({ userId });
    } catch (error) {
      // A failed notification must not roll back the work it describes.
      console.error("[FPB] failed to notify", userId, error);
    }
  }
}

/** Short, single-line excerpt of a comment for a notification. */
function excerpt(text: string, max = 120) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Everyone who belongs to a project: its creator and its members. */
function projectPeople(project: any): string[] {
  return [String(project?.createdBy ?? ""), ...((project?.memberIds ?? []) as string[]).map(String)]
    .filter(Boolean);
}

/**
 * Tells people they were @mentioned. Only project people can be mentioned, only
 * new mentions ping (an edit does not re-notify), and never the author.
 */
async function notifyMentions(input: {
  before?: string | null;
  after: string;
  project: any;
  projectId: string;
  taskId: string;
  taskTitle: string;
  actor: { id: string; name?: string | null };
  where: "comment" | "description";
}) {
  const targets = mentionTargets({
    before: input.before,
    after: input.after,
    projectPeople: projectPeople(input.project),
    actorId: input.actor.id,
  });
  if (targets.length === 0) return;
  await notify(targets, input.actor.id, {
    title: `${input.actor.name ?? "Someone"} mentioned you`,
    message:
      input.where === "comment"
        ? `On "${input.taskTitle}": ${excerpt(plainText(input.after))}`
        : `In the description of "${input.taskTitle}" (${input.project?.title ?? "project"}).`,
    projectId: input.projectId,
    taskId: input.taskId,
    type: "task_mention",
  });
}

/** Words for the activity line of a card edit, e.g. "changed the due date". */
function describeTaskEdit(updates: Record<string, unknown>): string {
  const parts: Record<string, string> = {
    title: "renamed the card",
    description: "updated the description",
    status: "changed the status",
    priority: "changed the priority",
    dueDate: "changed the due date",
    assignedTo: "changed the assignee",
    labelIds: "changed the labels",
    progress: "updated progress",
  };
  const said = Object.keys(updates)
    .filter(k => updates[k] !== undefined && parts[k])
    .map(k => parts[k]);
  return said.length > 0 ? said.join(", ") : "updated the card";
}

async function projectIdForTask(taskId: string) {
  const found = await fpb.getTask(taskId);
  if (!found) throw new TRPCError({ code: "NOT_FOUND", message: "Task not found" });
  return String((found.task as any).projectId);
}

export const fpbRouter = router({
  // ==================== Board & columns ====================

  /**
   * One project's board. A project is split into sub-projects (e.g. a Brand
   * split into Social Media / Development / SEO); the board runs one at a time.
   * Columns are shared across the project; the cards are those of the selected
   * sub-project. Omitting `subprojectId` shows the first sub-project.
   */
  getBoard: protectedProcedure
    .input(z.object({ projectId: objectId, subprojectId: objectId.optional() }))
    .query(async ({ ctx, input }) => {
      const project = await requireProjectAccess(ctx, input.projectId);
      const [subprojects, columns, labels] = await Promise.all([
        fpb.getSubprojects(input.projectId),
        fpb.getColumns(input.projectId),
        fpb.getLabels(input.projectId),
      ]);
      // Resolve the sub-project to display: the requested one if it belongs to
      // this project, otherwise the first. Every project has at least one.
      const active =
        subprojects.find(s => s.id === input.subprojectId) ?? subprojects[0];
      const tasks = active
        ? await fpb.getTasks(input.projectId, active.id as string)
        : [];
      return {
        project,
        subprojects,
        activeSubprojectId: active ? (active.id as string) : null,
        columns,
        labels,
        tasks,
      };
    }),

  // ==================== Sub-projects ====================

  getSubprojects: protectedProcedure
    .input(z.object({ projectId: objectId }))
    .query(async ({ ctx, input }) => {
      await requireProjectAccess(ctx, input.projectId);
      return fpb.getSubprojects(input.projectId);
    }),

  createSubproject: protectedProcedure
    .input(
      z.object({
        projectId: objectId,
        name: z.string().min(1).max(120),
        color: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireProjectAccess(ctx, input.projectId);
      const created = await fpb.createSubproject({ ...input, createdBy: ctx.user.id });
      await fpb.logActivity(input.projectId, ctx.user.id, "added sub-project", input.name);
      return created;
    }),

  updateSubproject: protectedProcedure
    .input(
      z.object({
        id: objectId,
        name: z.string().min(1).max(120).optional(),
        color: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const projectId = await requireSubprojectAccess(ctx, input.id);
      const { id, ...updates } = input;
      const saved = await fpb.updateSubproject(id, updates);
      if (!saved) throw new TRPCError({ code: "NOT_FOUND", message: "Sub-project not found" });
      await fpb.logActivity(projectId, ctx.user.id, "updated sub-project");
      return saved;
    }),

  deleteSubproject: protectedProcedure
    .input(z.object({ id: objectId }))
    .mutation(async ({ ctx, input }) => {
      const projectId = await requireSubprojectAccess(ctx, input.id);
      // Deleting a sub-project deletes every card in it.
      await requireProjectOwner(ctx, projectId);
      try {
        const result = await fpb.deleteSubproject(input.id);
        await fpb.logActivity(projectId, ctx.user.id, "deleted sub-project");
        return result;
      } catch (error) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: error instanceof Error ? error.message : "Could not delete sub-project",
        });
      }
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
      const projectId = await requireColumnAccess(ctx, input.id);
      await requireProjectOwner(ctx, projectId);
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

  /**
   * The new left-to-right order of a project's columns. Must list every column
   * of the project exactly once; positions are rewritten as 0..n-1.
   */
  reorderColumns: protectedProcedure
    .input(z.object({ projectId: objectId, columnIds: z.array(objectId).min(1).max(50) }))
    .mutation(async ({ ctx, input }) => {
      await requireProjectAccess(ctx, input.projectId);
      try {
        const columns = await fpb.reorderColumns(input.projectId, input.columnIds);
        await fpb.logActivity(input.projectId, ctx.user.id, "reordered columns");
        return columns;
      } catch (error) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: error instanceof Error ? error.message : "Could not reorder the columns",
        });
      }
    }),

  // ==================== Labels ====================

  createLabel: protectedProcedure
    .input(
      z.object({
        projectId: objectId,
        name: z.string().trim().max(40).default(""),
        color: z.string().refine(isLabelColor, "Colour must be #rrggbb"),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireProjectAccess(ctx, input.projectId);
      return fpb.createLabel(input.projectId, input.name, input.color);
    }),

  updateLabel: protectedProcedure
    .input(
      z.object({
        id: objectId,
        name: z.string().trim().max(40).optional(),
        color: z.string().refine(isLabelColor, "Colour must be #rrggbb").optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const projectId = await fpb.getLabelProjectId(input.id);
      if (!projectId) throw new TRPCError({ code: "NOT_FOUND", message: "Label not found" });
      await requireProjectAccess(ctx, projectId);
      const { id, ...updates } = input;
      return fpb.updateLabel(id, updates);
    }),

  /** Deleting a label takes it off every card; the project owner's call. */
  deleteLabel: protectedProcedure
    .input(z.object({ id: objectId }))
    .mutation(async ({ ctx, input }) => {
      const projectId = await fpb.getLabelProjectId(input.id);
      if (!projectId) throw new TRPCError({ code: "NOT_FOUND", message: "Label not found" });
      await requireProjectOwner(ctx, projectId);
      await fpb.deleteLabel(input.id);
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
        visibleTo: isOrgWide(ctx.user.role) ? undefined : ctx.user.id,
      })
    ),

  getProject: protectedProcedure
    .input(z.object({ id: objectId }))
    .query(async ({ ctx, input }) => requireProjectAccess(ctx, input.id)),

  /**
   * Whether the caller may open a project, so the button can be hidden rather
   * than offered and then refused. The mutation checks this again; this is
   * only about what to show.
   */
  canCreateProjects: protectedProcedure.query(async ({ ctx }) =>
    canOpenProjects(ctx.user)
  ),

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
      // Opening a project is a granted right, not something everyone has.
      // Org-wide roles always; a department head only once a super admin has
      // given their department the grant.
      if (!(await canOpenProjects(ctx.user))) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message:
            "You do not have permission to create projects. Ask an administrator to grant it to your department.",
        });
      }

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
        type: "project_member_added",
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
      // The project's monthly client rounds, their files and feedback go too.
      await deleteRoundsForProject(input.id).catch(error =>
        console.error("[ClientRounds] cleanup after project delete failed", error instanceof Error ? error.name : "unknown error")
      );
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
        await fpb.logActivity(projectId, ctx.user.id, "moved task", moved.title as string, input.id);
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
    .input(z.object({ projectId: objectId, memberIds: z.array(objectId).max(500) }))
    .mutation(async ({ ctx, input }) => {
      const project = await requireProjectAccess(ctx, input.projectId);
      const before: string[] = ((project as any).memberIds ?? []) as string[];

      // Any member may bring people in; taking someone off the project is the
      // owner's (or an org-wide role's) decision.
      const removed = before.filter(id => !input.memberIds.includes(id));
      if (removed.length > 0) await requireProjectOwner(ctx, input.projectId);

      // Only real people: an unknown id would make a member row for nobody.
      const added = [...new Set<string>(input.memberIds)].filter(id => !before.includes(id));
      if (added.length > 0) {
        const known = new Set(((await fpb.getBoardUsers()) as any[]).map(u => String(u.id)));
        const unknown = added.filter(id => !known.has(id));
        if (unknown.length > 0) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "One of those people does not exist" });
        }
      }

      const saved = await fpb.setProjectMembers(input.projectId, input.memberIds);
      await fpb.logActivity(input.projectId, ctx.user.id, "updated members");

      await notify(added, ctx.user.id, {
        title: "Added to a project",
        message: `You have been added to ${(project as any).title}.`,
        projectId: input.projectId,
        type: "project_member_added",
      });
      return { memberIds: saved };
    }),

  // ==================== Tasks ====================

  getTasks: protectedProcedure
    .input(z.object({ projectId: objectId, subprojectId: objectId.optional() }))
    .query(async ({ ctx, input }) => {
      await requireProjectAccess(ctx, input.projectId);
      return fpb.getTasks(input.projectId, input.subprojectId);
    }),

  getTask: protectedProcedure
    .input(z.object({ id: objectId }))
    .query(async ({ ctx, input }) => {
      const found = await fpb.getTask(input.id);
      if (!found) throw new TRPCError({ code: "NOT_FOUND", message: "Task not found" });
      await requireProjectAccess(ctx, String((found.task as any).projectId));
      // Deleted comments keep their place in the thread; their text (and the
      // history of edited ones) only reaches org-wide roles.
      const orgWide = isOrgWide(ctx.user.role);
      return {
        ...found,
        comments: (found.comments as unknown as CommentRecord[]).map(c => presentComment(c, orgWide)),
      };
    }),

  createTask: protectedProcedure
    .input(
      z.object({
        projectId: objectId,
        // Which sub-project (e.g. "Development") the card belongs to. Omitted
        // means the project's first sub-project.
        subprojectId: objectId.optional(),
        // Omitted means the first column, so a card always lands on the board.
        columnId: objectId.optional(),
        title: z.string().min(1).max(500),
        description: z.string().max(20000).optional(),
        priority: PRIORITY.optional(),
        dueDate: z.date().optional(),
        assignedTo: objectId.optional(),
        memberIds: z.array(objectId).max(50).optional(),
        labelIds: z.array(objectId).max(20).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const project = await requireProjectAccess(ctx, input.projectId);
      // Same rules as editing a card: project people only, project labels only.
      const people = new Set(projectPeople(project));
      if ([input.assignedTo, ...(input.memberIds ?? [])].some(id => id && !people.has(id))) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Only people on this project can be added to its cards" });
      }
      if (input.labelIds?.length) {
        const own = ((await fpb.getLabels(input.projectId)) as any[]).map(l => String(l.id));
        if (!labelsBelong(input.labelIds, own)) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Label does not belong to this project" });
        }
      }
      // When a sub-project is named it must belong to this project; when it is
      // omitted the data layer files the card under the project's default one.
      if (input.subprojectId) {
        const spProjectId = await fpb.getSubprojectProjectId(input.subprojectId);
        if (spProjectId !== input.projectId) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Sub-project does not belong to this project",
          });
        }
      }
      // Same for the column: a card must not be filed on another project's board.
      if (input.columnId) {
        const colProjectId = await fpb.getColumnProjectId(input.columnId);
        if (colProjectId !== input.projectId) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Column does not belong to this project",
          });
        }
      }
      const task = await fpb.createTask({ ...input, createdBy: ctx.user.id });
      await fpb.logActivity(input.projectId, ctx.user.id, "added task", input.title, task.id);
      if (input.description) {
        await notifyMentions({
          after: input.description,
          project,
          projectId: input.projectId,
          taskId: task.id,
          taskTitle: input.title,
          actor: ctx.user,
          where: "description",
        });
      }

      await notify(
        [input.assignedTo ?? "", ...(input.memberIds ?? [])],
        ctx.user.id,
        {
          title: "New task assigned",
          message: `You have been assigned "${input.title}" in ${(project as any).title}.`,
          projectId: input.projectId,
          taskId: task.id,
        }
      );
      return task;
    }),

  updateTask: protectedProcedure
    .input(
      z.object({
        id: objectId,
        title: z.string().min(1).max(500).optional(),
        description: z.string().max(20000).optional(),
        completed: z.boolean().optional(),
        status: WORK_STATUS.optional(),
        progress: z.number().int().min(0).max(100).optional(),
        priority: PRIORITY.optional(),
        dueDate: z.date().nullable().optional(),
        assignedTo: objectId.nullable().optional(),
        labelIds: z.array(objectId).max(20).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const before = await fpb.getTask(input.id);
      if (!before) throw new TRPCError({ code: "NOT_FOUND", message: "Task not found" });
      const projectId = String((before.task as any).projectId);
      const project = await requireProjectAccess(ctx, projectId);

      // A card can only carry its own project's labels.
      if (input.labelIds) {
        input.labelIds = [...new Set<string>(input.labelIds)];
        const own = ((await fpb.getLabels(projectId)) as any[]).map(l => String(l.id));
        if (!labelsBelong(input.labelIds, own)) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Label does not belong to this project" });
        }
      }

      const { id, ...updates } = input;
      const saved = await fpb.updateTask(id, updates, ctx.user.id);
      const wasCompleted = Boolean((before.task as any).completed);
      const nowCompleted = Boolean(saved?.completed);
      await fpb.logActivity(
        projectId,
        ctx.user.id,
        !wasCompleted && nowCompleted
          ? "completed task"
          : wasCompleted && !nowCompleted
            ? "reopened task"
            : describeTaskEdit(updates),
        saved?.title as string,
        id
      );

      if (input.description !== undefined) {
        await notifyMentions({
          before: (before.task as any).description,
          after: input.description,
          project,
          projectId,
          taskId: id,
          taskTitle: String(saved?.title ?? ""),
          actor: ctx.user,
          where: "description",
        });
      }

      // Only on a genuine change of hands, not on every save.
      const previous = (before.task as any).assignedTo;
      if (input.assignedTo && String(previous ?? "") !== input.assignedTo) {
        await notify([input.assignedTo], ctx.user.id, {
          title: "Task assigned to you",
          message: `You have been assigned "${saved?.title}" in ${(project as any).title}.`,
          projectId,
          taskId: id,
        });
      }

      // Whoever asked for the work hears that it is done.
      if (!wasCompleted && nowCompleted) {
        await notify([String((before.task as any).createdBy ?? "")], ctx.user.id, {
          title: "Task completed",
          message: `${ctx.user.name ?? "Someone"} completed "${saved?.title}" in ${(project as any).title}.`,
          projectId,
          taskId: id,
          type: "task_completed",
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

  /**
   * The people on a card (Trello "members"), besides its one assignee. Only
   * people on the project can be put on its cards; the newly added hear about it.
   */
  updateTaskMembers: protectedProcedure
    .input(z.object({ taskId: objectId, memberIds: z.array(objectId).max(50) }))
    .mutation(async ({ ctx, input }) => {
      const found = await fpb.getTask(input.taskId);
      if (!found) throw new TRPCError({ code: "NOT_FOUND", message: "Task not found" });
      const projectId = String((found.task as any).projectId);
      const project = await requireProjectAccess(ctx, projectId);

      const people = new Set(projectPeople(project));
      const outsiders = input.memberIds.filter(id => !people.has(id));
      if (outsiders.length > 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Only people on this project can be added to its cards" });
      }

      const before = new Set(found.memberIds);
      const saved = await fpb.setTaskMembers(input.taskId, input.memberIds);
      const added = saved.filter(id => !before.has(id));
      await fpb.logActivity(projectId, ctx.user.id, "changed the card members", (found.task as any).title, input.taskId);
      await notify(added, ctx.user.id, {
        title: "Added to a card",
        message: `${ctx.user.name ?? "Someone"} added you to "${(found.task as any).title}" in ${(project as any).title}.`,
        projectId,
        taskId: input.taskId,
        type: "task_assigned",
      });
      return { memberIds: saved };
    }),

  // ==================== Subtasks ====================

  createSubtask: protectedProcedure
    .input(z.object({ taskId: objectId, title: z.string().min(1).max(500) }))
    .mutation(async ({ ctx, input }) => {
      const projectId = await projectIdForTask(input.taskId);
      await requireProjectAccess(ctx, projectId);
      const created = await fpb.createSubtask(input.taskId, input.title);
      await fpb.logActivity(projectId, ctx.user.id, "added checklist item", input.title, input.taskId);
      return created;
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
      const saved = await fpb.updateSubtask(id, updates);
      if (input.completed !== undefined && input.completed !== Boolean((found.subtask as any).completed)) {
        await fpb.logActivity(
          projectId,
          ctx.user.id,
          input.completed ? "completed checklist item" : "reopened checklist item",
          String((found.subtask as any).title ?? ""),
          String((found.subtask as any).taskId)
        );
      }
      return saved;
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
    .input(z.object({ taskId: objectId, comment: z.string().trim().min(1).max(5000) }))
    .mutation(async ({ ctx, input }) => {
      const found = await fpb.getTask(input.taskId);
      if (!found) throw new TRPCError({ code: "NOT_FOUND", message: "Task not found" });
      const projectId = String((found.task as any).projectId);
      const project = await requireProjectAccess(ctx, projectId);
      const created = await fpb.addTaskComment(input.taskId, ctx.user.id, input.comment);
      await fpb.logActivity(projectId, ctx.user.id, "commented on", (found.task as any).title, input.taskId);

      // The people on the card hear about the conversation on it.
      const task = found.task as any;
      await notify(
        taskAudience(
          { assignedTo: task.assignedTo, createdBy: task.createdBy, memberIds: found.memberIds },
          ctx.user.id
        ),
        ctx.user.id,
        {
          title: `New comment on "${task.title}"`,
          message: `${ctx.user.name ?? "Someone"} in ${(project as any).title}: ${excerpt(plainText(input.comment))}`,
          projectId,
          taskId: input.taskId,
          type: "task_comment",
        }
      );
      await notifyMentions({
        after: input.comment,
        project,
        projectId,
        taskId: input.taskId,
        taskTitle: String(task.title ?? ""),
        actor: ctx.user,
        where: "comment",
      });
      return created;
    }),

  /** Edit your own comment. The earlier text is kept and the comment is marked edited. */
  editTaskComment: protectedProcedure
    .input(z.object({ id: objectId, comment: z.string().trim().min(1).max(5000) }))
    .mutation(async ({ ctx, input }) => {
      const existing = await fpb.getTaskComment(input.id);
      if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "Comment not found" });
      const task = await fpb.getTask(String(existing.taskId));
      if (!task) throw new TRPCError({ code: "NOT_FOUND", message: "Task not found" });
      const projectId = String((task.task as any).projectId);
      const project = await requireProjectAccess(ctx, projectId);
      if (existing.deletedAt) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "A deleted comment cannot be edited" });
      }
      const saved = await fpb.editTaskComment(input.id, ctx.user.id, input.comment);
      if (!saved) {
        throw new TRPCError({ code: "FORBIDDEN", message: "You can only edit your own comment" });
      }
      await fpb.logActivity(projectId, ctx.user.id, "edited a comment", undefined, String(existing.taskId));
      // Someone newly @mentioned in the edit hears about it; the rest do not again.
      await notifyMentions({
        before: String(existing.comment ?? ""),
        after: input.comment,
        project,
        projectId,
        taskId: String(existing.taskId),
        taskTitle: String((task.task as any).title ?? ""),
        actor: ctx.user,
        where: "comment",
      });
      return presentComment(saved as unknown as CommentRecord, isOrgWide(ctx.user.role));
    }),

  /**
   * Delete a comment: your own, or anyone's if you are org-wide. The thread
   * keeps "X deleted this comment" so nothing disappears without a trace.
   */
  deleteTaskComment: protectedProcedure
    .input(z.object({ id: objectId }))
    .mutation(async ({ ctx, input }) => {
      const existing = await fpb.getTaskComment(input.id);
      if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "Comment not found" });
      const projectId = await projectIdForTask(String(existing.taskId));
      await requireProjectAccess(ctx, projectId);
      const actor = { id: ctx.user.id, isOrgWide: isOrgWide(ctx.user.role) };
      if (!canDeleteComment({ userId: String(existing.userId) }, actor)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "You can only delete your own comment" });
      }
      await fpb.deleteTaskComment(input.id, ctx.user.id);
      await fpb.logActivity(projectId, ctx.user.id, "deleted a comment", undefined, String(existing.taskId));
      return { success: true };
    }),

  addSubtaskComment: protectedProcedure
    .input(z.object({ subtaskId: objectId, comment: z.string().trim().min(1).max(5000) }))
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
      const existing = await fpb.getSubtaskComment(input.id);
      if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "Comment not found" });
      const found = await fpb.getSubtask(String(existing.subtaskId));
      if (!found) throw new TRPCError({ code: "NOT_FOUND", message: "Subtask not found" });
      const projectId = await projectIdForTask(String((found.subtask as any).taskId));
      await requireProjectAccess(ctx, projectId);
      const actor = { id: ctx.user.id, isOrgWide: isOrgWide(ctx.user.role) };
      if (!canDeleteComment({ userId: String(existing.userId) }, actor)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "You can only delete your own comment" });
      }
      await fpb.deleteSubtaskComment(input.id, ctx.user.id);
      return { success: true };
    }),

  // ==================== Performance ====================

  /**
   * Monthly performance: tasks completed per employee (on time / late), open
   * and overdue work, by department. For one project, or across all projects:
   * org-wide roles see everyone, department heads their departments, everyone
   * else themselves.
   */
  getPerformance: protectedProcedure
    .input(
      z.object({
        month: z.number().int().min(1).max(12),
        year: z.number().int().min(2020).max(2100),
        projectId: objectId.optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const { start, end } = getMonthRange(input.month, input.year);

      let userIds: string[] | undefined;
      if (input.projectId) {
        const project = await requireProjectAccess(ctx, input.projectId);
        userIds = [...new Set(projectPeople(project))];
      } else if (isOrgWide(ctx.user.role)) {
        userIds = undefined; // everyone
      } else if (isAnyHead(ctx.user.role)) {
        const led = await departmentsLedBy(ctx.user.id);
        userIds = [...new Set([ctx.user.id, ...(await fpb.getPeopleInDepartments(led))])];
      } else {
        userIds = [ctx.user.id];
      }

      const [tasks, users, departments] = await Promise.all([
        fpb.getPerformanceTasks({ start, end, projectId: input.projectId }),
        fpb.getPeopleForMetrics(userIds),
        listDepartments(),
      ]);

      return summarizePerformance({
        tasks,
        users,
        departments: departments.map(d => ({ id: d.id, name: d.name, headUserId: d.headUserId })),
        month: input.month,
        year: input.year,
        start,
        end,
        now: new Date(),
      });
    }),

  // ==================== Attachments ====================
  // Uploading and downloading go through REST (fpbAttachments.ts), since tRPC
  // does not carry files; listing comes with getTask.

  /** Remove a file from a card: whoever attached it, or the project's managers. */
  deleteAttachment: protectedProcedure
    .input(z.object({ id: objectId }))
    .mutation(async ({ ctx, input }) => {
      const found = await fpb.getAttachment(input.id);
      if (!found) throw new TRPCError({ code: "NOT_FOUND", message: "Attachment not found" });
      const projectId = String(found.projectId);
      await requireProjectAccess(ctx, projectId);
      if (String(found.uploadedBy) !== ctx.user.id) await requireProjectOwner(ctx, projectId);
      await fpb.deleteAttachment(input.id);
      await fpb.logActivity(projectId, ctx.user.id, "removed attachment", String(found.fileName ?? ""), String(found.taskId));
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

      const buffer = Buffer.from(input.fileBase64, "base64");
      if (buffer.length === 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "File is empty" });
      }
      if (buffer.length > MAX_UPLOAD_BYTES) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "File must be 8MB or smaller" });
      }

      // Only real PNG/JPEG/GIF/WebP files, checked by their bytes. The extension
      // used to come from the client's MIME type, so "image/html" stored a .html
      // page on the portal's own origin (stored XSS).
      const ext = safeImageExtension(input.mimeType, buffer);
      if (!ext) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Only PNG, JPEG, GIF or WebP images can be annotated",
        });
      }
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
