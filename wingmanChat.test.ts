import { describe, expect, it } from "vitest";
import { findDates, parseIntent, parseLeave } from "./wingmanChat";

// Friday 2 October 2026.
const TODAY = "2026-10-02";

describe("findDates", () => {
  it("reads today, tomorrow and weekday names as the next such day", () => {
    expect(findDates("today", TODAY)).toEqual(["2026-10-02"]);
    expect(findDates("tomorrow please", TODAY)).toEqual(["2026-10-03"]);
    expect(findDates("on Monday", TODAY)).toEqual(["2026-10-05"]);
    // Asked on a Friday, "Friday" is next week's.
    expect(findDates("friday", TODAY)).toEqual(["2026-10-09"]);
  });

  it("reads day-month dates either way round and rolls past ones into next year", () => {
    expect(findDates("5 Oct", TODAY)).toEqual(["2026-10-05"]);
    expect(findDates("October 5th", TODAY)).toEqual(["2026-10-05"]);
    expect(findDates("3rd of march", TODAY)).toEqual(["2027-03-03"]);
    expect(findDates("2026-12-24", TODAY)).toEqual(["2026-12-24"]);
  });

  it("keeps one date when a day is named twice, and rejects dates that do not exist", () => {
    expect(findDates("Monday 5 October", TODAY)).toEqual(["2026-10-05"]);
    expect(findDates("31 November", TODAY)).toEqual([]);
    expect(findDates("2026-02-30", TODAY)).toEqual([]);
  });

  it("does not mistake the month of May or ordinary words for dates", () => {
    expect(findDates("I may need help", TODAY)).toEqual([]);
    expect(findDates("the sun is out and I sat down", TODAY)).toEqual([]);
    expect(findDates("Sunday", TODAY)).toEqual(["2026-10-04"]);
  });
});

describe("parseLeave", () => {
  it("drafts a half day for one morning", () => {
    expect(parseLeave("apply a half day for Monday morning", TODAY)).toEqual({
      leaveType: "casual", startKey: "2026-10-05", endKey: "2026-10-05", halfDay: "morning",
    });
  });

  it("reads the type, a range and a length", () => {
    expect(parseLeave("annual leave from 12 Oct to 16 Oct", TODAY)).toMatchObject({ leaveType: "annual", startKey: "2026-10-12", endKey: "2026-10-16", halfDay: null });
    expect(parseLeave("I am sick, leave tomorrow", TODAY)).toMatchObject({ leaveType: "sick", startKey: "2026-10-03", endKey: "2026-10-03" });
    expect(parseLeave("3 days leave from Monday", TODAY)).toMatchObject({ startKey: "2026-10-05", endKey: "2026-10-07" });
    expect(parseLeave("half day afternoon on 2026-10-08", TODAY)).toMatchObject({ halfDay: "afternoon", endKey: "2026-10-08" });
  });

  it("orders a backwards range and returns null without a date", () => {
    expect(parseLeave("leave 16 Oct to 12 Oct", TODAY)).toMatchObject({ startKey: "2026-10-12", endKey: "2026-10-16" });
    expect(parseLeave("I want leave", TODAY)).toBeNull();
  });
});

describe("parseIntent", () => {
  const kind = (text: string) => parseIntent(text, TODAY).kind;

  it("recognises the requests the Wingman page offers", () => {
    expect(kind("What is on my plate today?")).toBe("plate");
    expect(kind("Start my break")).toBe("break_start");
    expect(kind("end my break")).toBe("break_end");
    expect(kind("Log overtime")).toBe("overtime");
    expect(kind("Write my standup")).toBe("standup");
    expect(kind("clock me in")).toBe("clock_in");
    expect(kind("How much leave do I have left?")).toBe("leave_balance");
    expect(kind("when is payday")).toBe("payslip");
    expect(kind("how are my hours this month")).toBe("hours");
  });

  it("tells clocking out now from clocking out later", () => {
    expect(parseIntent("clock me out", TODAY)).toEqual({ kind: "clock_out", scheduled: false });
    expect(parseIntent("Clock me out at 7", TODAY)).toEqual({ kind: "clock_out", scheduled: true });
    expect(parseIntent("clock out in an hour", TODAY)).toEqual({ kind: "clock_out", scheduled: true });
  });

  it("prefers the specific request over the broad one", () => {
    // Mentions "tomorrow" and "today"-style words but is a leave request.
    expect(parseIntent("apply sick leave for tomorrow", TODAY)).toMatchObject({ kind: "leave", draft: { leaveType: "sick", startKey: "2026-10-03" } });
    expect(kind("leave left?")).toBe("leave_balance");
    // "Leaving" the office is not asking for leave.
    expect(kind("I am leaving, clock me out")).toBe("clock_out");
  });

  it("pulls the project and the ticket subject out of the sentence", () => {
    expect(parseIntent("How is Now HRMS doing?", TODAY)).toEqual({ kind: "project_health", project: "now hrms" });
    expect(parseIntent("status of the JBS project", TODAY)).toEqual({ kind: "project_health", project: "jbs" });
    expect(parseIntent("Raise a support ticket for a broken laptop charger", TODAY)).toEqual({ kind: "support_ticket", subject: "a broken laptop charger" });
    expect(parseIntent("Raise a support ticket", TODAY)).toEqual({ kind: "support_ticket", subject: "" });
    expect(kind("how is my day going")).not.toBe("project_health");
  });

  it("falls back to help for anything else, including nothing", () => {
    expect(kind("")).toBe("help");
    expect(kind("tell me a joke")).toBe("help");
  });
});
