import { Router } from "express";
import multer from "multer";
import { storagePut } from "./storage";
import { authenticateRequest } from "./_core/auth";
import { isOrgWide } from "./roles";

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB
  fileFilter: (_req, file, cb) => {
    const isPdf = file.mimetype === "application/pdf";
    const isImage = file.mimetype.startsWith("image/");
    if (!isPdf && !isImage) {
      cb(new Error("Only PDF or image files are allowed"));
      return;
    }
    cb(null, true);
  },
});

router.post("/api/upload-employee-document", upload.single("file"), async (req, res) => {
  try {
    let user;
    try {
      user = await authenticateRequest(req);
    } catch {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    if (!isOrgWide(user.role)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    if (!req.file) {
      res.status(400).json({ error: "No file uploaded" });
      return;
    }

    const docType = typeof req.body.docType === "string" ? req.body.docType : "document";
    const safeType = docType.replace(/[^a-z0-9_-]/gi, "").toLowerCase() || "document";
    const fileExt = req.file.originalname.split(".").pop() || "bin";
    const fileName = `employee-documents/${user.id}-${safeType}-${Date.now()}.${fileExt}`;

    const { url } = await storagePut(fileName, req.file.buffer, req.file.mimetype);

    res.json({ url });
  } catch (error) {
    console.error("Employee document upload error:", error);
    res.status(500).json({ error: "Failed to upload document" });
  }
});

export default router;
