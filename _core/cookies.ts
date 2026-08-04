import type { CookieOptions, Request } from "express";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function isIpAddress(host: string) {
  // Basic IPv4 check and IPv6 presence detection.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  return host.includes(":");
}

function isSecureRequest(req: Request) {
  if (req.protocol === "https") return true;

  const forwardedProto = req.headers["x-forwarded-proto"];
  if (!forwardedProto) return false;

  const protoList = Array.isArray(forwardedProto)
    ? forwardedProto
    : forwardedProto.split(",");

  return protoList.some(proto => proto.trim().toLowerCase() === "https");
}

/**
 * SameSite=None is only needed while the frontend and the API sit on different
 * origins (Vercel + Railway). It also means the cookie rides along on
 * cross-site requests, which is what makes CSRF possible here.
 *
 * Serving both from one domain lets this be "lax", which removes that exposure
 * entirely. Set COOKIE_SAMESITE=lax on a single-domain deployment.
 */
function resolveSameSite(): "lax" | "strict" | "none" {
  const raw = (process.env.COOKIE_SAMESITE ?? "").trim().toLowerCase();
  if (raw === "lax" || raw === "strict" || raw === "none") return raw;
  return "none";
}

export function getSessionCookieOptions(
  req: Request
): Pick<CookieOptions, "domain" | "httpOnly" | "path" | "sameSite" | "secure"> {
  const sameSite = resolveSameSite();

  return {
    httpOnly: true,
    path: "/",
    sameSite,
    // SameSite=None is rejected by browsers without Secure, so it is forced on.
    secure: sameSite === "none" ? true : isSecureRequest(req),
  };
}
