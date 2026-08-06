import mongoose from "mongoose";

const MONGODB_URI = process.env.MONGODB_URI;

/**
 * mongoose.STATES.connected === 1. Reading the live readyState instead of
 * caching a boolean matters: a cached flag stays true after the connection
 * drops or is closed, so callers think they have a database and every query
 * fails against a dead socket.
 */
function isConnected(): boolean {
  return mongoose.connection.readyState === 1;
}

/** In-flight connect attempt, so concurrent callers share one dial. */
let connecting: Promise<boolean> | null = null;

export async function connectToMongoDB(): Promise<boolean> {
  if (isConnected()) return true;
  if (connecting) return connecting;

  if (!MONGODB_URI) {
    console.warn("[MongoDB] MONGODB_URI is not configured");
    return false;
  }

  connecting = (async () => {
    try {
      await mongoose.connect(MONGODB_URI);
      console.log("[MongoDB] Connected successfully");
      return true;
    } catch (error) {
      console.error("[MongoDB] Failed to connect", error);
      // Deliberately not thrown: the app should still boot so the failure is
      // visible in the logs rather than as a crash loop.
      return false;
    } finally {
      connecting = null;
    }
  })();

  return connecting;
}

// Graceful shutdown
process.on("SIGINT", async () => {
  if (isConnected()) {
    await mongoose.connection.close();
    console.log("[MongoDB] Connection closed");
  }
  process.exit(0);
});
