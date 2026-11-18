import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { signV4, spacesConfig } from "./storage";

describe("Spaces signing", () => {
  it("matches AWS's own Signature V4 example (GET Object)", () => {
    const emptyHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const auth = signV4({
      method: "GET",
      host: "examplebucket.s3.amazonaws.com",
      path: "/test.txt",
      headers: { Range: "bytes=0-9", "x-amz-content-sha256": emptyHash, "x-amz-date": "20130524T000000Z" },
      payloadHash: emptyHash,
      accessKey: "AKIAIOSFODNN7EXAMPLE",
      secret: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      region: "us-east-1",
      amzDate: "20130524T000000Z",
    });
    expect(auth).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " +
        "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, " +
        "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
    );
  });
});

describe("Spaces config", () => {
  it("is off without a bucket, and reads the bucket's own origin", () => {
    expect(spacesConfig({})).toBeNull();
    const config = spacesConfig({
      SPACES_BUCKET: "nowhrms-files",
      SPACES_ENDPOINT: "https://nowhrms-files.fra1.digitaloceanspaces.com",
      SPACES_KEY: "k",
      SPACES_SECRET: "s",
      SPACES_PREFIX: "/heard/",
    })!;
    expect([config.host, config.region, config.prefix]).toEqual(["fra1.digitaloceanspaces.com", "fra1", "heard"]);
    expect(() => spacesConfig({ SPACES_BUCKET: "b" })).toThrow(/missing/);
  });
});

describe("storage with Spaces on", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("writes to the bucket, reads back, falls back to disk, deletes, refuses unsafe keys", async () => {
    const disk = await fs.mkdtemp(path.join(os.tmpdir(), "hrms-spaces-"));
    await fs.mkdir(path.join(disk, "old"), { recursive: true });
    await fs.writeFile(path.join(disk, "old", "a.txt"), "old file");
    Object.assign(process.env, {
      UPLOADS_DIR: disk,
      SPACES_BUCKET: "nowhrms-files",
      SPACES_ENDPOINT: "https://fra1.digitaloceanspaces.com",
      SPACES_KEY: "DO00TEST",
      SPACES_SECRET: "secret",
      SPACES_PREFIX: "heard",
    });
    const bucket = new Map<string, { body: Buffer; type: string }>();
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init: any) => {
      const u = new URL(url);
      calls.push(`${init.method} ${u.pathname}`);
      const key = decodeURIComponent(u.pathname);
      if (init.method === "PUT") {
        bucket.set(key, { body: init.body, type: init.headers["content-type"] });
        return new Response(null, { status: 200 });
      }
      if (init.method === "GET") {
        const found = bucket.get(key);
        return found
          ? new Response(found.body, { status: 200, headers: { "content-type": found.type } })
          : new Response("", { status: 404 });
      }
      bucket.delete(key);
      return new Response(null, { status: 204 });
    });
    vi.resetModules();
    const storage = await import("./storage");

    const put = await storage.storagePut("payslips/May slip.pdf", Buffer.from("%PDF"), "application/pdf");
    expect(put.url).toBe("/uploads/payslips/May slip.pdf");
    expect(calls[0]).toBe("PUT /nowhrms-files/heard/payslips/May%20slip.pdf");

    const got = await storage.storageFetch("payslips/May slip.pdf");
    expect(got?.body.toString()).toBe("%PDF");
    expect(got?.contentType).toBe("application/pdf");

    expect((await storage.storageFetch("old/a.txt"))?.body.toString()).toBe("old file");
    expect(await storage.storageFetch("nope/x.txt")).toBeNull();

    expect(await storage.storageDelete("payslips/May slip.pdf")).toBe(true);
    expect(await storage.storageFetch("payslips/May slip.pdf")).toBeNull();

    await expect(storage.storagePut("../etc/passwd", "x")).rejects.toThrow(/unsafe/);
    await fs.rm(disk, { recursive: true, force: true });
  });
});
