import { describe, expect, it } from "vitest";
import {
  boardLink,
  canDeleteComment,
  isLabelColor,
  labelsBelong,
  mentionTargets,
  parseMentions,
  plainText,
  completionStamp,
  planColumnOrder,
  presentComment,
  safeImageExtension,
  taskAudience,
} from "./fpbRules";

/** Pure board rules: no database needed, so these always run. */
describe("planColumnOrder", () => {
  it("numbers the requested order 0..n-1", () => {
    expect(planColumnOrder(["a", "b", "c"], ["c", "a", "b"])).toEqual([
      { id: "c", position: 0 },
      { id: "a", position: 1 },
      { id: "b", position: 2 },
    ]);
  });

  it("refuses an order that leaves a column out", () => {
    expect(() => planColumnOrder(["a", "b", "c"], ["a", "b"])).toThrow(/every column/);
  });

  it("refuses a column from another project", () => {
    expect(() => planColumnOrder(["a", "b"], ["a", "x"])).toThrow(/every column/);
  });

  it("refuses a duplicate", () => {
    expect(() => planColumnOrder(["a", "b"], ["a", "a"])).toThrow(/twice/);
  });
});

describe("completionStamp", () => {
  const now = new Date("2026-11-02T10:00:00Z");

  it("credits the assignee, not whoever ticked the box", () => {
    expect(
      completionStamp({ wasCompleted: false, willBeCompleted: true, assigneeAfter: "emp", actorId: "lead", now })
    ).toEqual({ kind: "set", completedAt: now, completedBy: "emp" });
  });

  it("credits the person completing it when nobody is assigned", () => {
    expect(
      completionStamp({ wasCompleted: false, willBeCompleted: true, assigneeAfter: null, actorId: "lead", now })
    ).toEqual({ kind: "set", completedAt: now, completedBy: "lead" });
  });

  it("clears the stamp on reopen", () => {
    expect(
      completionStamp({ wasCompleted: true, willBeCompleted: false, assigneeAfter: "emp", actorId: "lead" })
    ).toEqual({ kind: "clear" });
  });

  it("leaves it alone when completion does not change", () => {
    expect(
      completionStamp({ wasCompleted: true, willBeCompleted: true, assigneeAfter: "emp", actorId: "x" })
    ).toEqual({ kind: "none" });
    expect(
      completionStamp({ wasCompleted: false, willBeCompleted: undefined, assigneeAfter: "emp", actorId: "x" })
    ).toEqual({ kind: "none" });
  });
});

describe("presentComment", () => {
  const live = { id: "1", userId: "u", comment: "hello", edits: [{ comment: "helo", editedAt: "2026-11-01" }] };
  const gone = { ...live, deletedAt: "2026-11-02", deletedBy: "admin" };

  it("strips a deleted comment's text for ordinary viewers", () => {
    const shown = presentComment(gone, false);
    expect(shown.comment).toBe("");
    expect(shown.isDeleted).toBe(true);
    expect(shown.deletedBy).toBe("admin");
    expect("edits" in shown).toBe(false);
  });

  it("keeps the text and history for org-wide roles", () => {
    const shown = presentComment(gone, true);
    expect(shown.comment).toBe("hello");
    expect(shown.isDeleted).toBe(true);
    expect(shown.edits?.length).toBe(1);
  });

  it("hides edit history from ordinary viewers of a live comment", () => {
    const shown = presentComment(live, false);
    expect(shown.comment).toBe("hello");
    expect("edits" in shown).toBe(false);
  });
});

describe("canDeleteComment", () => {
  it("lets the author or an org-wide role delete", () => {
    expect(canDeleteComment({ userId: "a" }, { id: "a", isOrgWide: false })).toBe(true);
    expect(canDeleteComment({ userId: "a" }, { id: "b", isOrgWide: true })).toBe(true);
    expect(canDeleteComment({ userId: "a" }, { id: "b", isOrgWide: false })).toBe(false);
  });
});

describe("safeImageExtension", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0]);

  it("accepts real images", () => {
    expect(safeImageExtension("image/png", png)).toBe("png");
    expect(safeImageExtension("image/jpeg", jpg)).toBe("jpg");
  });

  it("refuses an HTML page dressed up as an image", () => {
    const html = Buffer.from("<html><script>alert(1)</script></html>");
    expect(safeImageExtension("image/html", html)).toBeNull();
    expect(safeImageExtension("image/png", html)).toBeNull();
    expect(safeImageExtension("image/svg+xml", Buffer.from("<svg onload=alert(1)>"))).toBeNull();
  });
});

describe("notification helpers", () => {
  it("links to the project and the task", () => {
    expect(boardLink("p1", "t1")).toBe("/board?project=p1&task=t1");
    expect(boardLink("p1")).toBe("/board?project=p1");
  });

  it("tells everyone on the card except the actor, once each", () => {
    expect(
      taskAudience({ assignedTo: "a", createdBy: "c", memberIds: ["a", "m", "c"] }, "c").sort()
    ).toEqual(["a", "m"]);
  });
});

describe("mentions", () => {
  const A = "aaaaaaaaaaaaaaaaaaaaaaaa";
  const B = "bbbbbbbbbbbbbbbbbbbbbbbb";
  const C = "cccccccccccccccccccccccc";

  it("reads the ids out of @[Name](user:id) tokens, once each", () => {
    expect(parseMentions(`hi @[Ali](user:${A}) and @[Sara](user:${B}), again @[Ali](user:${A})`)).toEqual([A, B]);
    expect(parseMentions("email me at ali@example.com")).toEqual([]);
    expect(parseMentions(null)).toEqual([]);
  });

  it("pings only new mentions of project people, never the author", () => {
    expect(
      mentionTargets({
        before: `@[Ali](user:${A})`,
        after: `@[Ali](user:${A}) @[Sara](user:${B}) @[Out](user:${C})`,
        projectPeople: [A, B],
        actorId: "dddddddddddddddddddddddd",
      })
    ).toEqual([B]);
    expect(
      mentionTargets({ after: `@[Me](user:${A})`, projectPeople: [A], actorId: A })
    ).toEqual([]);
  });

  it("turns tokens into readable text", () => {
    expect(plainText(`ping @[Ali Khan](user:${A})`)).toBe("ping @Ali Khan");
  });
});

describe("labels", () => {
  it("accepts only #rrggbb colours", () => {
    expect(isLabelColor("#22c55e")).toBe(true);
    expect(isLabelColor("red")).toBe(false);
    expect(isLabelColor("#fff")).toBe(false);
  });

  it("only allows the project's own labels on a card", () => {
    expect(labelsBelong(["a"], ["a", "b"])).toBe(true);
    expect(labelsBelong(["x"], ["a", "b"])).toBe(false);
  });
});
