/**
 * Copies a portal's existing uploaded files from the disk (UPLOADS_DIR) into
 * its Spaces folder, so they keep opening after the move. Uses the portal's
 * own storage code and .env (SPACES_* must already be set there).
 *
 * Only copies. Nothing on the disk is deleted, so the disk copy stays as a
 * fallback (the portal reads the disk for anything the bucket lacks). It only
 * looks unless given --apply.
 *
 *   cd /srv/hrms/backend          (or /srv/tenants/<name>/backend)
 *   npx esbuild deploy/copy-uploads-to-spaces.ts --bundle --platform=node \
 *     --packages=external --format=esm --outfile=dist/copy-uploads.mjs
 *   sudo node dist/copy-uploads.mjs            # look only
 *   sudo node dist/copy-uploads.mjs --apply    # copy
 */
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
  if (match && process.env[match[1]] === undefined) {
    process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
}

const APPLY = process.argv.includes("--apply");
const TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

async function main() {
  // Imported after .env is read, so storage sees the SPACES_* settings.
  const { spacesConfig, storagePut, UPLOADS_DIR } = await import("../storage");
  const spaces = spacesConfig();
  if (!spaces) throw new Error("SPACES_BUCKET is not set in this portal's .env.");
  console.log(`From disk:  ${UPLOADS_DIR}`);
  console.log(`To Spaces:  ${spaces.bucket}/${spaces.prefix}`);
  console.log(APPLY ? "Mode: copying\n" : "Mode: looking only. Add --apply to copy.\n");

  let files = 0;
  let bytes = 0;
  let failed = 0;
  for await (const full of walk(UPLOADS_DIR)) {
    const key = path.relative(UPLOADS_DIR, full).split(path.sep).join("/");
    const body = await fs.readFile(full);
    files += 1;
    bytes += body.length;
    if (!APPLY) continue;
    try {
      await storagePut(key, body, TYPES[path.extname(key).toLowerCase()] ?? "application/octet-stream");
    } catch (error) {
      failed += 1;
      console.error(`  FAILED ${key}: ${error instanceof Error ? error.message : error}`);
    }
  }
  const size = bytes > 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.round(bytes / 1e3)} KB`;
  console.log(`${files} files, ${size}${APPLY ? `, copied ${files - failed}, failed ${failed}` : ""}.`);
  if (failed > 0) process.exit(1);
}

main().catch(error => {
  console.error("Stopped:", error instanceof Error ? error.message : error);
  process.exit(1);
});
