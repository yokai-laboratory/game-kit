import { defineConfig } from "drizzle-kit";

// For the optional "real migrations" upgrade path. The template deploys via the idempotent
// bootstrap (src/db/migrate.ts), but once your schema evolves run:
//   pnpm --filter @game-kit/api exec drizzle-kit generate   # writes ./drizzle/*.sql
//   pnpm --filter @game-kit/api exec drizzle-kit migrate     # applies them
// then point src/db/migrate.ts at drizzle-orm/postgres-js/migrator instead of the bootstrap.
export default defineConfig({
    schema: "./src/db/schema.ts",
    out: "./drizzle",
    dialect: "postgresql",
    dbCredentials: {
        url: process.env.DATABASE_URL ?? "postgres://gamekit:gamekit@localhost:5432/gamekit",
    },
});
