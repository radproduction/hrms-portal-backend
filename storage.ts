import fs from "node:fs/promises";
import path from "node:path";

/**
 * Single source of truth for where uploads live. Both the writer (storagePut)
 * and the static file server import this.
 *
 * It must NOT be derived from import.meta.dirname: the production build bundles
 * this file into dist/index.js, so import.meta.dirname becomes dist/ here while
 * the server previously resolved dist/../uploads. Files were written to
 * dist/uploads and served from uploads/, so every download 404'd in production
 * while working fine in dev.
 *
 * Set UPLOADS_DIR to a mounted volume in production, otherwise uploads live on
 * the container's ephemeral disk and disappear on the next deploy.
 */
export const UPLOADS_DIR = process.env.UPLOADS_DIR
  ? path.resolve(process.env.UPLOADS_DIR)
  : path.resolve(process.cwd(), "uploads");

function normalizeKey(relKey: string): string {
  return relKey.replace(/^\/+/, "").replace(/\\/g, "/");
}

function toBuffer(data: Buffer | Uint8Array | string): Buffer {
  if (typeof data === "string") {
    return Buffer.from(data);
  }
  return Buffer.from(data);
}

async function ensureDirForFile(filePath: string) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
}

export async function storagePut(
  relKey: string,
  data: Buffer | Uint8Array | string,
  _contentType = "application/octet-stream"
): Promise<{ key: string; url: string }> {
  const key = normalizeKey(relKey);
  const filePath = path.join(UPLOADS_DIR, key);
  await ensureDirForFile(filePath);
  await fs.writeFile(filePath, toBuffer(data));
  return { key, url: `/uploads/${key}` };
}

export async function storageGet(
  relKey: string
): Promise<{ key: string; url: string }> {
  const key = normalizeKey(relKey);
  return { key, url: `/uploads/${key}` };
}

/**
 * Removes an uploaded file. Returns false when there was nothing to remove,
 * so a caller tidying up after a deleted record does not have to treat an
 * already-missing file as a failure.
 *
 * The key is resolved against UPLOADS_DIR and checked to still be inside it,
 * so a stored path containing "../" cannot reach the rest of the disk.
 */
export async function storageDelete(relKey: string): Promise<boolean> {
  const key = normalizeKey(relKey);
  const filePath = path.resolve(UPLOADS_DIR, key);

  const root = path.resolve(UPLOADS_DIR);
  if (filePath !== root && !filePath.startsWith(root + path.sep)) {
    throw new Error("Refusing to delete outside the uploads directory");
  }

  try {
    await fs.unlink(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
