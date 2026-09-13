import { describe, expect, it } from "vitest";
import {
  assignableRoles,
  canAssignRole,
  hasRank,
  isAnyHead,
  isOrgWide,
  isSuperAdmin,
  rankOf,
} from "./roles";

describe("role hierarchy", () => {
  it("orders the four levels", () => {
    expect(rankOf("user")).toBeLessThan(rankOf("dept_head"));
    expect(rankOf("dept_head")).toBeLessThan(rankOf("head_of_ops"));
    expect(rankOf("head_of_ops")).toBeLessThan(rankOf("admin"));
  });

  it("treats anything unrecognised as the least privileged", () => {
    // A typo in a role, or a value from an older record, must never read as
    // more access than it should.
    for (const value of ["", "administrator", "ADMIN", "superuser", undefined, null]) {
      expect(rankOf(value as any)).toBe(0);
      expect(isOrgWide(value as any)).toBe(false);
      expect(isSuperAdmin(value as any)).toBe(false);
    }
  });

  it("lets head_of_ops through the org-wide checks that used to say admin", () => {
    // The whole point of the change: the thirty-nine "admin only" endpoints
    // have to admit the level directly below admin.
    expect(isOrgWide("head_of_ops")).toBe(true);
    expect(isOrgWide("admin")).toBe(true);
    expect(isOrgWide("dept_head")).toBe(false);
    expect(isOrgWide("user")).toBe(false);
  });

  it("keeps super admin distinct from head_of_ops", () => {
    expect(isSuperAdmin("head_of_ops")).toBe(false);
    expect(isSuperAdmin("admin")).toBe(true);
  });

  it("counts every head as a head", () => {
    expect(isAnyHead("dept_head")).toBe(true);
    expect(isAnyHead("head_of_ops")).toBe(true);
    expect(isAnyHead("admin")).toBe(true);
    expect(isAnyHead("user")).toBe(false);
  });

  it("compares against an explicit minimum", () => {
    expect(hasRank("dept_head", "dept_head")).toBe(true);
    expect(hasRank("user", "dept_head")).toBe(false);
    expect(hasRank("admin", "user")).toBe(true);
  });
});

describe("assigning roles", () => {
  it("only ever hands out roles below your own", () => {
    expect(assignableRoles("admin")).toEqual(["user", "dept_head", "head_of_ops"]);
    expect(assignableRoles("head_of_ops")).toEqual(["user", "dept_head"]);
    expect(assignableRoles("dept_head")).toEqual(["user"]);
    expect(assignableRoles("user")).toEqual([]);
  });

  it("stops anyone cloning their own level", () => {
    // Otherwise a head of operations could mint another one, and the level
    // above them would lose control of who holds it.
    expect(canAssignRole("head_of_ops", "head_of_ops")).toBe(false);
    expect(canAssignRole("admin", "admin")).toBe(false);
    expect(canAssignRole("dept_head", "dept_head")).toBe(false);
  });

  it("stops anyone promoting above themselves", () => {
    expect(canAssignRole("head_of_ops", "admin")).toBe(false);
    expect(canAssignRole("dept_head", "head_of_ops")).toBe(false);
    expect(canAssignRole("user", "dept_head")).toBe(false);
  });

  it("rejects a role that does not exist", () => {
    expect(canAssignRole("admin", "superuser")).toBe(false);
    expect(canAssignRole("admin", "")).toBe(false);
  });
});
