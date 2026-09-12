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
