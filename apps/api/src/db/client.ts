import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { env } from "../env.js";
import * as schema from "./schema.js";

// One postgres-js pool for the whole API. postgres-js multiplexes a small connection pool, which is
// the right shape for a stateless API tier behind a load balancer: each replica keeps its own
// modest pool against the shared Postgres. Tune `max` per replica so (replicas * max) stays under
// Postgres's max_connections.
const queryClient = postgres(env.DATABASE_URL, {
    max: 10,
    onnotice: () => {
        // Swallow Postgres NOTICE chatter (e.g. "IF NOT EXISTS" skips) -- not errors.
    },
});

export const db = drizzle(queryClient, { schema });
export { schema };
export { queryClient };

// Liveness probe for /ready -- a cheap round-trip that proves the pool can reach Postgres.
export async function pingDb(): Promise<boolean> {
    try {
        await db.execute(sql`SELECT 1`);
        return true;
    } catch {
        return false;
    }
}
