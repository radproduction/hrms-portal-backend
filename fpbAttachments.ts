/**
 * Files on project-board cards.
 *
 *   POST /api/fpb/tasks/:taskId/attachments   (multipart, field "file", max 10 MB)
 *   GET  /api/fpb/attachments/:id[?download=1]
 *
 * Any format can be attached. What keeps that safe:
 *  - Files are stored under a random name with no extension, in a folder the
 *    public /uploads route refuses to serve (see _core/index.ts).
 *  - Downloads need a signed-in user who can open the card's project.
 *  - Only files whose bytes really are PNG/JPEG/GIF/WebP are ever shown inline;
 *    everything else is sent as a download, with nosniff and a sandboxing CSP,
 *    so an uploaded HTML or SVG page can never run on the portal's origin.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { Router, type Request, type Response } from "express";
import multer from "multer";
import { TRPCError } from "@trpc/server";
import { authenticateRequest } from "./_core/auth";
import * as fpb from "./fpbDb";
import { requireProjectAccess } from "./fpbRouter";
import { safeImageExtension } from "./fpbRules";
import { storagePath, storagePut } from "./storage";

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const ATTACHMENTS_PREFIX = "fpb-attachments";

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1 },
});

const OBJECT_ID = /^[0-9a-fA-F]{24}$/;

/** A file name safe to put in a header and show in the UI. */
export function cleanFileName(name: string | undefined): string {
  const base = String(name ?? "file").split(/[\\/]/).pop() ?? "file";
  const cleaned = base.replace(/[\u0000-\u001f\u007f"]/g, "").trim().slice(0, 180);
  return cleaned || "file";
}

/** Content-Disposition with an ASCII fallback and the real (UTF-8) name. */
export function contentDisposition(kind: "inline" | "attachment", fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/[\\"]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

function statusFor(error: unknown): number {
  if (error instanceof TRPCError) {
    if (error.code === "NOT_FOUND") return 404;
    if (error.code === "FORBIDDEN") return 403;
    if (error.code === "UNAUTHORIZED") return 401;
  }
  return 500;
}

async function signedIn(req: Request, res: Response) {
  try {
    return await authenticateRequest(req);
  } catch {
    res.status(401).json({ error: "Please sign in" });
    return null;
  }
}

const router = Router();

router.post(
  "/api/fpb/tasks/:taskId/attachments",
  (req, res, next) => {
    upload.single("file")(req, res, error => {
      if (error) {
        const tooBig = (error as any)?.code === "LIMIT_FILE_SIZE";
        res.status(tooBig ? 413 : 400).json({
          error: tooBig ? "File must be 10 MB or smaller" : "Could not read the upload",
        });
        return;
      }
      next();
    });
  },
  async (req, res) => {
    try {
      const user = await signedIn(req, res);
      if (!user) return;
      const taskId = String(req.params.taskId ?? "");
      if (!OBJECT_ID.test(taskId)) {
        res.status(400).json({ error: "Invalid task" });
        return;
      }
      if (!req.file || req.file.size === 0) {
        res.status(400).json({ error: "No file uploaded" });
        return;
      }

      const found = await fpb.getTask(taskId);
      if (!found) {
        res.status(404).json({ error: "Task not found" });
        return;
      }
      const projectId = String((found.task as any).projectId);
      await requireProjectAccess({ user: { id: user.id, role: user.role } }, projectId);

      const fileName = cleanFileName(req.file.originalname);
      const isImage = safeImageExtension(req.file.mimetype, req.file.buffer) !== null;
      const storageKey = `${ATTACHMENTS_PREFIX}/${projectId}/${crypto.randomUUID()}`;
      await storagePut(storageKey, req.file.buffer, req.file.mimetype);

      const attachment = await fpb.createAttachment({
        projectId,
        taskId,
        fileName,
        mimeType: String(req.file.mimetype || "application/octet-stream").slice(0, 120),
        size: req.file.size,
        storageKey,
        isImage,
        uploadedBy: user.id,
      });
      await fpb.logActivity(projectId, user.id, "attached", fileName, taskId);
      res.json(attachment);
    } catch (error) {
      const status = statusFor(error);
      if (status === 500) {
        console.error("[FPB] attachment upload failed", error instanceof Error ? error.message : "unknown");
      }
      res.status(status).json({ error: status === 500 ? "Could not upload the file" : (error as Error).message });
    }
  }
);

router.get("/api/fpb/attachments/:id", async (req, res) => {
  try {
    const user = await signedIn(req, res);
    if (!user) return;
    const id = String(req.params.id ?? "");
    if (!OBJECT_ID.test(id)) {
      res.status(400).json({ error: "Invalid attachment" });
      return;
    }
    const found = await fpb.getAttachment(id);
    if (!found) {
      res.status(404).json({ error: "Attachment not found" });
      return;
    }
    await requireProjectAccess({ user: { id: user.id, role: user.role } }, String(found.projectId));

    const data = await fs.readFile(storagePath(String(found.storageKey)));
    const fileName = String(found.fileName ?? "file");
    const ext = found.isImage ? safeImageExtension(String(found.mimeType ?? ""), data) : null;
    const inline = Boolean(ext) && req.query.download !== "1";

    res.setHeader("Content-Type", inline && ext ? IMAGE_MIME[ext] : "application/octet-stream");
    res.setHeader("Content-Disposition", contentDisposition(inline ? "inline" : "attachment", fileName));
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; img-src 'self'; sandbox");
    res.setHeader("Cache-Control", "private, max-age=300");
    res.send(data);
  } catch (error) {
    const status = (error as NodeJS.ErrnoException)?.code === "ENOENT" ? 404 : statusFor(error);
    if (status === 500) {
      console.error("[FPB] attachment download failed", error instanceof Error ? error.message : "unknown");
    }
    res.status(status).json({ error: status === 404 ? "File not found" : "Could not open the file" });
  }
});

export default router;
