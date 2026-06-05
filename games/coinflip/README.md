# @game-kit/game-coinflip — the example game (scrap me)

A two-player coin-flip duel. It exists to demonstrate every primitive end to end; the mechanic itself
is deliberately trivial so you replace it. **This whole folder is the "swap" side of the seam.**

## The mechanic

- Both players secretly pick `heads` or `tails` (hidden until both choose).
- The server flips one coin per round. You win the round if your pick matches the flip and your
  opponent's doesn't; if both match or both miss, it's a push (no winner) — the round still counts.
- After `config.rounds` rounds (default 3), the higher win count takes the pot; a tie refunds both.

## What it shows you

| Primitive | Where |
| --- | --- |
| Hidden simultaneous moves + redaction | `view()` returns `opponentSubmitted` (boolean), never the opponent's live pick |
| Server-authoritative randomness | `applyMove` flips via the injected `rng` |
| Rounds / win tracking / draw path | `applyMove` + `outcome()` |
| Public reveal events | `applyMove` returns a `round_resolved` event |
| Default pot settlement | no `settlement()` override → engine pays winner / refunds draw |

## The three files

- `schema.ts` — zod `state` / `move` / `config` + the per-seat `CoinflipView` type.
- `module.ts` — the `GameModule` implementation (all the logic).
- `screen.tsx` — the React screen (`./screen` export), kept out of the server bundle.

## Make it your own

```bash
cp -r games/coinflip games/<your-id>
```

Rename the package in `package.json` to `@game-kit/game-<your-id>`, rewrite the three files, then
register it in `apps/api/src/game/registry.ts` and `apps/web/src/games/registry.tsx` (and add it as a
dependency of both apps). Delete `games/coinflip` when you're done. Full interface docs:
[../../packages/game-core/README.md](../../packages/game-core/README.md).
