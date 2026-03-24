import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, protectedProcedure, router } from "./_core/trpc";
import { z } from "zod";
import * as db from "./db";
import { TRPCError } from "@trpc/server";
import { createSessionToken, setSessionCookie, verifySessionToken } from "./_core/auth";
import { authenticator } from "otplib";
import { toDataURL } from "qrcode";
import { emitChatMessage, emitNotification, emitAnnouncement } from "./_core/realtime";

export const appRouter = router({
  system: systemRouter,
  
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    
    logout: protectedProcedure.mutation(async ({ ctx }) => {
      const activeEntry = await db.getActiveTimeEntry(ctx.user.id);
      if (activeEntry) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Please clock out before logging out",
        });
      }
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return {
        success: true,
      } as const;
    }),

    // Custom login for Hassan and Talha
    customLogin: publicProcedure
      .input(z.object({
        employeeId: z.string(),
        password: z.string(),
      }))
      .mutation(async ({ input, ctx }) => {
        const user = await db.getUserByEmployeeIdAndPassword(input.employeeId, input.password);
        
        if (!user) {
          throw new TRPCError({
            code: "UNAUTHORIZED",
            message: "Invalid employee ID or password",
          });
        }

        if (user.role === "admin") {
          const fullUser = await db.getUserByIdWithSecret(user.id);
          if (!fullUser) {
            throw new TRPCError({
              code: "UNAUTHORIZED",
              message: "User not found",
            });
          }

          let twoFactorSecret = fullUser.twoFactorSecret as string | undefined;
          const twoFactorEnabled = Boolean(fullUser.twoFactorEnabled);
          let setupRequired = !twoFactorEnabled;
          let qrCodeDataUrl: string | undefined;

          if (!twoFactorSecret) {
            twoFactorSecret = authenticator.generateSecret();
            await db.setUserTwoFactorSecret(user.id, twoFactorSecret);
            setupRequired = true;
          }

          if (setupRequired && twoFactorSecret) {
            const label = fullUser.email || fullUser.employeeId || "admin";
            const otpauth = authenticator.keyuri(label, "RadFlow HRMS", twoFactorSecret);
            qrCodeDataUrl = await toDataURL(otpauth);
          }

          const twoFactorToken = await createSessionToken(user.id, {
            expiresInMs: 10 * 60 * 1000,
            purpose: "two_factor",
          });

          return {
            success: true,
            requiresTwoFactor: true,
            setupRequired,
            twoFactorToken,
            qrCodeDataUrl,
            secret: setupRequired ? twoFactorSecret : undefined,
          };
        }

        const maxAgeMs = 30 * 24 * 60 * 60 * 1000;
        const token = await createSessionToken(user.id, { expiresInMs: maxAgeMs });
        setSessionCookie(ctx.res, ctx.req, token, maxAgeMs);

        return {
          success: true,
          user: {
            id: user.id,
            name: user.name,
            email: user.email,
            employeeId: user.employeeId,
            department: user.department,
            position: user.position,
          },
        };
      }),

    verifyTwoFactor: publicProcedure
      .input(
        z.object({
          token: z.string(),
          code: z.string().min(4),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const { userId } = await verifySessionToken(input.token, "two_factor");
        const user = await db.getUserByIdWithSecret(userId);
        if (!user || user.role !== "admin") {
          throw new TRPCError({ code: "UNAUTHORIZED", message: "Unauthorized" });
        }

        const secret = user.twoFactorSecret as string | undefined;
        if (!secret) {
          throw new TRPCError({ code: "UNAUTHORIZED", message: "Two-factor not configured" });
        }

        const code = input.code.replace(/\s+/g, "");
        const isValid = authenticator.verify({ token: code, secret });
        if (!isValid) {
          throw new TRPCError({ code: "UNAUTHORIZED", message: "Invalid verification code" });
        }

        if (!user.twoFactorEnabled) {
          await db.setUserTwoFactorEnabled(userId, true);
        }

        const maxAgeMs = 30 * 24 * 60 * 60 * 1000;
        const token = await createSessionToken(userId, { expiresInMs: maxAgeMs });
        setSessionCookie(ctx.res, ctx.req, token, maxAgeMs);

        return { success: true };
      }),

    // Update user avatar
    updateAvatar: protectedProcedure
      .input(z.object({
        avatar: z.string(),
      }))
      .mutation(async ({ input, ctx }) => {
        await db.updateUserAvatar(ctx.user.id, input.avatar);
        return { success: true };
      }),

    // Change password
    changePassword: protectedProcedure
      .input(
        z.object({
          currentPassword: z.string().min(1, "Current password is required"),
          newPassword: z.string().min(6, "New password must be at least 6 characters"),
        })
      )
      .mutation(async ({ input, ctx }) => {
        if (input.currentPassword === input.newPassword) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "New password must be different from current password",
          });
        }

        const isValid = await db.verifyUserPassword(ctx.user.id, input.currentPassword);
        if (!isValid) {
          throw new TRPCError({
            code: "UNAUTHORIZED",
            message: "Invalid current password",
          });
        }

        await db.updateUserPassword(ctx.user.id, input.newPassword);
        return { success: true };
      }),

    resetPassword: protectedProcedure
      .input(
        z.object({
          id: z.string(),
          newPassword: z.string().min(6),
        })
      )
      .mutation(async ({ input, ctx }) => {
        if (ctx.user.role !== "admin") {
          throw new TRPCError({ code: "FORBIDDEN", message: "Admin access required" });
        }
        await db.updateUserPassword(input.id, input.newPassword);
        return { success: true };
      }),
  }),

  timeTracking: router({
    // Clock in
    clockIn: protectedProcedure
      .input(
        z
          .object({
            location: z
              .object({
                lat: z.number(),
                lng: z.number(),
                accuracy: z.number().optional(),
                address: z.string().optional(),
                source: z.enum(["gps", "manual"]).optional(),
              })
              .optional(),
          })
          .optional()
      )
      .mutation(async ({ ctx, input }) => {
      const activeEntry = await db.getActiveTimeEntry(ctx.user.id);
      
      if (activeEntry) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "You are already clocked in",
        });
      }

      await db.createTimeEntry({
        userId: ctx.user.id,
        timeIn: new Date(),
        status: "active",
        location: input?.location
          ? { ...input.location, capturedAt: new Date() }
          : undefined,
      });

      return { success: true };
    }),

    // Clock out
    clockOut: protectedProcedure
      .input(z.object({
        notes: z.string().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const activeEntry = await db.getActiveTimeEntry(ctx.user.id);
        
        if (!activeEntry) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "No active time entry found",
          });
        }

        const timeOut = new Date();
        const timeIn = new Date(activeEntry.timeIn);
        const totalHours = (timeOut.getTime() - timeIn.getTime()) / (1000 * 60 * 60);
        
        const status = totalHours < 6.5 ? "early_out" : "completed";

        await db.updateTimeEntry(activeEntry.id, {
          timeOut,
          totalHours: Number(totalHours.toFixed(2)),
          status,
          notes: input.notes,
        });

        return { 
          success: true, 
          totalHours: parseFloat(totalHours.toFixed(2)),
          status,
        };
      }),

    // Add work session (manual entry after clock out)
    addWorkSession: protectedProcedure
      .input(
        z.object({
          startTime: z.date(),
          endTime: z.date(),
          sessionType: z.enum(["remote", "onsite"]).default("remote"),
          description: z.string().optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const activeEntry = await db.getActiveTimeEntry(ctx.user.id);
        if (activeEntry) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Please clock out before adding a work session",
          });
        }

        if (input.endTime <= input.startTime) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "End time must be after start time",
          });
        }

        const session = await db.createWorkSession({
          userId: ctx.user.id,
          startTime: input.startTime,
          endTime: input.endTime,
          sessionType: input.sessionType,
          description: input.description,
        });

        return { success: true, session };
      }),

    // Add overtime entry (current day or previous day only)
    addOvertime: protectedProcedure
      .input(
        z.object({
          workDate: z.date(),
          hours: z.number().positive(),
          projectId: z.string(),
          taskId: z.string(),
          description: z.string().optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const today = new Date();
        const startToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
        const startYesterday = new Date(startToday);
        startYesterday.setDate(startYesterday.getDate() - 1);
        const workDateStart = new Date(input.workDate.getFullYear(), input.workDate.getMonth(), input.workDate.getDate());

        if (workDateStart < startYesterday || workDateStart > startToday) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Overtime can only be added for today or yesterday",
          });
        }

        const entry = await db.createOvertimeEntry({
          userId: ctx.user.id,
          projectId: input.projectId,
          taskId: input.taskId,
          workDate: workDateStart,
          hours: input.hours,
          description: input.description,
        });

        return { success: true, entry };
      }),

    // Get overtime entries for date range
    getOvertimeByRange: protectedProcedure
      .input(
        z.object({
          startDate: z.date(),
          endDate: z.date(),
        })
      )
      .query(async ({ input, ctx }) => {
        return await db.getOvertimeEntriesByDateRange(ctx.user.id, input.startDate, input.endDate);
      }),

    // Get active time entry
    getActive: protectedProcedure.query(async ({ ctx }) => {
      const activeEntry = await db.getActiveTimeEntry(ctx.user.id);
      return activeEntry || null;
    }),

    // Update location for active time entry
    updateLocation: protectedProcedure
      .input(
        z.object({
          location: z.object({
            lat: z.number(),
            lng: z.number(),
            accuracy: z.number().optional(),
            address: z.string().optional(),
            source: z.enum(["gps", "manual"]).optional(),
          }),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const activeEntry = await db.getActiveTimeEntry(ctx.user.id);
        if (!activeEntry) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "No active time entry found",
          });
        }

        await db.updateTimeEntry(activeEntry.id, {
          location: { ...input.location, capturedAt: new Date() },
        });

        return { success: true };
      }),

    // Start break
    startBreak: protectedProcedure
      .input(z.object({
        reason: z.enum(["Smoke", "Meeting", "Lunch", "Outgoing", "Sleeping"]),
      }))
      .mutation(async ({ ctx, input }) => {
      const activeEntry = await db.getActiveTimeEntry(ctx.user.id);
      
      if (!activeEntry) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "No active time entry found",
        });
      }

      const activeBreak = await db.getActiveBreak(activeEntry.id);
      if (activeBreak) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Break already in progress",
        });
      }

      await db.createBreakLog({
        timeEntryId: activeEntry.id,
        userId: ctx.user.id,
        breakStart: new Date(),
        reason: input.reason,
      });

      return { success: true };
    }),

    // End break
    endBreak: protectedProcedure.mutation(async ({ ctx }) => {
      const activeEntry = await db.getActiveTimeEntry(ctx.user.id);
      
      if (!activeEntry) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "No active time entry found",
        });
      }

      const activeBreak = await db.getActiveBreak(activeEntry.id);
      if (!activeBreak) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "No active break found",
        });
      }

      const breakEnd = new Date();
      const breakStart = new Date(activeBreak.breakStart);
      const duration = Math.floor((breakEnd.getTime() - breakStart.getTime()) / (1000 * 60));

      await db.updateBreakLog(activeBreak.id, {
        breakEnd,
        duration,
      });

      return { success: true, duration };
    }),

    // Get break logs for current session
    getBreakLogs: protectedProcedure.query(async ({ ctx }) => {
      const activeEntry = await db.getActiveTimeEntry(ctx.user.id);
      
      if (!activeEntry) {
        return [];
      }

      return await db.getBreakLogsByTimeEntry(activeEntry.id);
    }),

    // Get attendance for date range
    getAttendance: protectedProcedure
      .input(z.object({
        startDate: z.date(),
        endDate: z.date(),
      }))
      .query(async ({ input, ctx }) => {
        return await db.getTimeEntriesByDateRange(ctx.user.id, input.startDate, input.endDate);
      }),

    // Get completed tasks for today
    getCompletedTasksForToday: protectedProcedure.query(async ({ ctx }) => {
      return await db.getCompletedTasksForUserByDate(ctx.user.id, new Date());
    }),
  }),

  leaves: router({
    // Submit leave application
    submit: protectedProcedure
      .input(z.object({
        leaveType: z.enum(["sick", "casual", "annual", "unpaid", "other"]),
        startDate: z.date(),
        endDate: z.date(),
        reason: z.string(),
      }))
      .mutation(async ({ input, ctx }) => {
        await db.createLeaveApplication({
          userId: ctx.user.id,
          ...input,
        });

        return { success: true };
      }),

    // Get user's leave applications
    getMyLeaves: protectedProcedure.query(async ({ ctx }) => {
      return await db.getLeaveApplicationsByUser(ctx.user.id);
    }),
  }),

  forms: router({
    // Submit form (resignation, grievance, feedback)
    submit: protectedProcedure
      .input(z.object({
        formType: z.enum(["resignation", "leave", "grievance", "feedback"]),
        subject: z.string(),
        content: z.string(),
        priority: z.enum(["low", "medium", "high"]).optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        await db.createFormSubmission({
          userId: ctx.user.id,
          ...input,
        });

        return { success: true };
      }),

    // Get user's form submissions
    getMyForms: protectedProcedure.query(async ({ ctx }) => {
      return await db.getFormSubmissionsByUser(ctx.user.id);
    }),
  }),

  chat: router({
    // Send message
    send: protectedProcedure
      .input(z.object({
        message: z.string(),
        recipientId: z.string().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        await db.createChatMessage({
          senderId: ctx.user.id,
          recipientId: input.recipientId,
          message: input.message,
        });

        emitChatMessage({
          senderId: ctx.user.id,
          recipientId: input.recipientId,
        });

        return { success: true };
      }),

    // Get messages
    getMessages: protectedProcedure
      .input(z.object({
        limit: z.number().optional(),
      }))
      .query(async ({ input, ctx }) => {
        const messages = await db.getChatMessages(ctx.user.id, input.limit);
        const users = await db.getAllUsers();
        
        return messages.map(msg => ({
          ...msg,
          sender: users.find(u => u.id === msg.senderId),
        }));
      }),

    // Mark message as read
    markRead: protectedProcedure
      .input(z.object({
        messageId: z.string(),
      }))
      .mutation(async ({ input }) => {
        await db.markMessageAsRead(input.messageId);
        return { success: true };
      }),
  }),

  notes: router({
    list: protectedProcedure.query(async ({ ctx }) => {
      return await db.getNotesByUser(ctx.user.id);
    }),

    create: protectedProcedure
      .input(
        z.object({
          title: z.string().min(1),
          content: z.string().optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const created = await db.createNote({
          userId: ctx.user.id,
          title: input.title,
          content: input.content || "",
        });
        return { success: true, note: created };
      }),

    update: protectedProcedure
      .input(
        z.object({
          id: z.string(),
          title: z.string().optional(),
          content: z.string().optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const updated = await db.updateNote(input.id, ctx.user.id, {
          title: input.title,
          content: input.content,
        });
        if (!updated) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Note not found" });
        }
        return { success: true, note: updated };
      }),

    delete: protectedProcedure
      .input(z.object({ id: z.string() }))
      .mutation(async ({ input, ctx }) => {
        await db.deleteNote(input.id, ctx.user.id);
        return { success: true };
      }),
  }),

  dashboard: router({
    // Get payslip
    getPayslip: protectedProcedure.query(async ({ ctx }) => {
      const payslip = await db.getLatestPayslip(ctx.user.id);
      return payslip || null;
    }),

    // Get payslip history
    getPayslips: protectedProcedure.query(async ({ ctx }) => {
      return await db.getPayslipsByUser(ctx.user.id);
    }),

    // Get announcements
    getAnnouncements: protectedProcedure.query(async () => {
      const announcements = await db.getActiveAnnouncements();
      return announcements || [];
    }),

    // Get announcement read IDs for current user
    getAnnouncementReadIds: protectedProcedure.query(async ({ ctx }) => {
      return await db.getAnnouncementReadIds(ctx.user.id);
    }),

    // Mark announcement as read
    markAnnouncementRead: protectedProcedure
      .input(z.object({ announcementId: z.string() }))
      .mutation(async ({ input, ctx }) => {
        await db.markAnnouncementAsRead(input.announcementId, ctx.user.id);
        return { success: true };
      }),

    // Get all users for chat
    getUsers: protectedProcedure.query(async () => {
      return await db.getAllUsers();
    }),
  }),

  projects: router({
    // Get user's projects
    getMyProjects: protectedProcedure.query(async ({ ctx }) => {
      return await db.getUserProjects(ctx.user.id);
    }),

    // Get user's tasks across projects
    getMyTasks: protectedProcedure.query(async ({ ctx }) => {
      return await db.getTasksByEmployee(ctx.user.id);
    }),

    // Get project tasks
    getTasks: protectedProcedure
      .input(z.object({
        projectId: z.string(),
      }))
      .query(async ({ input, ctx }) => {
        return await db.getProjectTasks(input.projectId, ctx.user.id);
      }),

    // Create custom project (employee-created)
    createCustomProject: protectedProcedure
      .input(z.object({
        name: z.string(),
        description: z.string().optional(),
        priority: z.enum(["low", "medium", "high"]).optional(),
        employeeIds: z.array(z.string()).optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const projectId = await db.createProject({
          name: input.name,
          description: input.description,
          priority: input.priority || "medium",
          status: "active",
          source: "employee",
          createdBy: ctx.user.id,
        });

        const uniqueEmployeeIds = new Set<string>([
          ctx.user.id,
          ...(input.employeeIds || []),
        ]);

        for (const userId of uniqueEmployeeIds) {
          await db.assignUserToProject(projectId, userId);
        }

        return { success: true, projectId };
      }),

    // Create task
    createTask: protectedProcedure
      .input(z.object({
        projectId: z.string(),
        title: z.string(),
        description: z.string().optional(),
        priority: z.enum(["low", "medium", "high"]).optional(),
        status: z.enum(["todo", "in_progress", "completed", "blocked"]).optional(),
        timeEntryId: z.string().optional(),
        assigneeIds: z.array(z.string()).optional(),
        completionDate: z.date().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const created = await db.createProjectTask({
          projectId: input.projectId,
          userId: ctx.user.id,
          title: input.title,
          description: input.description,
          priority: input.priority || "medium",
          status: input.status || "todo",
          completedAt: input.status === "completed" ? new Date() : undefined,
          timeEntryId: input.timeEntryId,
          assigneeIds: input.assigneeIds,
          completionDate: input.completionDate,
        });

        return { success: true, task: created };
      }),

    // Update task
    updateTask: protectedProcedure
      .input(z.object({
        taskId: z.string(),
        status: z.enum(["todo", "in_progress", "completed", "blocked"]).optional(),
        title: z.string().optional(),
        description: z.string().optional(),
        priority: z.enum(["low", "medium", "high"]).optional(),
        completionDate: z.date().optional(),
      }))
      .mutation(async ({ input }) => {
        const { taskId, ...updates } = input;
        
        const updateData: any = { ...updates };
        if (updates.status === "completed") {
          updateData.completedAt = new Date();
        }

        await db.updateProjectTask(taskId, updateData);
        return { success: true };
      }),

    // Get project stats
    getStats: protectedProcedure.query(async ({ ctx }) => {
      return await db.getProjectStats(ctx.user.id);
    }),

    // Get task completion stats for current user
    getMyTaskStats: protectedProcedure.query(async ({ ctx }) => {
      return await db.getTaskStatsForUser(ctx.user.id);
    }),
  }),

  notifications: router({
    // Get all notifications for current user
    getAll: protectedProcedure.query(async ({ ctx }) => {
      return await db.getNotifications(ctx.user.id);
    }),

    // Get unread count
    getUnreadCount: protectedProcedure.query(async ({ ctx }) => {
      return await db.getUnreadNotificationCount(ctx.user.id);
    }),

    // Mark notification as read
    markAsRead: protectedProcedure
      .input(z.object({ notificationId: z.string() }))
      .mutation(async ({ input, ctx }) => {
        await db.markNotificationAsRead(input.notificationId, ctx.user.id);
        return { success: true };
      }),

    // Mark all as read
    markAllAsRead: protectedProcedure.mutation(async ({ ctx }) => {
      await db.markAllNotificationsAsRead(ctx.user.id);
      return { success: true };
    }),

    // Delete notification
    delete: protectedProcedure
      .input(z.object({ notificationId: z.string() }))
      .mutation(async ({ input, ctx }) => {
        await db.deleteNotification(input.notificationId, ctx.user.id);
        return { success: true };
      }),

     // Create notification (used internally by other procedures)
    create: protectedProcedure
      .input(z.object({
        userId: z.string(),
        type: z.enum(["project_assigned", "attendance_issue", "hours_shortfall", "leave_approved", "leave_rejected", "announcement", "system_alert"]),
        title: z.string(),
        message: z.string(),
        priority: z.enum(["low", "medium", "high"]).default("medium"),
        relatedId: z.string().optional(),
        relatedType: z.string().optional(),
      }))
      .mutation(async ({ input }) => {
        await db.createNotification(input);
        emitNotification({ userId: input.userId });
        return { success: true };
      }),
  }),

  employees: router({
    list: protectedProcedure.query(async ({ ctx }) => {
      if (ctx.user.role !== "admin") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Admin access required" });
      }
      return await db.getAllUsers();
    }),

    create: protectedProcedure
      .input(
        z.object({
          name: z.string().min(1),
          email: z.string().email(),
          employeeId: z.string().min(1),
          password: z.string().min(6),
          department: z.string().min(1),
          position: z.string().min(1),
          cnicFrontUrl: z.string().optional(),
          cnicBackUrl: z.string().optional(),
          offerLetterUrl: z.string().optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        if (ctx.user.role !== "admin") {
          throw new TRPCError({ code: "FORBIDDEN", message: "Admin access required" });
        }

        try {
          const employee = await db.createEmployee({
            name: input.name,
            email: input.email,
            employeeId: input.employeeId,
            password: input.password,
            department: input.department,
            position: input.position,
          });

          if (input.cnicFrontUrl) {
            await db.upsertEmployeeDocument({
              userId: employee!.id,
              documentType: "id_proof_front",
              title: "CNIC Front",
              documentUrl: input.cnicFrontUrl,
              uploadedBy: ctx.user.id,
            });
          }

          if (input.cnicBackUrl) {
            await db.upsertEmployeeDocument({
              userId: employee!.id,
              documentType: "id_proof_back",
              title: "CNIC Back",
              documentUrl: input.cnicBackUrl,
              uploadedBy: ctx.user.id,
            });
          }

          if (input.offerLetterUrl) {
            await db.upsertEmployeeDocument({
              userId: employee!.id,
              documentType: "offer_letter",
              title: "Job Offer Letter",
              documentUrl: input.offerLetterUrl,
              uploadedBy: ctx.user.id,
            });
          }

          return employee;
        } catch (error: any) {
          if (error?.code === 11000) {
            throw new TRPCError({
              code: "CONFLICT",
              message: "Employee ID or email already exists",
            });
          }
          throw error;
        }
      }),

    update: protectedProcedure
      .input(
        z.object({
          id: z.string(),
          name: z.string().optional(),
          email: z.string().email().optional(),
          employeeId: z.string().optional(),
          password: z.string().min(6).optional(),
          department: z.string().optional(),
          position: z.string().optional(),
          cnicFrontUrl: z.string().optional(),
          cnicBackUrl: z.string().optional(),
          offerLetterUrl: z.string().optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        if (ctx.user.role !== "admin") {
          throw new TRPCError({ code: "FORBIDDEN", message: "Admin access required" });
        }

        try {
          const { id, cnicFrontUrl, cnicBackUrl, offerLetterUrl, ...updates } = input;
          const employee = await db.updateEmployee(id, updates);

          if (cnicFrontUrl) {
            await db.upsertEmployeeDocument({
              userId: id,
              documentType: "id_proof_front",
              title: "CNIC Front",
              documentUrl: cnicFrontUrl,
              uploadedBy: ctx.user.id,
            });
          }

          if (cnicBackUrl) {
            await db.upsertEmployeeDocument({
              userId: id,
              documentType: "id_proof_back",
              title: "CNIC Back",
              documentUrl: cnicBackUrl,
              uploadedBy: ctx.user.id,
            });
          }

          if (offerLetterUrl) {
            await db.upsertEmployeeDocument({
              userId: id,
              documentType: "offer_letter",
              title: "Job Offer Letter",
              documentUrl: offerLetterUrl,
              uploadedBy: ctx.user.id,
            });
          }

          return employee;
        } catch (error: any) {
          if (error?.code === 11000) {
            throw new TRPCError({
              code: "CONFLICT",
              message: "Employee ID or email already exists",
            });
          }
          throw error;
        }
      }),
  }),

  admin: router({
    getLeaveRequests: protectedProcedure.query(async ({ ctx }) => {
      if (ctx.user.role !== "admin") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Admin access required" });
      }
      return await db.getAllLeaveApplicationsWithUsers();
    }),

    updateLeaveRequest: protectedProcedure
      .input(
        z.object({
          id: z.string(),
          status: z.enum(["pending", "approved", "rejected"]),
          rejectionReason: z.string().optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        if (ctx.user.role !== "admin") {
          throw new TRPCError({ code: "FORBIDDEN", message: "Admin access required" });
        }
        await db.updateLeaveApplicationStatus(input.id, input.status, ctx.user.id, input.rejectionReason);
        return { success: true };
      }),

    getFormSubmissions: protectedProcedure.query(async ({ ctx }) => {
      if (ctx.user.role !== "admin") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Admin access required" });
      }
      return await db.getAllFormSubmissionsWithUsers();
    }),

    updateFormSubmission: protectedProcedure
      .input(
        z.object({
          id: z.string(),
          status: z.enum(["submitted", "under_review", "resolved", "closed"]),
          response: z.string().optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        if (ctx.user.role !== "admin") {
          throw new TRPCError({ code: "FORBIDDEN", message: "Admin access required" });
        }
        await db.updateFormSubmissionStatus(input.id, input.status, ctx.user.id, input.response);
        return { success: true };
      }),

    getProjectsOverview: protectedProcedure.query(async ({ ctx }) => {
      if (ctx.user.role !== "admin") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Admin access required" });
      }
      return await db.getProjectsWithAssignments();
    }),

    getProjectTasks: protectedProcedure
      .input(z.object({ projectId: z.string() }))
      .query(async ({ input, ctx }) => {
        if (ctx.user.role !== "admin") {
          throw new TRPCError({ code: "FORBIDDEN", message: "Admin access required" });
        }
        return await db.getAllProjectTasks(input.projectId);
      }),

    createTaskForProject: protectedProcedure
      .input(
        z.object({
          projectId: z.string(),
          title: z.string().min(1),
          description: z.string().optional(),
          priority: z.enum(["low", "medium", "high"]).optional(),
          status: z.enum(["todo", "in_progress", "completed", "blocked"]).optional(),
          assigneeIds: z.array(z.string()).min(1, "Select at least one assignee"),
          completionDate: z.date().optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        if (ctx.user.role !== "admin") {
          throw new TRPCError({ code: "FORBIDDEN", message: "Admin access required" });
        }
        const created = await db.createProjectTask({
          projectId: input.projectId,
          userId: ctx.user.id,
          title: input.title,
          description: input.description,
          priority: input.priority || "medium",
          status: input.status || "todo",
          completedAt: input.status === "completed" ? new Date() : undefined,
          assigneeIds: input.assigneeIds,
          completionDate: input.completionDate,
        });
        return { success: true, task: created };
      }),

    updateTaskForProject: protectedProcedure
      .input(
        z.object({
          taskId: z.string(),
          title: z.string().optional(),
          description: z.string().optional(),
          priority: z.enum(["low", "medium", "high"]).optional(),
          status: z.enum(["todo", "in_progress", "completed", "blocked"]).optional(),
          assigneeIds: z.array(z.string()).optional(),
          completionDate: z.date().optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        if (ctx.user.role !== "admin") {
          throw new TRPCError({ code: "FORBIDDEN", message: "Admin access required" });
        }
        const { taskId, ...updates } = input;
        const updateData: any = { ...updates };
        if (updates.status === "completed") {
          updateData.completedAt = new Date();
        }
        await db.updateProjectTask(taskId, updateData);
        return { success: true };
      }),

    getEmployeeProjects: protectedProcedure
      .input(z.object({ employeeId: z.string() }))
      .query(async ({ input, ctx }) => {
        if (ctx.user.role !== "admin") {
          throw new TRPCError({ code: "FORBIDDEN", message: "Admin access required" });
        }
        return await db.getProjectsForEmployee(input.employeeId);
      }),

    getEmployeeTasks: protectedProcedure
      .input(z.object({ employeeId: z.string() }))
      .query(async ({ input, ctx }) => {
        if (ctx.user.role !== "admin") {
          throw new TRPCError({ code: "FORBIDDEN", message: "Admin access required" });
        }
        return await db.getTasksByEmployee(input.employeeId);
      }),

    getResourcePerformance: protectedProcedure.query(async ({ ctx }) => {
      if (ctx.user.role !== "admin") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Admin access required" });
      }
      return await db.getResourcePerformance();
    }),

    deleteProject: protectedProcedure
      .input(z.object({ id: z.string() }))
      .mutation(async ({ input, ctx }) => {
        if (ctx.user.role !== "admin") {
          throw new TRPCError({ code: "FORBIDDEN", message: "Admin access required" });
        }
        await db.deleteProject(input.id);
        return { success: true };
      }),

    deleteTask: protectedProcedure
      .input(z.object({ id: z.string() }))
      .mutation(async ({ input, ctx }) => {
        if (ctx.user.role !== "admin") {
          throw new TRPCError({ code: "FORBIDDEN", message: "Admin access required" });
        }
        await db.deleteProjectTask(input.id);
        return { success: true };
      }),

    getTasksByDate: protectedProcedure
      .input(z.object({ date: z.date() }))
      .query(async ({ input, ctx }) => {
        if (ctx.user.role !== "admin") {
          throw new TRPCError({ code: "FORBIDDEN", message: "Admin access required" });
        }
        const start = new Date(input.date);
        start.setHours(0, 0, 0, 0);
        const end = new Date(input.date);
        end.setHours(23, 59, 59, 999);
        return await db.getTasksCreatedByDate(start, end);
      }),

    assignProject: protectedProcedure
      .input(
        z.object({
          name: z.string().min(1),
          description: z.string().optional(),
          priority: z.enum(["low", "medium", "high"]).default("medium"),
          employeeIds: z.array(z.string()).min(1),
          startDate: z.date().optional(),
          endDate: z.date().optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        if (ctx.user.role !== "admin") {
          throw new TRPCError({ code: "FORBIDDEN", message: "Admin access required" });
        }
        const projectId = await db.createProject({
          name: input.name,
          description: input.description,
          priority: input.priority,
          status: "active",
          source: "team_lead",
          createdBy: ctx.user.id,
          startDate: input.startDate,
          endDate: input.endDate,
        });
        for (const userId of input.employeeIds) {
          await db.assignUserToProject(projectId, userId);
          await db.createNotification({
            userId,
            type: "project_assigned",
            title: "New project assigned",
            message: `You have been assigned to ${input.name}.`,
            priority: "medium",
            relatedId: projectId,
            relatedType: "project",
          });
          emitNotification({ userId });
        }
        return { success: true, projectId };
      }),

    getOngoingTasks: protectedProcedure.query(async ({ ctx }) => {
      if (ctx.user.role !== "admin") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Admin access required" });
      }
      return await db.getOngoingTasksWithAssignments();
    }),

    getEmployeeStatusSnapshot: protectedProcedure.query(async ({ ctx }) => {
      if (ctx.user.role !== "admin") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Admin access required" });
      }
      return await db.getEmployeeStatusSnapshot();
    }),

    getAverageHours: protectedProcedure
      .input(z.object({ days: z.number().optional() }))
      .query(async ({ input, ctx }) => {
        if (ctx.user.role !== "admin") {
          throw new TRPCError({ code: "FORBIDDEN", message: "Admin access required" });
        }
        return await db.getAverageHoursByDay(input.days ?? 5);
      }),

    getTimeEntriesByRange: protectedProcedure
      .input(
        z.object({
          startDate: z.date(),
          endDate: z.date(),
        })
      )
      .query(async ({ input, ctx }) => {
        if (ctx.user.role !== "admin") {
          throw new TRPCError({ code: "FORBIDDEN", message: "Admin access required" });
        }
        return await db.getTimeEntriesByRangeForAll(input.startDate, input.endDate);
      }),

    getEmployeeAttendance: protectedProcedure
      .input(
        z.object({
          employeeId: z.string(),
          startDate: z.date(),
          endDate: z.date(),
        })
      )
      .query(async ({ input, ctx }) => {
        if (ctx.user.role !== "admin") {
          throw new TRPCError({ code: "FORBIDDEN", message: "Admin access required" });
        }
        return await db.getTimeEntriesByDateRange(input.employeeId, input.startDate, input.endDate);
      }),

    getPayslips: protectedProcedure.query(async ({ ctx }) => {
      if (ctx.user.role !== "admin") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Admin access required" });
      }
      return await db.getAllPayslipsWithUsers();
    }),

    getAnnouncements: protectedProcedure.query(async ({ ctx }) => {
      if (ctx.user.role !== "admin") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Admin access required" });
      }
      return await db.getAnnouncementsWithReadCounts();
    }),

    // Task completion stats (all tasks)
    getTaskStats: protectedProcedure.query(async ({ ctx }) => {
      if (ctx.user.role !== "admin") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Admin access required" });
      }
      return await db.getTaskStatsForAll();
    }),

    createAnnouncement: protectedProcedure
      .input(
        z.object({
          title: z.string().min(1),
          content: z.string().min(1),
          priority: z.enum(["low", "medium", "high"]).default("medium"),
        })
      )
      .mutation(async ({ input, ctx }) => {
        if (ctx.user.role !== "admin") {
          throw new TRPCError({ code: "FORBIDDEN", message: "Admin access required" });
        }
        const announcement = await db.createAnnouncement({
          title: input.title,
          content: input.content,
          priority: input.priority,
          createdBy: ctx.user.id,
        });

        const users = await db.getAllUsers();
        await Promise.all(
          users.map(async (user: any) => {
            await db.createNotification({
              userId: user.id,
              type: "announcement",
              title: input.title,
              message: input.content,
              priority: input.priority,
              relatedId: announcement?.id,
              relatedType: "announcement",
            });
            emitNotification({ userId: user.id });
          })
        );

        emitAnnouncement({ announcementId: announcement?.id });

        return announcement;
      }),

    deleteAnnouncement: protectedProcedure
      .input(z.object({ id: z.string() }))
      .mutation(async ({ input, ctx }) => {
        if (ctx.user.role !== "admin") {
          throw new TRPCError({ code: "FORBIDDEN", message: "Admin access required" });
        }
        await db.deleteAnnouncement(input.id);
        return { success: true };
      }),
  }),

  // ==================== MEETINGS ====================
  meetings: router({
    // Create a new meeting
    create: protectedProcedure
      .input(z.object({
        title: z.string(),
        description: z.string().optional(),
        agenda: z.string().optional(),
        startTime: z.date(),
        endTime: z.date(),
        location: z.string().optional(),
        meetingLink: z.string().optional(),
        participantIds: z.array(z.string()),
      }))
      .mutation(async ({ input, ctx }) => {
        const { participantIds, ...meetingData } = input;
        
        // Create meeting
        const meeting = await db.createMeeting({
          ...meetingData,
          organizerId: ctx.user.id,
        });
        
        if (!meeting) throw new Error("Failed to create meeting");
        
        // Add participants
        for (const userId of participantIds) {
          await db.addMeetingParticipant({
            meetingId: meeting.id,
            userId,
            responseStatus: "pending",
          });
        }
        
        return meeting;
      }),

    // Get user's meetings
    getMyMeetings: protectedProcedure.query(async ({ ctx }) => {
      const meetings = await db.getMeetingsByUserId(ctx.user.id);
      return meetings;
    }),

    // Get meeting by ID with participants
    getById: protectedProcedure
      .input(z.object({ id: z.string() }))
      .query(async ({ input }) => {
        const meeting = await db.getMeetingById(input.id);
        if (!meeting) throw new TRPCError({ code: "NOT_FOUND" });
        
        const participants = await db.getMeetingParticipants(input.id);
        return { meeting, participants };
      }),

    // Update meeting response
    updateResponse: protectedProcedure
      .input(z.object({
        meetingId: z.string(),
        responseStatus: z.enum(["accepted", "declined", "tentative"]),
      }))
      .mutation(async ({ input, ctx }) => {
        await db.updateParticipantResponse(input.meetingId, ctx.user.id, input.responseStatus);
        return { success: true };
      }),

    // Update meeting details
    update: protectedProcedure
      .input(z.object({
        id: z.string(),
        title: z.string().optional(),
        description: z.string().optional(),
        agenda: z.string().optional(),
        startTime: z.date().optional(),
        endTime: z.date().optional(),
        location: z.string().optional(),
        meetingLink: z.string().optional(),
        status: z.enum(["scheduled", "in_progress", "completed", "cancelled"]).optional(),
      }))
      .mutation(async ({ input }) => {
        const { id, ...data } = input;
        await db.updateMeeting(id, data);
        return { success: true };
      }),

    // Add meeting minutes and action items
    addMinutes: protectedProcedure
      .input(z.object({
        meetingId: z.string(),
        meetingMinutes: z.string(),
        actionItems: z.string(),
      }))
      .mutation(async ({ input }) => {
        await db.updateMeeting(input.meetingId, {
          meetingMinutes: input.meetingMinutes,
          actionItems: input.actionItems,
          status: "completed",
        });
        return { success: true };
      }),

    // Delete meeting
    delete: protectedProcedure
      .input(z.object({ id: z.string() }))
      .mutation(async ({ input }) => {
        await db.deleteMeeting(input.id);
        return { success: true };
      }),
  }),

  // ==================== CALENDAR EVENTS ====================
  calendar: router({
    // Create calendar event
    createEvent: protectedProcedure
      .input(z.object({
        title: z.string(),
        description: z.string().optional(),
        startTime: z.date(),
        endTime: z.date(),
        eventType: z.enum(["reminder", "personal", "deadline", "holiday"]),
        isAllDay: z.boolean().default(false),
        participantIds: z.array(z.string()).optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const targets = new Set<string>([
          ctx.user.id,
          ...(input.participantIds || []),
        ]);

        let firstEvent: any = null;
        for (const userId of targets) {
          const created = await db.createCalendarEvent({
            title: input.title,
            description: input.description,
            startTime: input.startTime,
            endTime: input.endTime,
            eventType: input.eventType,
            isAllDay: input.isAllDay,
            userId,
          });
          if (!firstEvent) firstEvent = created;
        }

        return firstEvent;
      }),

    // Get user's calendar events
    getMyEvents: protectedProcedure.query(async ({ ctx }) => {
      const events = await db.getCalendarEventsByUserId(ctx.user.id);
      return events;
    }),

    // Get events by date range
    getEventsByDateRange: protectedProcedure
      .input(z.object({
        startDate: z.date(),
        endDate: z.date(),
      }))
      .query(async ({ input, ctx }) => {
        const events = await db.getCalendarEventsByDateRange(ctx.user.id, input.startDate, input.endDate);
        const meetings = await db.getMeetingsByDateRange(input.startDate, input.endDate);
        return { events, meetings };
      }),

    // Update calendar event
    updateEvent: protectedProcedure
      .input(z.object({
        id: z.string(),
        title: z.string().optional(),
        description: z.string().optional(),
        startTime: z.date().optional(),
        endTime: z.date().optional(),
        eventType: z.enum(["reminder", "personal", "deadline", "holiday"]).optional(),
        isAllDay: z.boolean().optional(),
      }))
      .mutation(async ({ input }) => {
        const { id, ...data } = input;
        await db.updateCalendarEvent(id, data);
        return { success: true };
      }),

    // Delete calendar event
    deleteEvent: protectedProcedure
      .input(z.object({ id: z.string() }))
      .mutation(async ({ input }) => {
        await db.deleteCalendarEvent(input.id);
        return { success: true };
      }),
  }),
});
export type AppRouter = typeof appRouter;
