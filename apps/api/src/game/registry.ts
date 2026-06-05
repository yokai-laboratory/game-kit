import type { AnyGameModule } from "@game-kit/game-core";
import { coinflip } from "@game-kit/game-coinflip";

// ─────────────────────────────────────────────────────────────────────────────
// The game registry -- the ONE place that knows which games exist.
//
// To add a game: implement a GameModule in games/<id>, add it as a workspace dependency of
// apps/api, and push it into MODULES below. To remove the example: delete games/coinflip and drop
// it here. Nothing else in apps/api is game-aware.
// ─────────────────────────────────────────────────────────────────────────────

const MODULES: readonly AnyGameModule[] = [coinflip];

const byId = new Map<string, AnyGameModule>(MODULES.map((m) => [m.id, m]));

export function getGameModule(id: string): AnyGameModule | undefined {
    return byId.get(id);
}

export function listGames(): { id: string; displayName: string; description: string }[] {
    return MODULES.map((m) => ({ id: m.id, displayName: m.displayName, description: m.description }));
}

// The game offered by default when a create request omits gameId. The lobby uses the first.
export const DEFAULT_GAME_ID = MODULES[0]?.id ?? "coinflip";
