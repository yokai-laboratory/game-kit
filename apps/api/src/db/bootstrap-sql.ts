// Idempotent schema bootstrap. This is the primary migration path for the template: it's plain
// `CREATE TABLE IF NOT EXISTS` so a fresh deploy stands the schema up with no migration tooling on
// the box (the deploy runs `pnpm db:migrate`, which just executes this). When your schema starts
// evolving in anger, switch to drizzle-kit generated migrations (drizzle.config.ts is already
// wired) and replace this with the migrator -- see apps/api/src/db/migrate.ts.
//
// Kept as a TS string (not a .sql file) so it ships in the compiled dist/ without a copy step.

export const bootstrapSql = /* sql */ `
CREATE TABLE IF NOT EXISTS users (
  id            text PRIMARY KEY,
  provider_sub  text NOT NULL UNIQUE,
  display_name  text NOT NULL,
  email         text,
  created_at    bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id          text PRIMARY KEY,
  user_id     text NOT NULL REFERENCES users(id),
  expires_at  bigint NOT NULL,
  created_at  bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);

CREATE TABLE IF NOT EXISTS oauth_access_tokens (
  user_id       text PRIMARY KEY REFERENCES users(id),
  access_token  text NOT NULL,
  refresh_token text,
  scope         text NOT NULL,
  token_type    text NOT NULL,
  expires_at    bigint,
  issued_at     bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS rooms (
  id              text PRIMARY KEY,
  game_id         text NOT NULL,
  host_user_id    text NOT NULL REFERENCES users(id),
  guest_user_id   text REFERENCES users(id),
  stake_eth       text NOT NULL,
  status          text NOT NULL,
  result_kind     text NOT NULL DEFAULT 'pending',
  winner_user_id  text REFERENCES users(id),
  pot_id          text,
  state           jsonb NOT NULL,
  last_move_seat  text,
  created_at      bigint NOT NULL,
  updated_at      bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS rooms_status_idx ON rooms(status);
CREATE INDEX IF NOT EXISTS rooms_game_idx ON rooms(game_id);
CREATE INDEX IF NOT EXISTS rooms_host_idx ON rooms(host_user_id);
CREATE INDEX IF NOT EXISTS rooms_guest_idx ON rooms(guest_user_id);

CREATE TABLE IF NOT EXISTS oauth_payment_intents (
  id               text PRIMARY KEY,
  room_id          text NOT NULL REFERENCES rooms(id),
  user_id          text NOT NULL REFERENCES users(id),
  status           text NOT NULL DEFAULT 'pending',
  payment_id       text,
  tx_hash          text,
  usd_cents        integer NOT NULL,
  chain            text NOT NULL,
  idempotency_key  text,
  created_at       bigint NOT NULL,
  resolved_at      bigint,
  expires_at       bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS opi_room_idx ON oauth_payment_intents(room_id);
CREATE INDEX IF NOT EXISTS opi_user_idx ON oauth_payment_intents(user_id, created_at);
CREATE INDEX IF NOT EXISTS opi_status_idx ON oauth_payment_intents(status, expires_at);
`;
