import { bigint, index, integer, jsonb, pgTable, text } from "drizzle-orm/pg-core";
import type { RoomResult, RoomStatus, Seat } from "@game-kit/game-core";

// Postgres schema (Drizzle). Timestamps are epoch-ms stored as bigint(mode:number) so the code
// reads/writes plain `Date.now()` numbers exactly like the SQLite reference did -- no Date<->column
// juggling. The schema is GENERIC: there is no per-game table. A room's game state lives in
// `rooms.state` (jsonb), whose shape is owned by the active GameModule. Swapping games never
// touches this file.

export const users = pgTable("users", {
    id: text("id").primaryKey(),
    providerSub: text("provider_sub").notNull().unique(),
    displayName: text("display_name").notNull(),
    email: text("email"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

export const sessions = pgTable(
    "sessions",
    {
        id: text("id").primaryKey(),
        userId: text("user_id")
            .notNull()
            .references(() => users.id),
        expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
        createdAt: bigint("created_at", { mode: "number" }).notNull(),
    },
    (t) => [index("sessions_user_idx").on(t.userId)],
);

// Bearer access token issued by TTG at OAuth callback. Persisted because the app-initiated charge
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
    expiresAt: bigint("expires_at", { mode: "number" }),
    issuedAt: bigint("issued_at", { mode: "number" }).notNull(),
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
        // stake into it; the winner (or both, on a draw) are paid via TTG's signed distributePot.
        potId: text("pot_id"),
        // The GameModule's persisted state blob. Generic on purpose.
        state: jsonb("state").$type<unknown>().notNull(),
        // Which seat (if any) acted last -- lets the engine apply optimistic-concurrency checks.
        lastMoveSeat: text("last_move_seat").$type<Seat>(),
        createdAt: bigint("created_at", { mode: "number" }).notNull(),
        updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
    },
    (t) => [
        index("rooms_status_idx").on(t.status),
        index("rooms_game_idx").on(t.gameId),
        index("rooms_host_idx").on(t.hostUserId),
        index("rooms_guest_idx").on(t.guestUserId),
    ],
);

// API-side mirror of TTG's oauth_payment_intent for stakes this game initiated. Cached so the
// engine can answer "has user X paid for room Y?" without round-tripping TTG. Status is driven by
// TTG's push (events socket) with the poll backstop as recovery.
export const oauthPaymentIntents = pgTable(
    "oauth_payment_intents",
    {
        id: text("id").primaryKey(),
        roomId: text("room_id")
            .notNull()
            .references(() => rooms.id),
        userId: text("user_id")
            .notNull()
            .references(() => users.id),
        status: text("status").$type<"pending" | "completed" | "denied" | "expired">().notNull().default("pending"),
        paymentId: text("payment_id"),
        txHash: text("tx_hash"),
        usdCents: integer("usd_cents").notNull(),
        chain: text("chain").notNull(),
        idempotencyKey: text("idempotency_key"),
        createdAt: bigint("created_at", { mode: "number" }).notNull(),
        resolvedAt: bigint("resolved_at", { mode: "number" }),
        expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
    },
    (t) => [
        index("opi_room_idx").on(t.roomId),
        index("opi_user_idx").on(t.userId, t.createdAt),
        index("opi_status_idx").on(t.status, t.expiresAt),
    ],
);
