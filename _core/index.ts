import "dotenv/config";
import express from "express";
import { createServer } from "http";
import cors from "cors";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { appRouter } from "../routers";
import { createContext } from "./context";
import avatarUploadRouter from "../avatar-upload";
import employeeDocumentUploadRouter from "../employee-document-upload";
import { connectToMongoDB } from "../mongodb";
import { UPLOADS_DIR } from "../storage";
import { startShiftSweep } from "../shiftSweep";
import { initRealtime } from "./realtime";
import { handleWingmanClock, handleWingmanEmployeeData } from "../wingman";
import { ENV } from "./env";

async function startServer() {
  await connectToMongoDB();

  // Sessions nobody clocked out of used to stay open indefinitely, so hours
  // and attendance drifted further from reality every day.
  startShiftSweep();

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
  /**
   * API responses must never be cached.
   *
   * tRPC queries travel as GET, and auth.me is fetched at the same URL whether
   * or not anyone is signed in. Nothing marked those responses uncacheable and
   * the Vary header does not mention Cookie, so one cache entry served both
   * states: Safari would replay the pre-login `null` straight after a
   * successful login, the app would conclude nobody was signed in and bounce
   * back to the login screen. It looked like the session cookie was broken,
   * but the cookie was never the problem - the response was simply stale.
   *
   * Chrome caches these less eagerly, which is why iPhones failed every time
   * and Android only now and then.
   */
  app.use("/api", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    // Belt and braces: even a cache that ignores the above must not mix up
    // one signed-in user's response with another's. res.vary appends rather
    // than replacing, so tRPC's own `Vary: trpc-accept` survives.
    res.vary("Cookie");
    next();
  });

  // Configure body parser with larger size limit for file uploads
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  // Serve uploaded files from the same directory storagePut writes to.
  app.use("/uploads", express.static(UPLOADS_DIR));
  console.log(`[Uploads] serving ${UPLOADS_DIR}`);
  // Avatar upload endpoint
  app.use(avatarUploadRouter);
  // Employee document upload endpoint
  app.use(employeeDocumentUploadRouter);
  // Wingman, the WhatsApp assistant, clocking someone in or out. Registered
  // straight on the app ahead of any session auth, because Wingman proves
  // itself with X-Wingman-Secret instead. The logic lives in wingman.ts.
  app.post("/api/wingman/clock", async (req, res) => {
    try {
      const result = await handleWingmanClock(req.headers["x-wingman-secret"], req.body);
      return res.status(result.status).json(result.body);
    } catch (error) {
      // Express 4 does not catch a rejected handler; without this the request
      // would hang until Wingman's timeout and read as a failure anyway.
      console.error(
        "[Wingman] inbound clock route failed",
        error instanceof Error ? error.name : "unknown error"
      );
      return res.status(500).json({ ok: false, error: "internal_error" });
    }
  });
  // Wingman reading one employee's snapshot (clock, hours, tasks, projects,
  // leaves) for briefings and questions. Same X-Wingman-Secret gate; read-only.
  app.get("/api/wingman/employee-data", async (req, res) => {
    try {
      const result = await handleWingmanEmployeeData(
        req.headers["x-wingman-secret"],
        req.query as Record<string, unknown>
      );
      return res.status(result.status).json(result.body);
    } catch (error) {
      console.error(
        "[Wingman] employee-data route failed",
        error instanceof Error ? error.name : "unknown error"
      );
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
