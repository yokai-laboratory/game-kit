import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { env } from "../env.js";
import * as schema from "./schema.js";

// One better-sqlite3 handle for the whole API. SQLite is the zero-dependency, single-machine
// persistence default: the entire game/room/payment state lives in one file on disk (env.SQLITE_PATH).
// For horizontal scale-out you'd move to a shared Postgres + the Redis backplane (see realtime/hub.ts
// and game/ticker.ts for the swappable seams), but the default path connects to nothing external.
mkdirSync(dirname(env.SQLITE_PATH), { recursive: true });

const sqlite = new Database(env.SQLITE_PATH);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

// One-shot idempotent schema bootstrap. This is the primary migration path for the template: plain
// `CREATE TABLE IF NOT EXISTS` so a fresh deploy stands the schema up with no migration tooling on
// the box. When your schema starts evolving in anger, switch to drizzle-kit generated migrations.
// Type mapping from the Postgres origin: jsonb -> TEXT (JSON serialized by Drizzle), boolean ->
// INTEGER (0/1), bigint -> INTEGER (epoch-ms numbers fit in SQLite's 64-bit integer).
sqlite.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  provider_sub  TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  email         TEXT,
  points        INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  expires_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);

CREATE TABLE IF NOT EXISTS oauth_access_tokens (
  user_id       TEXT PRIMARY KEY REFERENCES users(id),
  access_token  TEXT NOT NULL,
  refresh_token TEXT,
  scope         TEXT NOT NULL,
  token_type    TEXT NOT NULL,
  expires_at    INTEGER,
  issued_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rooms (
  id              TEXT PRIMARY KEY,
  game_id         TEXT NOT NULL,
  host_user_id    TEXT NOT NULL REFERENCES users(id),
  guest_user_id   TEXT REFERENCES users(id),
  stake_eth       TEXT NOT NULL,
  status          TEXT NOT NULL,
  result_kind     TEXT NOT NULL DEFAULT 'pending',
  winner_user_id  TEXT REFERENCES users(id),
  pot_id          TEXT,
  state           TEXT NOT NULL,
  last_move_seat  TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
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
  points_credited  INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  resolved_at      INTEGER,
  expires_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS opi_room_idx ON oauth_payment_intents(room_id);
CREATE INDEX IF NOT EXISTS opi_user_idx ON oauth_payment_intents(user_id, created_at);
CREATE INDEX IF NOT EXISTS opi_status_idx ON oauth_payment_intents(status, expires_at);
`);

// Defensive online-migrations for databases created by an earlier version of this template. SQLite
// lacks `ADD COLUMN IF NOT EXISTS`, so we introspect with PRAGMA table_info first, then conditionally
// ALTER. (Postgres origin expressed these as idempotent `ADD COLUMN IF NOT EXISTS` ALTERs.) On a
// fresh deploy the CREATE TABLEs above already match and these are no-ops.
const userCols = sqlite.prepare(`PRAGMA table_info(users)`).all() as { name: string }[];
if (!userCols.some((c) => c.name === "points")) {
    sqlite.exec(`ALTER TABLE users ADD COLUMN points INTEGER NOT NULL DEFAULT 0`);
}

const intentCols = sqlite.prepare(`PRAGMA table_info(oauth_payment_intents)`).all() as { name: string }[];
if (!intentCols.some((c) => c.name === "kind")) {
    sqlite.exec(`ALTER TABLE oauth_payment_intents ADD COLUMN kind TEXT NOT NULL DEFAULT 'stake'`);
}
if (!intentCols.some((c) => c.name === "credit_points")) {
    sqlite.exec(`ALTER TABLE oauth_payment_intents ADD COLUMN credit_points INTEGER`);
}
if (!intentCols.some((c) => c.name === "points_credited")) {
    sqlite.exec(`ALTER TABLE oauth_payment_intents ADD COLUMN points_credited INTEGER NOT NULL DEFAULT 0`);
}

export const db = drizzle(sqlite, { schema });
export { schema };
export { sqlite };

// Liveness probe for /ready -- a cheap synchronous round-trip that proves the handle can read the
// database. Kept async (returning Promise<boolean>) so callers don't change.
export async function pingDb(): Promise<boolean> {
    try {
        sqlite.prepare("SELECT 1").get();
        return true;
    } catch {
        return false;
    }
}
