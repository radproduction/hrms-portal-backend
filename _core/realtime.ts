import type { Server as HttpServer } from "http";
import { Server as SocketIOServer } from "socket.io";
import { getUserIdFromCookieHeader } from "./auth";

let io: SocketIOServer | null = null;

function getAllowedOrigins() {
  const raw = process.env.CORS_ORIGIN;
  if (!raw) return true;
  const origins = raw
    .split(",")
    .map(origin => origin.trim())
    .filter(Boolean);
  return origins.length > 0 ? origins : true;
}

export function initRealtime(server: HttpServer) {
  io = new SocketIOServer(server, {
    cors: {
      origin: getAllowedOrigins(),
      credentials: true,
    },
  });

  io.use(async (socket, next) => {
    const cookieHeader = socket.request.headers.cookie;
    const userId = await getUserIdFromCookieHeader(cookieHeader);
    if (!userId) {
      return next(new Error("UNAUTHORIZED"));
    }
    socket.data.userId = userId;
    socket.join(userId);
    return next();
  });

  io.on("connection", (socket) => {
    socket.on("disconnect", () => {
      // No-op for now.
    });
  });

  return io;
}

export function emitChatMessage(payload: {
  senderId: string;
  recipientId?: string;
}) {
  if (!io) return;

  if (payload.recipientId) {
    io.to(payload.recipientId).emit("chat:new", payload);
    io.to(payload.senderId).emit("chat:new", payload);
    return;
  }

  io.emit("chat:new", payload);
}

export function emitNotification(payload: { userId: string }) {
  if (!io) return;
  io.to(payload.userId).emit("notifications:new", payload);
}

export function emitAnnouncement(payload: { announcementId?: string }) {
  if (!io) return;
  io.emit("announcements:new", payload);
}

export function emitPayslip(payload: { userId: string }) {
  if (!io) return;
  io.to(payload.userId).emit("payslips:new", payload);
}
