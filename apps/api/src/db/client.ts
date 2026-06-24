import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { env } from "../env.js";
import * as schema from "./schema.js";

// One Postgres connection pool for the whole API. Postgres is the shared persistence the realtime
// engine serializes on (row-locked `SELECT ... FOR UPDATE` in game/engine.ts) and is what lets the
// API tier run multiple replicas behind a load balancer alongside the Redis backplane + tick lease
// (realtime/hub.ts, game/ticker.ts). Connection string is env.DATABASE_URL (12-factor).
const pool = new pg.Pool({ connectionString: env.DATABASE_URL });

// One-shot idempotent schema bootstrap. This is the primary migration path for the template: plain
// `CREATE TABLE IF NOT EXISTS` so a fresh deploy stands the schema up with no migration tooling on
// the box. When your schema starts evolving in anger, switch to drizzle-kit generated migrations.
// Epoch-ms timestamps are BIGINT (JS `number` in the Drizzle layer); the room state blob is JSONB.
await pool.query(`
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  provider_sub  TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  email         TEXT,
  points        INTEGER NOT NULL DEFAULT 0,
  created_at    BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  expires_at  BIGINT NOT NULL,
  created_at  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);

CREATE TABLE IF NOT EXISTS oauth_access_tokens (
  user_id       TEXT PRIMARY KEY REFERENCES users(id),
  access_token  TEXT NOT NULL,
  refresh_token TEXT,
  scope         TEXT NOT NULL,
  token_type    TEXT NOT NULL,
  expires_at    BIGINT,
  issued_at     BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS rooms (
  id              TEXT PRIMARY KEY,
  game_id         TEXT NOT NULL,
  host_user_id    TEXT NOT NULL REFERENCES users(id),
  guest_user_id   TEXT REFERENCES users(id),
  stake_eth       TEXT NOT NULL,
  currency        TEXT NOT NULL DEFAULT 'eth',
  status          TEXT NOT NULL,
  result_kind     TEXT NOT NULL DEFAULT 'pending',
  winner_user_id  TEXT REFERENCES users(id),
  pot_id          TEXT,
  state           JSONB NOT NULL,
  last_move_seat  TEXT,
  created_at      BIGINT NOT NULL,
  updated_at      BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS rooms_status_idx ON rooms(status);
CREATE INDEX IF NOT EXISTS rooms_game_idx ON rooms(game_id);
CREATE INDEX IF NOT EXISTS rooms_host_idx ON rooms(host_user_id);
CREATE INDEX IF NOT EXISTS rooms_guest_idx ON rooms(guest_user_id);

CREATE TABLE IF NOT EXISTS oauth_payment_intents (
  id               TEXT PRIMARY KEY,
  kind             TEXT NOT NULL DEFAULT 'stake',
  room_id          TEXT REFERENCES rooms(id),
  user_id          TEXT NOT NULL REFERENCES users(id),
  status           TEXT NOT NULL DEFAULT 'pending',
  payment_id       TEXT,
  tx_hash          TEXT,
  usd_cents        INTEGER NOT NULL,
  chain            TEXT NOT NULL,
  idempotency_key  TEXT,
  credit_points    INTEGER,
  points_credited  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at       BIGINT NOT NULL,
  resolved_at      BIGINT,
  expires_at       BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS opi_room_idx ON oauth_payment_intents(room_id);
CREATE INDEX IF NOT EXISTS opi_user_idx ON oauth_payment_intents(user_id, created_at);
CREATE INDEX IF NOT EXISTS opi_status_idx ON oauth_payment_intents(status, expires_at);

-- Defensive online-migrations for databases created by an earlier version of this template.
-- Postgres supports idempotent ADD COLUMN IF NOT EXISTS, so on a fresh deploy these are no-ops.
ALTER TABLE users ADD COLUMN IF NOT EXISTS points INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'eth';
ALTER TABLE oauth_payment_intents ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'stake';
ALTER TABLE oauth_payment_intents ADD COLUMN IF NOT EXISTS credit_points INTEGER;
ALTER TABLE oauth_payment_intents ADD COLUMN IF NOT EXISTS points_credited BOOLEAN NOT NULL DEFAULT FALSE;
`);

export const db = drizzle(pool, { schema });
export { schema };
export { pool };

// Liveness probe for /ready -- a cheap round-trip that proves the pool can reach the database.
export async function pingDb(): Promise<boolean> {
    try {
        await pool.query("SELECT 1");
        return true;
    } catch {
        return false;
    }
}
