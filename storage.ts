import crypto from "node:crypto";
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

// ------------------------------------------------------------ Spaces

/**
 * DigitalOcean Spaces (S3-compatible object storage). When SPACES_BUCKET is
 * set, new files go to the bucket instead of the disk; without it everything
 * stays on the disk as before. Links keep the same /uploads/<key> shape either
 * way, so links already saved in the database keep working, and a file not
 * (yet) in the bucket is still read from the disk.
 *
 *   SPACES_BUCKET=nowhrms-files
 *   SPACES_ENDPOINT=https://fra1.digitaloceanspaces.com
 *   SPACES_KEY=DO00...            (a key limited to this bucket)
 *   SPACES_SECRET=...
 *   SPACES_PREFIX=heard           (one folder per organisation)
 *
 * Requests are signed with AWS Signature V4 using node:crypto, so no SDK.
 */
export type SpacesConfig = {
  bucket: string;
  host: string;
  region: string;
  accessKey: string;
  secret: string;
  prefix: string;
};

export function spacesConfig(env: NodeJS.ProcessEnv = process.env): SpacesConfig | null {
  const bucket = env.SPACES_BUCKET?.trim();
  if (!bucket) return null;
  const endpoint = env.SPACES_ENDPOINT?.trim();
  const accessKey = env.SPACES_KEY?.trim();
  const secret = env.SPACES_SECRET?.trim();
  if (!endpoint || !accessKey || !secret) {
    throw new Error("SPACES_BUCKET is set but SPACES_ENDPOINT, SPACES_KEY or SPACES_SECRET is missing");
  }
  let host = new URL(endpoint.includes("://") ? endpoint : `https://${endpoint}`).host;
  // Accept the bucket's own origin (bucket.region.digitaloceanspaces.com) too.
  if (host.startsWith(`${bucket}.`)) host = host.slice(bucket.length + 1);
  const region = env.SPACES_REGION?.trim() || host.split(".")[0];
  const prefix = (env.SPACES_PREFIX ?? "").trim().replace(/^\/+|\/+$/g, "");
  return { bucket, host, region, accessKey, secret, prefix };
}

const sha256Hex = (data: Buffer | string) => crypto.createHash("sha256").update(data).digest("hex");
const hmac = (key: Buffer | string, data: string) => crypto.createHmac("sha256", key).update(data).digest();

/** RFC 3986 encoding of each path segment, as S3 signing expects. */
function encodeSegment(segment: string) {
  return encodeURIComponent(segment).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** AWS Signature V4 for an S3-style request. Pure, so it can be checked against AWS's own examples. */
export function signV4(input: {
  method: string;
  host: string;
  path: string;
  headers: Record<string, string>;
  payloadHash: string;
  accessKey: string;
  secret: string;
  region: string;
  amzDate: string;
  service?: string;
}): string {
  const service = input.service ?? "s3";
  const date = input.amzDate.slice(0, 8);
  const headers: Record<string, string> = { host: input.host };
  for (const [name, value] of Object.entries(input.headers)) headers[name.toLowerCase()] = String(value).trim();
  const names = Object.keys(headers).sort();
  const canonicalRequest = [
    input.method,
    input.path,
    "",
    names.map(name => `${name}:${headers[name]}\n`).join(""),
    names.join(";"),
    input.payloadHash,
  ].join("\n");
  const scope = `${date}/${input.region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", input.amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${input.secret}`, date), input.region), service), "aws4_request");
  const signature = crypto.createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  return `AWS4-HMAC-SHA256 Credential=${input.accessKey}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`;
}

/** Rejects keys that could step outside their folder in the bucket. */
function safeObjectKey(config: SpacesConfig, key: string) {
  const parts = key.split("/");
  if (parts.some(part => part === "" || part === "." || part === "..")) {
    throw new Error("Refusing an unsafe storage key");
  }
  return [config.prefix, key].filter(Boolean).join("/");
}

async function spacesRequest(
  config: SpacesConfig,
  method: "GET" | "PUT" | "DELETE",
  key: string,
  body?: Buffer,
  contentType?: string
) {
  const objectPath = `/${config.bucket}/${safeObjectKey(config, key).split("/").map(encodeSegment).join("/")}`;
  const payloadHash = sha256Hex(body ?? "");
  const amzDate = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const headers: Record<string, string> = { "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate };
  if (method === "PUT") {
    headers["content-type"] = contentType || "application/octet-stream";
    headers["x-amz-acl"] = "private";
  }
  headers.authorization = signV4({
    method,
    host: config.host,
    path: objectPath,
    headers,
    payloadHash,
    accessKey: config.accessKey,
    secret: config.secret,
    region: config.region,
    amzDate,
  });
  return fetch(`https://${config.host}${objectPath}`, { method, headers, body });
}

// ------------------------------------------------------------ the API

export async function storagePut(
  relKey: string,
  data: Buffer | Uint8Array | string,
  contentType = "application/octet-stream"
): Promise<{ key: string; url: string }> {
  const key = normalizeKey(relKey);
  const spaces = spacesConfig();
  if (spaces) {
    const response = await spacesRequest(spaces, "PUT", key, toBuffer(data), contentType);
    if (!response.ok) throw new Error(`Could not save the file to storage (HTTP ${response.status})`);
    return { key, url: `/uploads/${key}` };
  }
  const filePath = path.join(UPLOADS_DIR, key);
  await ensureDirForFile(filePath);
  await fs.writeFile(filePath, toBuffer(data));
  return { key, url: `/uploads/${key}` };
}

/**
 * A stored file's bytes and type: from the bucket when Spaces is on, falling
 * back to the disk for files saved before the move. Null when it is in neither.
 */
export async function storageFetch(relKey: string): Promise<{ body: Buffer; contentType: string | null } | null> {
  const key = normalizeKey(relKey);
  const spaces = spacesConfig();
  if (spaces) {
    const response = await spacesRequest(spaces, "GET", key);
    if (response.ok) {
      return { body: Buffer.from(await response.arrayBuffer()), contentType: response.headers.get("content-type") };
    }
    if (response.status !== 404 && response.status !== 403) {
      throw new Error(`Could not read the file from storage (HTTP ${response.status})`);
    }
  }
  try {
    return { body: await fs.readFile(storagePath(key)), contentType: null };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function storageGet(
  relKey: string
): Promise<{ key: string; url: string }> {
  const key = normalizeKey(relKey);
  return { key, url: `/uploads/${key}` };
}

/**
 * Absolute path of a stored file, refusing anything that resolves outside
 * UPLOADS_DIR (a key containing "../").
 */
export function storagePath(relKey: string): string {
  const key = normalizeKey(relKey);
  const filePath = path.resolve(UPLOADS_DIR, key);
  const root = path.resolve(UPLOADS_DIR);
  if (!filePath.startsWith(root + path.sep)) {
    throw new Error("Refusing to read outside the uploads directory");
  }
  return filePath;
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
  const spaces = spacesConfig();
  if (spaces) {
    const response = await spacesRequest(spaces, "DELETE", key);
    if (!response.ok && response.status !== 404) {
      throw new Error(`Could not delete the file from storage (HTTP ${response.status})`);
    }
  }
  const filePath = path.resolve(UPLOADS_DIR, key);

  const root = path.resolve(UPLOADS_DIR);
  if (filePath !== root && !filePath.startsWith(root + path.sep)) {
    throw new Error("Refusing to delete outside the uploads directory");
  }

  try {
    await fs.unlink(filePath);
    return true;
  } catch (error) {
    // With Spaces on, the file usually lives only in the bucket.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return Boolean(spaces);
    throw error;
  }
}
