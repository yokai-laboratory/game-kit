import { sql } from "drizzle-orm";
import { db, queryClient } from "./client.js";
import { bootstrapSql } from "./bootstrap-sql.js";
import { logger } from "../logger.js";

// Deploy migration entrypoint (`pnpm db:migrate`). Runs the idempotent bootstrap so a fresh
// Postgres ends up with the full schema, and a re-run on an existing DB is a no-op. The deploy
// stack runs this as a one-shot job before starting the API (see deploy/docker-compose.yml).
async function main(): Promise<void> {
    logger.info("running schema bootstrap");
    await db.execute(sql.raw(bootstrapSql));
    logger.info("schema bootstrap complete");
    await queryClient.end({ timeout: 5 });
}

main().catch((err: unknown) => {
    logger.error({ err }, "migration failed");
    process.exitCode = 1;
    void queryClient.end({ timeout: 5 });
});
