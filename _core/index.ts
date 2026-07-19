import "dotenv/config";
import express from "express";
import { createServer } from "http";
import path from "node:path";
import cors from "cors";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { appRouter } from "../routers";
import { createContext } from "./context";
import avatarUploadRouter from "../avatar-upload";
import employeeDocumentUploadRouter from "../employee-document-upload";
import { connectToMongoDB } from "../mongodb";
import { initRealtime } from "./realtime";
import {
  clockInUser,
  clockOutUser,
  getUserByWingmanEmployeeIdentifier,
  parseWingmanPayload,
  WorkClockError,
} from "../wingman";
import { ENV } from "./env";

async function startServer() {
  await connectToMongoDB();

  const app = express();
  const server = createServer(app);
  initRealtime(server);
  const corsOrigin = process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(",").map(origin => origin.trim()).filter(Boolean)
    : undefined;
  app.use(
    cors({
      origin: corsOrigin && corsOrigin.length > 0 ? corsOrigin : true,
      credentials: true,
    })
  );
  // Configure body parser with larger size limit for file uploads
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  // Serve uploaded files
  const uploadsDir = path.resolve(import.meta.dirname, "..", "uploads");
  app.use("/uploads", express.static(uploadsDir));
  // Avatar upload endpoint
  app.use(avatarUploadRouter);
  // Employee document upload endpoint
  app.use(employeeDocumentUploadRouter);
  app.post("/api/wingman/clock", async (req, res) => {
    if (!ENV.wingmanSecret) {
      return res.status(503).json({ ok: false, error: "wingman_not_configured" });
    }

    if (req.headers["x-wingman-secret"] !== ENV.wingmanSecret) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    const parsed = parseWingmanPayload(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: "invalid_payload" });
    }

    const { event, employee, at } = parsed.data;
    const atDate = at ? new Date(at) : new Date();
    if (Number.isNaN(atDate.getTime())) {
      return res.status(400).json({ ok: false, error: "invalid_at" });
    }

    const user = await getUserByWingmanEmployeeIdentifier(employee);
    if (!user?.id) {
      return res.status(404).json({ ok: false, error: "employee_not_found" });
    }

    try {
      if (event === "clock_in") {
        await clockInUser(user.id, { at: atDate });
      } else {
        await clockOutUser(user.id, { at: atDate });
      }

      return res.json({ ok: true, at: atDate.toISOString() });
    } catch (error) {
      if (error instanceof WorkClockError) {
        return res.status(error.statusCode).json({ ok: false, error: error.message });
      }

      console.error("[Wingman] inbound clock route failed", error);
      return res.status(500).json({ ok: false, error: "internal_error" });
    }
  });
  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );
  const port = Number.parseInt(process.env.PORT || "3000", 10);
  const host = process.env.HOST || "0.0.0.0";

  server.listen(port, host, () => {
    console.log(`Server running on http://${host}:${port}/`);
  });
}

startServer().catch(console.error);
