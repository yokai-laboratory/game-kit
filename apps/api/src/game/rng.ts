import { randomInt } from "node:crypto";
import type { Rng } from "@game-kit/game-core";

// Crypto-backed RNG injected into every GameModule call. Games take ALL entropy from here so they
// stay deterministic-given-the-seed and unit-testable (a test injects a stubbed Rng). If you later
// want provably-fair / on-chain randomness (commit-reveal, VRF), swap this one implementation and
// no game code changes.
export function cryptoRng(): Rng {
    return {
        // node's randomInt(min, max) is uniform over [min, max).
        int: (minInclusive, maxExclusive) => randomInt(minInclusive, maxExclusive),
        bool: () => randomInt(0, 2) === 1,
        pick: <T>(items: readonly T[]): T => {
            if (items.length === 0) throw new Error("rng.pick: empty array");
            return items[randomInt(0, items.length)] as T;
        },
    };
}
