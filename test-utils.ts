import { describe } from "vitest";

/**
 * True only when TEST_MONGODB_URI was supplied, which vitest.config.ts maps onto
 * MONGODB_URI for the test run. Guards suites that write to MongoDB so a plain
 * `pnpm test` can never mutate a real database.
 */
export const hasTestDb = Boolean(process.env.MONGODB_URI);

/** `describe` that skips itself when no throwaway test database is configured. */
export const describeWithDb = hasTestDb ? describe : describe.skip;
