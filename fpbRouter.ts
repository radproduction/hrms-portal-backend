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
import { OFFSET_MINUTES, getMonthRange } from "./attendance";
import { summarizePerformance } from "./fpbMetrics";
import { summarizeDepartmentKpis, summarizeOverview } from "./fpbOverview";
import { emitNotification } from "./_core/realtime";
import { notifyWingmanEvent } from "./wingman";
import { storagePut } from "./storage";
import { deleteRoundsForProject } from "./clientRounds";
import type { NotificationType } from "./models";
import {
  boardLink,
  buildStageTimeline,
  canDeleteComment,
  canFinishTask,
  columnForStage,
  inferStage,
  officeDayStart,
  resolveOwnerDepartment,
  type TaskStage,
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
const WORK_STATUS = z.enum(["backlog", "todo", "in_progress", "in_review", "blocked", "done"]);
const PROJECT_TYPE = z.enum(["dev", "lead", "management", "accounting", "other"]);
const PROJECT_SCOPE = z.enum(["social_media", "design", "saas", "website"]);
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
  if (isCreator || isMember) return project;
  // A department head may open the boards their employees work on.
  if (isAnyHead(ctx.user.role)) {
    const team = new Set(await teamOf(ctx.user.id));
    const people = [String((project as any).createdBy), ...((project as any).memberIds ?? [])];
    if (people.some(id => team.has(id))) return project;
  }
  throw new TRPCError({ code: "FORBIDDEN", message: "You are not on this project" });
}

/** Admins may look at anyone's boards, department heads at their own employees'. */
async function requireCanViewEmployee(
  ctx: { user: { id: string; role?: string } },
  employeeId: string
) {
  if (isOrgWide(ctx.user.role)) return;
  if (isAnyHead(ctx.user.role) && (await teamOf(ctx.user.id)).includes(employeeId)) return;
  throw new TRPCError({ code: "FORBIDDEN", message: "That person is not in your department" });
}

/** Everyone in the departments this person heads (not including the head). */
async function teamOf(userId: string): Promise<string[]> {
  const led = await departmentsLedBy(userId);
  if (led.length === 0) return [];
  return (await fpb.getPeopleInDepartments(led)).filter((id: string) => id !== userId);
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
      // Assignments also reach the person on WhatsApp through Wingman, as
      // tasks did before the board replaced the old project system.
      if ((payload.type ?? "task_assigned") === "task_assigned" && payload.taskId) {
        void notifyWingmanEvent(userId, {
          type: "task_assigned",
          title: payload.title,
          message: payload.message,
        });
      }
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

// ==================== Department tasks ====================

const NOT_FINISHER =
  "Only the owner department's head, the project manager or an admin can mark this task done";

/** Whether `ctx.user` may mark this task done (see canFinishTask). */
async function mayFinish(ctx: { user: { id: string; role?: string } }, task: any, project: any) {
  const departmentIds = ((task?.departmentIds ?? []) as unknown[]).map(String);
  const owner = resolveOwnerDepartment(departmentIds, task?.ownerDepartmentId ? String(task.ownerDepartmentId) : null);
  let ownerHead: string | null = null;
  if (owner) {
    const departments = await fpb.getDepartmentsWithHeads();
    ownerHead = departments.find(d => d.id === owner)?.headUserId ?? null;
  }
  return canFinishTask({
    actorId: ctx.user.id,
    actorIsOrgWide: isOrgWide(ctx.user.role),
    projectCreatorId: String(project?.createdBy ?? ""),
    departmentIds,
    ownerDepartmentHeadId: ownerHead,
  });
}

/**
 * The project manager's own controls (which departments a task goes to):
 * admins, the project's creator, or anyone allowed to open projects who is on it.
 */
async function requireTaskManager(ctx: { user: { id: string; role?: string } }, projectId: string) {
  const project = await requireProjectAccess(ctx, projectId);
  if (isOrgWide(ctx.user.role)) return project;
  if (String((project as any).createdBy) === ctx.user.id) return project;
  if (await canOpenProjects(ctx.user)) return project;
  throw new TRPCError({
    code: "FORBIDDEN",
    message: "Only the project manager can change which departments a task goes to",
  });
}

/**
 * A task's departments are open to their heads and people even when they are
 * not on the project: the department board is where they find their work.
 */
async function departmentsOf(ctx: { user: { id: string; role?: string } }) {
  const led = isAnyHead(ctx.user.role) ? await departmentsLedBy(ctx.user.id) : [];
  const own = await fpb.getUserDepartmentId(ctx.user.id);
  return { led, all: [...new Set([...led, ...(own ? [own] : [])])] };
}

/** Project access, or (for a department task) being in or heading one of its departments. */
async function requireTaskAccess(ctx: { user: { id: string; role?: string } }, task: any) {
  const projectId = String(task.projectId);
  try {
    return await requireProjectAccess(ctx, projectId);
  } catch (error) {
    const taskDepartments = ((task?.departmentIds ?? []) as unknown[]).map(String);
    if (taskDepartments.length > 0) {
      const mine = await departmentsOf(ctx);
      if (taskDepartments.some(d => mine.all.includes(d))) {
        const project = await fpb.getProject(projectId);
        if (project) return project;
      }
    }
    throw error;
  }
}

/**
 * Moves a task to a stage: one status for everyone working on it. The project
 * board card follows to the first column of that stage, so the project
 * manager's board and the departments' boards never disagree.
 */
async function applyStage(
  ctx: { user: { id: string; role?: string; name?: string | null } },
  task: any,
  project: any,
  stage: string
) {
  const id = String(task.id ?? task._id);
  const projectId = String(task.projectId);
  const fromStatus = task.completed ? "done" : String(task.status ?? "todo");
  if (fromStatus === stage) return task;
  if (stage === "done" && !(await mayFinish(ctx, task, project))) {
    throw new TRPCError({ code: "FORBIDDEN", message: NOT_FINISHER });
  }

  const saved = await fpb.updateTask(id, { status: stage, completed: stage === "done" }, ctx.user.id);

  const columns = ((await fpb.getColumns(projectId)) as any[]).map(c => ({
    id: String(c.id),
    name: String(c.name),
    position: Number(c.position ?? 0),
  }));
  const fromColumn = columns.find(c => c.id === String(task.columnId));
  const target = stage === "blocked" ? null : columnForStage(columns, stage as TaskStage);
  let toColumn = fromColumn;
  if (target && target !== String(task.columnId)) {
    await fpb.moveTask(id, target, 100000);
    toColumn = columns.find(c => c.id === target);
  }

  await fpb.logActivity(projectId, ctx.user.id, "changed the status", String(saved?.title ?? task.title), id, {
    fromStatus,
    toStatus: stage,
    fromColumn: fromColumn?.name,
    toColumn: toColumn?.name,
  });

  if (stage === "done") {
    await notify([String(task.createdBy ?? "")], ctx.user.id, {
      title: "Task completed",
      message: `${ctx.user.name ?? "Someone"} completed "${saved?.title ?? task.title}" in ${(project as any).title}.`,
      projectId,
      taskId: id,
      type: "task_completed",
    });
  }
  return saved;
}

/** requireTaskAccess by task id; returns the task's project id. */
async function requireTaskAccessById(ctx: { user: { id: string; role?: string } }, taskId: string) {
  const found = await fpb.getTask(taskId);
  if (!found) throw new TRPCError({ code: "NOT_FOUND", message: "Task not found" });
  await requireTaskAccess(ctx, found.task);
  return String((found.task as any).projectId);
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
          scope: PROJECT_SCOPE.optional(),
          status: z.enum(["active", "on_hold", "completed", "archived"]).optional(),
          /** Show this employee's projects instead of the viewer's own. */
          employeeId: objectId.optional(),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      const { employeeId, ...filters } = input ?? {};
      // Looking at one employee's projects: admins for anyone, department
      // heads for the people in the departments they lead.
      if (employeeId && employeeId !== ctx.user.id) {
        await requireCanViewEmployee(ctx, employeeId);
        return fpb.getProjects({ ...filters, visibleTo: employeeId });
      }
      // Admins see every space; everyone else sees their own and the ones
      // they were added to.
      return fpb.getProjects({
        ...filters,
        visibleTo: isOrgWide(ctx.user.role) && !employeeId ? undefined : ctx.user.id,
      });
    }),

  /**
   * The people whose boards this person may look at: everyone for admins,
   * their departments' employees for heads, nobody for anyone else.
   */
  getTeamMembers: protectedProcedure.query(async ({ ctx }) => {
    if (!isAnyHead(ctx.user.role)) return [];
    const everyone = await fpb.getBoardUsers();
    if (isOrgWide(ctx.user.role)) return everyone.filter(u => u.id !== ctx.user.id);
    const team = new Set(await teamOf(ctx.user.id));
    return everyone.filter(u => team.has(u.id));
  }),

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
        projectType: PROJECT_TYPE.optional(),
        scopes: z.array(PROJECT_SCOPE).min(1, "Pick at least one scope").max(4),
        priority: PRIORITY.optional(),
        startDate: z.date().optional(),
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
      // Opening a project is a granted right: admins, and the people an admin
      // has named (the project manager).
      if (!(await canOpenProjects(ctx.user))) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Only the project manager can create projects. Ask an administrator for access.",
        });
      }
      if (input.startDate && input.dueDate && input.startDate > input.dueDate) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "The start date is after the due date" });
      }

      const project = await fpb.createProject({
        title: input.title,
        columns: input.columns,
        description: input.description,
        projectType: input.projectType,
        scopes: [...new Set(input.scopes)],
        priority: input.priority,
        startDate: input.startDate,
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
        scopes: z.array(PROJECT_SCOPE).min(1, "Pick at least one scope").max(4).optional(),
        priority: PRIORITY.optional(),
        status: z.enum(["active", "on_hold", "completed", "archived"]).optional(),
        startDate: z.date().nullable().optional(),
        dueDate: z.date().nullable().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const current = await requireProjectAccess(ctx, input.id);
      const { id, ...updates } = input;
      const start = updates.startDate !== undefined ? updates.startDate : (current as any).startDate;
      const due = updates.dueDate !== undefined ? updates.dueDate : (current as any).dueDate;
      if (start && due && new Date(start) > new Date(due)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "The start date is after the due date" });
      }
      const saved = await fpb.updateProject(id, {
        ...updates,
        scopes: updates.scopes ? Array.from(new Set<string>(updates.scopes)) : undefined,
      });
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
      const found = await fpb.getTask(input.id);
      if (!found) throw new TRPCError({ code: "NOT_FOUND", message: "Task not found" });
      const task = found.task as any;
      const projectId = String(task.projectId);
      const project = await requireTaskAccess(ctx, task);
      try {
        // A column that stands for a stage (Backlog, In Progress, Done...)
        // moves the task's one status with it; others just reposition it.
        const columns = (await fpb.getColumns(projectId)) as any[];
        const fromColumn = columns.find(c => String(c.id) === String(task.columnId));
        const toColumn = columns.find(c => String(c.id) === input.columnId);
        const fromStatus = task.completed ? "done" : String(task.status ?? "todo");
        // Reordering within a column never changes the status, and a blocked
        // task stays blocked when it sits in an in-progress column.
        const changesColumn = Boolean(toColumn) && String(toColumn.id) !== String(task.columnId);
        let stage = changesColumn ? inferStage(String(toColumn.name)) : null;
        if (stage === "in_progress" && fromStatus === "blocked") stage = null;
        if (stage === "done" && fromStatus !== "done" && !(await mayFinish(ctx, task, project))) {
          throw new TRPCError({ code: "FORBIDDEN", message: NOT_FINISHER });
        }

        let moved = await fpb.moveTask(input.id, input.columnId, input.position);
        if (!moved) throw new TRPCError({ code: "NOT_FOUND", message: "Task not found" });
        const statusChanged = stage !== null && stage !== fromStatus;
        if (statusChanged) {
          moved = (await fpb.updateTask(input.id, { status: stage, completed: stage === "done" }, ctx.user.id)) ?? moved;
        }
        await fpb.logActivity(
          projectId,
          ctx.user.id,
          statusChanged ? "changed the status" : "moved task",
          moved.title as string,
          input.id,
          {
            fromColumn: fromColumn?.name,
            toColumn: toColumn?.name,
            ...(statusChanged ? { fromStatus, toStatus: stage! } : {}),
          }
        );
        if (statusChanged && stage === "done") {
          await notify([String(task.createdBy ?? "")], ctx.user.id, {
            title: "Task completed",
            message: `${ctx.user.name ?? "Someone"} completed "${moved.title}" in ${(project as any).title}.`,
            projectId,
            taskId: input.id,
            type: "task_completed",
          });
        }
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
      await requireTaskAccess(ctx, found.task);
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
        /**
         * The departments the task goes to. The project manager hands work to
         * departments, never straight to an employee; each head assigns it.
         */
        departmentIds: z.array(objectId).max(10).optional(),
        /** With more than one department: whose head has the final say. */
        ownerDepartmentId: objectId.optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const project = await requireProjectAccess(ctx, input.projectId);
      const departmentIds = [...new Set(input.departmentIds ?? [])];
      // Handing work to departments is the project manager's call.
      if (departmentIds.length > 0) await requireTaskManager(ctx, input.projectId);
      // Nobody but an admin puts someone else straight on a task: work reaches
      // people through their department head.
      if (input.assignedTo && input.assignedTo !== ctx.user.id && !isOrgWide(ctx.user.role)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Give the task to departments; their heads choose who works on it",
        });
      }
      let heads: string[] = [];
      let departmentNames = new Map<string, string>();
      if (departmentIds.length > 0) {
        if (input.assignedTo) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Give the task to departments; their heads choose who works on it",
          });
        }
        const all = await fpb.getDepartmentsWithHeads();
        const chosen = all.filter(d => departmentIds.includes(d.id));
        if (chosen.length !== departmentIds.length) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Unknown department" });
        }
        heads = chosen.map(d => d.headUserId).filter((id): id is string => Boolean(id));
        departmentNames = new Map(chosen.map(d => [d.id, d.name]));
      }
      // Same rules as editing a card: project people (and the departments'
      // heads) only, project labels only.
      const people = new Set([...projectPeople(project), ...heads]);
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
      let columnId = input.columnId;
      let ownerDepartmentId: string | null = null;
      if (departmentIds.length > 0) {
        ownerDepartmentId = resolveOwnerDepartment(departmentIds, input.ownerDepartmentId ?? null);
        // A department task starts in the backlog, on both boards.
        const columns = ((await fpb.getColumns(input.projectId)) as any[]).map(c => ({
          id: String(c.id), name: String(c.name), position: Number(c.position ?? 0),
        }));
        columnId = columnForStage(columns, "backlog") ?? columnId;
      }
      // Otherwise the card's status is the stage of the column it lands in.
      let initialStatus: string | undefined = departmentIds.length > 0 ? "backlog" : undefined;
      if (!initialStatus) {
        const columns = (await fpb.getColumns(input.projectId)) as any[];
        const landing = columnId
          ? columns.find(c => String(c.id) === columnId)
          : [...columns].sort((a, b) => Number(a.position ?? 0) - Number(b.position ?? 0))[0];
        initialStatus = (landing ? inferStage(String(landing.name)) : null) ?? "todo";
        if (initialStatus === "done") initialStatus = "todo";
      }
      const task = await fpb.createTask({
        ...input,
        columnId,
        departmentIds,
        ownerDepartmentId,
        status: initialStatus,
        createdBy: ctx.user.id,
      });
      if (heads.length > 0) {
        // The heads need the project open to work the task, and are on the card.
        await fpb.addProjectMembers(input.projectId, heads);
        await fpb.addTaskMembers(task.id, heads);
      }
      await fpb.logActivity(input.projectId, ctx.user.id, "added task", input.title, task.id, {
        toStatus: initialStatus,
      });
      if (departmentIds.length > 0) {
        const all = await fpb.getDepartmentsWithHeads();
        for (const d of all.filter(x => departmentIds.includes(x.id) && x.headUserId)) {
          await notify([d.headUserId!], ctx.user.id, {
            title: `New task for ${d.name}`,
            message: `"${input.title}" in ${(project as any).title} is in ${d.name}'s backlog. Assign it to someone in your team.`,
            projectId: input.projectId,
            taskId: task.id,
            type: "task_assigned",
          });
        }
        void departmentNames;
      }
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
        /** Shows the card's tracking timeline. History is recorded either way. */
        trackingEnabled: z.boolean().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const before = await fpb.getTask(input.id);
      if (!before) throw new TRPCError({ code: "NOT_FOUND", message: "Task not found" });
      const projectId = String((before.task as any).projectId);
      const project = await requireTaskAccess(ctx, before.task);
      const departmentTask = (((before.task as any).departmentIds ?? []) as unknown[]).length > 0;

      // On a department task the heads choose who works on it (admins too go
      // through assignForDepartment, so each department's assignee stays right).
      if (departmentTask && input.assignedTo !== undefined) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "This task belongs to departments: its department heads assign it",
        });
      }
      // Elsewhere nobody but an admin puts someone else on it.
      if (
        input.assignedTo &&
        input.assignedTo !== ctx.user.id &&
        !isOrgWide(ctx.user.role)
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Give the task to departments; their heads choose who works on it",
        });
      }

      // A card can only carry its own project's labels. Checked before any
      // stage change, so a refused edit changes nothing.
      if (input.labelIds) {
        input.labelIds = [...new Set<string>(input.labelIds)];
        const own = ((await fpb.getLabels(projectId)) as any[]).map(l => String(l.id));
        if (!labelsBelong(input.labelIds, own)) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Label does not belong to this project" });
        }
      }

      // A stage change goes through applyStage: one status for everyone, the
      // board column follows, and only the owner side may finish it.
      const wasDone = Boolean((before.task as any).completed) || (before.task as any).status === "done";
      let stage: string | undefined = input.status;
      if (stage === undefined && input.completed === true && !wasDone) stage = "done";
      if (stage === undefined && input.completed === false && wasDone) stage = "in_progress";
      let staged: any = null;
      if (stage !== undefined) {
        staged = (await applyStage(ctx, before.task, project, stage)) ?? null;
        input.status = undefined;
        input.completed = undefined;
      }

      const { id, ...updates } = input;
      // Only a stage change: applyStage has saved, logged and notified it.
      if (staged && Object.values(updates).every(v => v === undefined)) return staged;
      const saved = await fpb.updateTask(id, updates, ctx.user.id);
      const wasCompleted = staged ? Boolean(staged.completed) : Boolean((before.task as any).completed);
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

  // ==================== Departments on tasks ====================

  /** Every department and its head, for the task form. */
  getDepartments: protectedProcedure.query(async () => fpb.getDepartmentsWithHeads()),

  /**
   * Which departments a task goes to, and which one owns it. The project
   * manager's call; new departments' heads are added and told.
   */
  setTaskDepartments: protectedProcedure
    .input(
      z.object({
        taskId: objectId,
        departmentIds: z.array(objectId).min(1, "Pick at least one department").max(10),
        ownerDepartmentId: objectId.optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const found = await fpb.getTask(input.taskId);
      if (!found) throw new TRPCError({ code: "NOT_FOUND", message: "Task not found" });
      const task = found.task as any;
      const projectId = String(task.projectId);
      const project = await requireTaskManager(ctx, projectId);

      const departmentIds = [...new Set(input.departmentIds)];
      const all = await fpb.getDepartmentsWithHeads();
      const chosen = all.filter(d => departmentIds.includes(d.id));
      if (chosen.length !== departmentIds.length) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Unknown department" });
      }
      const owner = resolveOwnerDepartment(departmentIds, input.ownerDepartmentId ?? null);
      const before = new Set(((task.departmentIds ?? []) as unknown[]).map(String));
      let saved = await fpb.setTaskDepartments(input.taskId, departmentIds, owner);
      // A card handed to departments for the first time starts in their backlog.
      if (before.size === 0 && !task.completed && task.status !== "done" && task.status !== "backlog") {
        saved = (await applyStage(ctx, { ...task, departmentIds }, project, "backlog")) ?? saved;
      }

      const added = chosen.filter(d => !before.has(d.id));
      const newHeads = added.map(d => d.headUserId).filter((id): id is string => Boolean(id));
      if (newHeads.length > 0) {
        await fpb.addProjectMembers(projectId, newHeads);
        await fpb.addTaskMembers(input.taskId, newHeads);
      }
      await fpb.logActivity(
        projectId,
        ctx.user.id,
        "changed the departments",
        chosen.map(d => d.name).join(", "),
        input.taskId
      );
      for (const d of added.filter(x => x.headUserId)) {
        await notify([d.headUserId!], ctx.user.id, {
          title: `New task for ${d.name}`,
          message: `"${task.title}" in ${(project as any).title} is in ${d.name}'s backlog. Assign it to someone in your team.`,
          projectId,
          taskId: input.taskId,
          type: "task_assigned",
        });
      }
      return saved;
    }),

  /** The people a department head can put on a task: their department. */
  getDepartmentPeople: protectedProcedure
    .input(z.object({ departmentId: objectId }))
    .query(async ({ ctx, input }) => {
      if (!isOrgWide(ctx.user.role)) {
        const led = await departmentsLedBy(ctx.user.id);
        if (!led.includes(input.departmentId)) {
          throw new TRPCError({ code: "FORBIDDEN", message: "That is not your department" });
        }
      }
      return fpb.getDepartmentPeople(input.departmentId);
    }),

  /**
   * A department head puts someone from their department on a task (or takes
   * them off). Only the head of that department, or an admin.
   */
  assignForDepartment: protectedProcedure
    .input(z.object({ taskId: objectId, departmentId: objectId, userId: objectId.nullable() }))
    .mutation(async ({ ctx, input }) => {
      const found = await fpb.getTask(input.taskId);
      if (!found) throw new TRPCError({ code: "NOT_FOUND", message: "Task not found" });
      const task = found.task as any;
      const projectId = String(task.projectId);
      const taskDepartments = ((task.departmentIds ?? []) as unknown[]).map(String);
      if (!taskDepartments.includes(input.departmentId)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "This task is not with that department" });
      }
      const departments = await fpb.getDepartmentsWithHeads();
      const department = departments.find(d => d.id === input.departmentId);
      const isHead = department?.headUserId === ctx.user.id;
      if (!isHead && !isOrgWide(ctx.user.role)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Only that department's head can assign this task" });
      }
      if (input.userId) {
        const people = (await fpb.getDepartmentPeople(input.departmentId)).map(p => p.id);
        if (!people.includes(input.userId) && input.userId !== department?.headUserId) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "That person is not in this department" });
        }
      }
      const project = await fpb.getProject(projectId);
      if (!project) throw new TRPCError({ code: "NOT_FOUND", message: "Project not found" });

      const previous = ((task.assignees ?? []) as any[]).find(a => String(a.departmentId) === input.departmentId);
      const saved = await fpb.assignForDepartment(input.taskId, input.departmentId, input.userId);
      if (input.userId) {
        await fpb.addProjectMembers(projectId, [input.userId]);
        await fpb.addTaskMembers(input.taskId, [input.userId]);
      }
      const people = input.userId ? (await fpb.getBoardUsers()).find(u => u.id === input.userId) : null;
      await fpb.logActivity(
        projectId,
        ctx.user.id,
        input.userId ? "assigned the task" : "unassigned the task",
        `${department?.name ?? "Department"}${people ? `: ${people.name}` : ""}`,
        input.taskId
      );
      if (input.userId && String(previous?.userId ?? "") !== input.userId) {
        await notify([input.userId], ctx.user.id, {
          title: "Task assigned to you",
          message: `You have been assigned "${task.title}" in ${(project as any).title}.`,
          projectId,
          taskId: input.taskId,
          type: "task_assigned",
        });
      }
      return saved;
    }),

  /**
   * A department's board: every task handed to it across projects, by stage.
   * Heads see the departments they lead (and assign from here); people see
   * their own department's; admins any.
   */
  getDepartmentBoard: protectedProcedure
    .input(z.object({ departmentId: objectId.optional() }).optional())
    .query(async ({ ctx, input }) => {
      const all = await fpb.getDepartmentsWithHeads();
      const mine = await departmentsOf(ctx);
      const visible = isOrgWide(ctx.user.role) ? all : all.filter(d => mine.all.includes(d.id));
      if (visible.length === 0) {
        return { departments: [], department: null, tasks: [], people: [], canAssign: false };
      }
      const department =
        (input?.departmentId && visible.find(d => d.id === input.departmentId)) ||
        visible.find(d => mine.led.includes(d.id)) ||
        visible[0];
      if (input?.departmentId && department.id !== input.departmentId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "That is not your department" });
      }
      const canAssign = isOrgWide(ctx.user.role) || department.headUserId === ctx.user.id;
      const [tasks, people] = await Promise.all([
        fpb.getDepartmentBoardTasks(department.id),
        fpb.getDepartmentPeople(department.id),
      ]);
      return { departments: visible, department, tasks, people, canAssign };
    }),

  /** Moves a task to a stage from the department board (or anywhere without columns). */
  setTaskStage: protectedProcedure
    .input(z.object({ taskId: objectId, status: WORK_STATUS }))
    .mutation(async ({ ctx, input }) => {
      const found = await fpb.getTask(input.taskId);
      if (!found) throw new TRPCError({ code: "NOT_FOUND", message: "Task not found" });
      const project = await requireTaskAccess(ctx, found.task);
      return applyStage(ctx, found.task, project, input.status);
    }),

  /**
   * A card's tracking: every stage it went through, when and for how long,
   * and the full log of what happened to it.
   */
  getTaskTracking: protectedProcedure
    .input(z.object({ taskId: objectId }))
    .query(async ({ ctx, input }) => {
      const found = await fpb.getTask(input.taskId);
      if (!found) throw new TRPCError({ code: "NOT_FOUND", message: "Task not found" });
      const task = found.task as any;
      await requireTaskAccess(ctx, task);
      const events = await fpb.getTaskStatusEvents(input.taskId);
      const current = task.completed ? "done" : String(task.status ?? "todo");
      // The first entry without a "from" is the task being created (in its
      // first stage); older tasks start from the first change's "from".
      const creation = events[0] && !events[0].fromStatus ? events[0] : null;
      const initialStatus = creation ? creation.toStatus : events[0]?.fromStatus ?? current;
      const timeline = buildStageTimeline({
        createdAt: task.createdAt,
        initialStatus,
        events: creation ? events.slice(1) : events,
        now: new Date(),
      });
      const users = await fpb.getBoardUsers();
      const nameOf = new Map(users.map(u => [u.id, u.name]));
      return {
        ...timeline,
        events: events.map(e => ({ ...e, userName: nameOf.get(e.userId) ?? "Someone" })),
      };
    }),

  /**
   * The owner's KPIs per department for a month: work held, where it sits,
   * overdue, done on time, how fast, and how active. Admins only.
   */
  getDepartmentKpis: protectedProcedure
    .input(
      z.object({
        month: z.number().int().min(1).max(12),
        year: z.number().int().min(2020).max(2100),
      })
    )
    .query(async ({ ctx, input }) => {
      if (!isOrgWide(ctx.user.role)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Only admins can see every department" });
      }
      const { start, end } = getMonthRange(input.month, input.year);
      const now = new Date();
      const [departments, tasks, activity] = await Promise.all([
        fpb.getDepartmentsWithHeads(),
        fpb.getDepartmentKpiTasks(),
        fpb.countDepartmentActivity(new Date(now.getTime() - 7 * 86400000)),
      ]);
      return summarizeDepartmentKpis({
        departments: departments.map(d => ({ id: d.id, name: d.name, headName: d.headName })),
        tasks,
        activityCounts: activity,
        start,
        end,
        now,
      });
    }),

  /** One department's activity log: admins, or that department's head. */
  getDepartmentActivity: protectedProcedure
    .input(z.object({ departmentId: objectId, limit: z.number().int().min(1).max(200).default(50) }))
    .query(async ({ ctx, input }) => {
      if (!isOrgWide(ctx.user.role)) {
        const led = await departmentsLedBy(ctx.user.id);
        if (!led.includes(input.departmentId)) {
          throw new TRPCError({ code: "FORBIDDEN", message: "That is not your department" });
        }
      }
      return fpb.getDepartmentActivity(input.departmentId, input.limit);
    }),

  /** The caller's own tasks on the board (home page, reports). */
  getMyTasks: protectedProcedure.query(async ({ ctx }) => fpb.getPersonBoardTasks(ctx.user.id)),

  /** The caller's active projects and completed-task count (account page). */
  getMyStats: protectedProcedure.query(async ({ ctx }) => fpb.getPersonBoardStats(ctx.user.id)),

  /**
   * One person's projects and tasks, for reports: their own, or (for admins
   * and the person's department head) someone else's.
   */
  getPersonWork: protectedProcedure
    .input(z.object({ employeeId: objectId.optional() }).optional())
    .query(async ({ ctx, input }) => {
      const who = input?.employeeId ?? ctx.user.id;
      if (who !== ctx.user.id) await requireCanViewEmployee(ctx, who);
      const [tasks, projects] = await Promise.all([
        fpb.getPersonBoardTasks(who),
        fpb.getProjects({ visibleTo: who }),
      ]);
      return { tasks, projects };
    }),

  /** Work moving right now across the company, for the admin overview. */
  getOngoingTasks: protectedProcedure.query(async ({ ctx }) => {
    if (!isOrgWide(ctx.user.role)) {
      throw new TRPCError({ code: "FORBIDDEN", message: "Admin access required" });
    }
    return fpb.getOngoingBoardTasks();
  }),

  /** The caller's day on the board, for the clock-out dialog. */
  getMyDay: protectedProcedure.query(async ({ ctx }) =>
    fpb.getMyDayTasks(ctx.user.id, officeDayStart(new Date(), OFFSET_MINUTES))
  ),

  /**
   * Logs a piece of work done today, from the clock-out dialog: a card on one
   * of the caller's projects, assigned to them, in the stage they pick. Not for
   * department work: that comes from the project manager through the heads.
   */
  logMyWork: protectedProcedure
    .input(
      z.object({
        projectId: objectId,
        title: z.string().trim().min(1).max(500),
        done: z.boolean(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireProjectAccess(ctx, input.projectId);
      // Into the column for its stage, so the board and the status agree.
      const columns = ((await fpb.getColumns(input.projectId)) as any[]).map(c => ({
        id: String(c.id), name: String(c.name), position: Number(c.position ?? 0),
      }));
      const task = await fpb.createTask({
        projectId: input.projectId,
        title: input.title,
        assignedTo: ctx.user.id,
        createdBy: ctx.user.id,
        status: "in_progress",
        columnId: columnForStage(columns, input.done ? "done" : "in_progress") ?? undefined,
      });
      const saved = input.done
        ? await fpb.updateTask(task.id!, { status: "done", completed: true }, ctx.user.id)
        : task;
      await fpb.logActivity(input.projectId, ctx.user.id, "added task", input.title, task.id, {
        toStatus: input.done ? "done" : "in_progress",
      });
      return saved;
    }),

  // ==================== Subtasks ====================

  createSubtask: protectedProcedure
    .input(z.object({ taskId: objectId, title: z.string().min(1).max(500) }))
    .mutation(async ({ ctx, input }) => {
      const projectId = await requireTaskAccessById(ctx, input.taskId);
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
      const projectId = await requireTaskAccessById(ctx, String((found.subtask as any).taskId));
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
      // Department people working the task from their board can talk on it.
      const project = await requireTaskAccess(ctx, found.task);
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

  /**
   * The owner's view: every project grouped by the department that runs it,
   * with progress and overdue work. Admins and heads of operations only.
   */
  getOverview: protectedProcedure
    .input(z.object({ status: z.enum(["active", "on_hold", "completed", "archived"]).optional() }).optional())
    .query(async ({ ctx, input }) => {
      if (!isOrgWide(ctx.user.role)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Only admins can see every project" });
      }
      const [projects, tasks, users, departments] = await Promise.all([
        fpb.getProjects(input?.status ? { status: input.status } : undefined),
        fpb.getOverviewTasks(),
        fpb.getPeopleForMetrics(),
        listDepartments(),
      ]);
      return summarizeOverview({
        projects: (projects as any[]).map(p => ({
          id: String(p.id),
          title: p.title,
          projectType: p.projectType,
          scopes: p.scopes ?? [],
          status: p.status,
          priority: p.priority,
          startDate: p.startDate ?? null,
          dueDate: p.dueDate ?? null,
          createdBy: String(p.createdBy),
          memberIds: (p.memberIds ?? []).map(String),
          updatedAt: p.updatedAt ?? null,
        })),
        tasks,
        users,
        departments: departments.map(d => ({ id: d.id, name: d.name, headUserId: d.headUserId })),
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
