import { Router } from "express";
import { ENV } from "./_core/env";
import {
  clockInUser,
  clockOutUser,
  getUserByWingmanEmployeeIdentifier,
  parseWingmanPayload,
  WorkClockError,
} from "./wingman";

const wingmanClockRouter = Router();

wingmanClockRouter.post("/api/wingman/clock", async (req, res) => {
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

export default wingmanClockRouter;
