# Twenty-One Dash (ejected)

This folder is a game-kit game generated from your Titanium Games hosted bundle.

1. Clone the kit: `git clone https://github.com/yokai-laboratory/game-kit` and read its AGENTS.md.
2. Drop this folder in as `games/hosted-b658f0aa/`.
3. Register the module in `apps/api/src/game/registry.ts` and the screen in
   `apps/web/src/games/registry.tsx`; add `@game-kit/game-hosted-b658f0aa` to both apps' dependencies.
4. `pnpm install && pnpm typecheck`, then `./scripts/dev.sh` and play it.

Your hosted rules module runs UNCHANGED (`src/hosted-module.js`) behind the generated adapter in
`src/module.ts`. The hosted screen is preserved verbatim as `hosted-screen.html` for reference;
`src/screen.tsx` is a starter to port it into.

- The adapter maps game-kit's two seats onto the hosted players array (host first).
- Screens are different runtimes: window.ttg there, React props here -- port src/screen.tsx by hand.
- Stakes: the kit's pot flow (stakeEth on room create + TTG charge intents) replaces the hosted stakeTusdCents manifest field.
