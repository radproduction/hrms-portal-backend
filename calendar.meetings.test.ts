import { describe, it, expect } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { describeWithDb } from "./test-utils";

// Writes real documents, so it only runs against a throwaway TEST_MONGODB_URI.
describeWithDb("Calendar and Meeting System", () => {
  const mockContext = {
    user: {
      id: "000000000000000000000001",
      openId: "test-user",
      name: "Test User",
      email: "test@example.com",
      role: "user",
      employeeId: "EMP001",
    },
  } as unknown as TrpcContext;

  const caller = appRouter.createCaller(mockContext);

  describe("Meeting CRUD Operations", () => {
    it("should create a meeting", async () => {
      const meeting = await caller.meetings.create({
        title: "Team Standup",
        description: "Daily team sync",
        startTime: new Date("2026-02-20T09:00:00Z"),
        endTime: new Date("2026-02-20T09:30:00Z"),
        location: "Conference Room A",
        meetingLink: "https://meet.google.com/abc-defg-hij",
        agenda: "Discuss project progress",
        participantIds: ["000000000000000000000002", "000000000000000000000003"],
      });

      expect(meeting).toBeDefined();
      expect((meeting as any).title).toBe("Team Standup");
    });

    it("should get user's meetings", async () => {
      const meetings = await caller.meetings.getMyMeetings();
      expect(Array.isArray(meetings)).toBe(true);
    });

    it("should update meeting response status", async () => {
      const meeting = await caller.meetings.create({
        title: "Test Meeting",
        description: "Test",
        startTime: new Date("2026-02-21T10:00:00Z"),
        endTime: new Date("2026-02-21T11:00:00Z"),
        participantIds: ["000000000000000000000002"],
      });

      const result = await caller.meetings.updateResponse({
        meetingId: meeting.id,
        responseStatus: "accepted",
      });

      expect(result.success).toBe(true);
    });
  });

  describe("Calendar Events", () => {
    it("should create a calendar event", async () => {
      const event = await caller.calendar.createEvent({
        title: "Project Deadline",
        description: "HRMS Portal v1.0 release",
        startTime: new Date("2026-03-01T00:00:00Z"),
        endTime: new Date("2026-03-01T23:59:59Z"),
        eventType: "deadline",
      });

      expect(event).toBeDefined();
      expect((event as any).title).toBe("Project Deadline");
    });

    it("should get user's calendar events", async () => {
      // getEventsByDateRange returns { events, meetings }, not a bare array.
      const result = await caller.calendar.getEventsByDateRange({
        startDate: new Date("2026-02-01"),
        endDate: new Date("2026-03-31"),
      });

      expect(Array.isArray(result.events)).toBe(true);
      expect(Array.isArray(result.meetings)).toBe(true);
    });
  });
});
