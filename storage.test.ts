import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const backendRoot = path.resolve(import.meta.dirname);

describe("upload storage location", () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hrms-uploads-"));
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("honours UPLOADS_DIR", async () => {
    process.env.UPLOADS_DIR = tmpDir;
    // Fresh module instance so the module-level constant re-reads the env var.
    vi.resetModules();
    const { UPLOADS_DIR, storagePut } = await import("./storage");

    expect(UPLOADS_DIR).toBe(path.resolve(tmpDir));

    const { url } = await storagePut("payslips/demo.pdf", Buffer.from("%PDF-1.4 test"));
    expect(url).toBe("/uploads/payslips/demo.pdf");

    const written = await fs.readFile(path.join(tmpDir, "payslips", "demo.pdf"), "utf8");
    expect(written).toBe("%PDF-1.4 test");

    delete process.env.UPLOADS_DIR;
  });

  /**
   * Regression guard. The production build bundles storage.ts and _core/index.ts
   * into a single dist/index.js, so anything derived from import.meta.dirname
   * resolves to dist/ in both. That previously made storagePut write to
   * dist/uploads while express served dist/../uploads, so every download 404'd
   * in production while working in dev.
   */
  it("resolves the same directory for writing and serving after bundling", async () => {
    const distDir = path.join(backendRoot, "dist-storage-test");
    await fs.rm(distDir, { recursive: true, force: true });

    await run(
      "npx",
      [
        "esbuild",
        "_core/index.ts",
        "--platform=node",
        "--packages=external",
        "--bundle",
        "--format=esm",
        `--outdir=${distDir}`,
      ],
      { cwd: backendRoot, shell: true }
    );

    const bundled = await fs.readFile(path.join(distDir, "index.js"), "utf8");

    // Neither the writer nor the static server may derive the uploads path from
    // the bundle's own location.
    expect(bundled).not.toMatch(/path\d*\.resolve\(\s*import\.meta\.dirname\s*,\s*"uploads"\s*\)/);
    expect(bundled).not.toMatch(/path\d*\.resolve\(\s*import\.meta\.dirname\s*,\s*"\.\.",\s*"uploads"\s*\)/);

    // And there is exactly one definition of the uploads directory.
    const definitions = bundled.match(/UPLOADS_DIR\s*=/g) ?? [];
    expect(definitions.length).toBe(1);

    await fs.rm(distDir, { recursive: true, force: true });
  }, 60_000);
});
