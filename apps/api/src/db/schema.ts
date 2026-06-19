import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { RoomResult, RoomStatus, Seat } from "@game-kit/game-core";

// SQLite schema (Drizzle sqlite-core). Timestamps are epoch-ms stored as integer so the code
// reads/writes plain `Date.now()` numbers -- no Date<->column juggling. The schema is GENERIC:
// there is no per-game table. A room's game state lives in `rooms.state` (a JSON text blob), whose
// shape is owned by the active GameModule. Swapping games never touches this file.

export const users = sqliteTable("users", {
    id: text("id").primaryKey(),
    providerSub: text("provider_sub").notNull().unique(),
    displayName: text("display_name").notNull(),
    email: text("email"),
    // In-game points balance. A demo of soft currency / inventory bought via one-way TTG charges
    // (see the store purchase flow). Lives here, not on TTG: TTG custodies real money; points are
    // app state. Real inventory would be its own table -- one integer keeps the example legible.
    points: integer("points").notNull().default(0),
    createdAt: integer("created_at").notNull(),
});

export const sessions = sqliteTable(
    "sessions",
    {
        id: text("id").primaryKey(),
        userId: text("user_id")
            .notNull()
            .references(() => users.id),
        expiresAt: integer("expires_at").notNull(),
        createdAt: integer("created_at").notNull(),
    },
    (t) => [index("sessions_user_idx").on(t.userId)],
);

// Bearer access token issued by TTG at OAuth callback. Persisted because the app-initiated charge
// flow needs the user's bearer to debit them from request paths that don't carry the raw token
// (the events socket, the poll backstop). One row per user; re-auth overwrites via upsert.
export const oauthAccessTokens = sqliteTable("oauth_access_tokens", {
    userId: text("user_id")
        .primaryKey()
        .references(() => users.id),
    accessToken: text("access_token").notNull(),
    refreshToken: text("refresh_token"),
    scope: text("scope").notNull(),
    tokenType: text("token_type").notNull(),
    expiresAt: integer("expires_at"),
    issuedAt: integer("issued_at").notNull(),
});

export const rooms = sqliteTable(
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
        // stake into it; the winner (or both, on a draw) are paid via TTG's signed distributePot.
        potId: text("pot_id"),
        // The GameModule's persisted state blob. Generic on purpose.
        state: text("state", { mode: "json" }).$type<unknown>().notNull(),
        // Which seat (if any) acted last -- lets the engine apply optimistic-concurrency checks.
        lastMoveSeat: text("last_move_seat").$type<Seat>(),
        createdAt: integer("created_at").notNull(),
        updatedAt: integer("updated_at").notNull(),
    },
    (t) => [
        index("rooms_status_idx").on(t.status),
        index("rooms_game_idx").on(t.gameId),
        index("rooms_host_idx").on(t.hostUserId),
        index("rooms_guest_idx").on(t.guestUserId),
    ],
);

// API-side mirror of TTG's oauth_payment_intent for every charge this game initiates. Cached so the
// engine can answer "has user X paid for room Y?" (or "has this purchase settled?") without
// round-tripping TTG. Status is driven by TTG's push (events socket) with the poll backstop as
// recovery. Two shapes share this table, told apart by `kind`:
//   - "stake"    -> a pot stake; `roomId` is set; completion advances the room.
//   - "purchase" -> a one-way store buy; `roomId` is null; completion credits `creditPoints`.
export const oauthPaymentIntents = sqliteTable(
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
        pointsCredited: integer("points_credited", { mode: "boolean" }).notNull().default(false),
        createdAt: integer("created_at").notNull(),
        resolvedAt: integer("resolved_at"),
        expiresAt: integer("expires_at").notNull(),
    },
    (t) => [
        index("opi_room_idx").on(t.roomId),
        index("opi_user_idx").on(t.userId, t.createdAt),
        index("opi_status_idx").on(t.status, t.expiresAt),
    ],
);
