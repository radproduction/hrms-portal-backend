import { defineConfig } from "vitest/config";
import path from "node:path";

const backendRoot = path.resolve(import.meta.dirname);

/**
 * Tests must never touch the real database. Vitest loads `.env` into
 * process.env, and backend/.env holds the production MONGODB_URI — so it is
 * explicitly overridden here. Point TEST_MONGODB_URI at a throwaway database to
 * opt into the integration tests; without it, DB-backed suites skip themselves.
 */
const testMongoUri = process.env.TEST_MONGODB_URI ?? "";

export default defineConfig({
  root: backendRoot,
  resolve: {
    alias: {
      "@shared": path.resolve(backendRoot, "shared"),
    },
  },
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**"],
    // The DB-backed suites share one mongoose connection and one database.
    // Run files one at a time, otherwise a suite closing the connection in its
    // afterAll pulls the database out from under whichever file is still going.
    fileParallelism: false,
    env: {
      MONGODB_URI: testMongoUri,
      JWT_SECRET: process.env.JWT_SECRET ?? "test-secret-not-used-for-real-sessions",
    },
  },
});
