import { afterEach, describe, expect, it, vi } from "vitest";
import type { Request } from "express";

const req = (headers: Record<string, string> = {}, protocol = "http") =>
  ({ protocol, headers }) as unknown as Request;

async function load() {
  vi.resetModules();
  return import("./_core/cookies");
}

afterEach(() => {
  delete process.env.COOKIE_SAMESITE;
});

describe("session cookie options", () => {
  it("defaults to SameSite=None for the split-origin deployment", async () => {
    const { getSessionCookieOptions } = await load();
    const opts = getSessionCookieOptions(req({ "x-forwarded-proto": "https" }));

    expect(opts.sameSite).toBe("none");
    expect(opts.secure).toBe(true);
    expect(opts.httpOnly).toBe(true);
    expect(opts.path).toBe("/");
  });

  it("forces Secure when SameSite=None, since browsers reject it otherwise", async () => {
    const { getSessionCookieOptions } = await load();
    // Plain HTTP, no forwarding header.
    expect(getSessionCookieOptions(req()).secure).toBe(true);
  });

  it("uses SameSite=Lax when configured for a single domain", async () => {
    process.env.COOKIE_SAMESITE = "lax";
    const { getSessionCookieOptions } = await load();
    const opts = getSessionCookieOptions(req({ "x-forwarded-proto": "https" }));

    expect(opts.sameSite).toBe("lax");
    expect(opts.secure).toBe(true);
  });

  it("keeps a Lax cookie usable over plain HTTP in local dev", async () => {
    process.env.COOKIE_SAMESITE = "lax";
    const { getSessionCookieOptions } = await load();
    expect(getSessionCookieOptions(req()).secure).toBe(false);
  });

  it("trusts x-forwarded-proto from the nginx proxy", async () => {
    process.env.COOKIE_SAMESITE = "lax";
    const { getSessionCookieOptions } = await load();

    expect(getSessionCookieOptions(req({ "x-forwarded-proto": "https" })).secure).toBe(true);
    expect(getSessionCookieOptions(req({ "x-forwarded-proto": "https, http" })).secure).toBe(true);
    expect(getSessionCookieOptions(req({ "x-forwarded-proto": "http" })).secure).toBe(false);
  });

  it("ignores an unrecognised value rather than emitting an invalid cookie", async () => {
    process.env.COOKIE_SAMESITE = "banana";
    const { getSessionCookieOptions } = await load();
    expect(getSessionCookieOptions(req()).sameSite).toBe("none");
  });
});
