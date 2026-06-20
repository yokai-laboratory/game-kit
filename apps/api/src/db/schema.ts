import { bigint, boolean, index, integer, jsonb, pgTable, text } from "drizzle-orm/pg-core";
import type { RoomResult, RoomStatus, Seat } from "@game-kit/game-core";

// Postgres schema (Drizzle pg-core). Timestamps are epoch-ms stored as `bigint` in `number` mode so
// the code reads/writes plain `Date.now()` numbers -- no Date<->column juggling (epoch-ms fits well
// inside JS's safe-integer range). The schema is GENERIC: there is no per-game table. A room's game
// state lives in `rooms.state` (a jsonb blob), whose shape is owned by the active GameModule.
// Swapping games never touches this file.

// Epoch-ms helper: a 64-bit integer column surfaced to JS as a `number`.
const epochMs = (name: string) => bigint(name, { mode: "number" });

export const users = pgTable("users", {
    id: text("id").primaryKey(),
    providerSub: text("provider_sub").notNull().unique(),
    displayName: text("display_name").notNull(),
    email: text("email"),
    // In-game points balance. A demo of soft currency / inventory bought via one-way TRON charges
    // (see the store purchase flow). Lives here, not on TRON: TRON custodies real money; points are
    // app state. Real inventory would be its own table -- one integer keeps the example legible.
    points: integer("points").notNull().default(0),
    createdAt: epochMs("created_at").notNull(),
});

export const sessions = pgTable(
    "sessions",
    {
        id: text("id").primaryKey(),
        userId: text("user_id")
            .notNull()
            .references(() => users.id),
        expiresAt: epochMs("expires_at").notNull(),
        createdAt: epochMs("created_at").notNull(),
    },
    (t) => [index("sessions_user_idx").on(t.userId)],
);

// Bearer access token issued by TRON at OAuth callback. Persisted because the app-initiated charge
// flow needs the user's bearer to debit them from request paths that don't carry the raw token
// (the events socket, the poll backstop). One row per user; re-auth overwrites via upsert.
export const oauthAccessTokens = pgTable("oauth_access_tokens", {
    userId: text("user_id")
        .primaryKey()
        .references(() => users.id),
    accessToken: text("access_token").notNull(),
    refreshToken: text("refresh_token"),
    scope: text("scope").notNull(),
    tokenType: text("token_type").notNull(),
    expiresAt: epochMs("expires_at"),
    issuedAt: epochMs("issued_at").notNull(),
});

export const rooms = pgTable(
    "rooms",
    {
        id: text("id").primaryKey(),
        // Which GameModule owns this room's state. Looked up in the game registry.
        gameId: text("game_id").notNull(),
        hostUserId: text("host_user_id")
            .notNull()
            .references(() => users.id),
        guestUserId: text("guest_user_id").references(() => users.id),
        stakeEth: text("stake_eth").notNull(),
        status: text("status").$type<RoomStatus>().notNull(),
        resultKind: text("result_kind").$type<RoomResult["kind"]>().notNull().default("pending"),
        winnerUserId: text("winner_user_id").references(() => users.id),
        // On-chain CreditVault pot (0x-prefixed bytes16 hex), minted at room creation. Both players
        // stake into it; the winner (or both, on a draw) are paid via TRON's signed distributePot.
        potId: text("pot_id"),
        // The GameModule's persisted state blob. Generic on purpose.
        state: jsonb("state").$type<unknown>().notNull(),
        // Which seat (if any) acted last -- lets the engine apply optimistic-concurrency checks.
        lastMoveSeat: text("last_move_seat").$type<Seat>(),
        createdAt: epochMs("created_at").notNull(),
        updatedAt: epochMs("updated_at").notNull(),
    },
    (t) => [
        index("rooms_status_idx").on(t.status),
        index("rooms_game_idx").on(t.gameId),
        index("rooms_host_idx").on(t.hostUserId),
        index("rooms_guest_idx").on(t.guestUserId),
    ],
);

// API-side mirror of TRON's oauth_payment_intent for every charge this game initiates. Cached so the
// engine can answer "has user X paid for room Y?" (or "has this purchase settled?") without
// round-tripping TRON. Status is driven by TRON's push (events socket) with the poll backstop as
// recovery. Two shapes share this table, told apart by `kind`:
//   - "stake"    -> a pot stake; `roomId` is set; completion advances the room.
//   - "purchase" -> a one-way store buy; `roomId` is null; completion credits `creditPoints`.
export const oauthPaymentIntents = pgTable(
    "oauth_payment_intents",
    {
        id: text("id").primaryKey(),
        // Discriminator for what a completed intent should do. Defaults to "stake" so existing rows
        // (and the room-stake path) are unchanged.
        kind: text("kind").$type<"stake" | "purchase">().notNull().default("stake"),
        // Set for stakes, null for one-way purchases.
        roomId: text("room_id").references(() => rooms.id),
        userId: text("user_id")
            .notNull()
            .references(() => users.id),
        status: text("status").$type<"pending" | "completed" | "denied" | "expired">().notNull().default("pending"),
        paymentId: text("payment_id"),
        txHash: text("tx_hash"),
        usdCents: integer("usd_cents").notNull(),
        chain: text("chain").notNull(),
        idempotencyKey: text("idempotency_key"),
        // Purchases only: points to grant on completion, and a once-only guard so the credit is
        // applied exactly once no matter which path (charge response, events socket, poll, sync)
        // observes the completion first.
        creditPoints: integer("credit_points"),
        pointsCredited: boolean("points_credited").notNull().default(false),
        createdAt: epochMs("created_at").notNull(),
        resolvedAt: epochMs("resolved_at"),
        expiresAt: epochMs("expires_at").notNull(),
    },
    (t) => [
        index("opi_room_idx").on(t.roomId),
        index("opi_user_idx").on(t.userId, t.createdAt),
        index("opi_status_idx").on(t.status, t.expiresAt),
    ],
);
