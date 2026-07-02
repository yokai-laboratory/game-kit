# The UI shell — the game is the centre of attention

game-kit's web app is a **game-centred shell**: the game owns the screen, and the UI floats above
it as glass. This inverts the old template (a document with a game widget inside) and matches how
flagship Metatron titles are built. Everything here is a **primitive you keep**; your game plugs
into the same seams as always, plus two optional ones.

```
┌────────────────────────── KEEP (the shell) ───────────────────────────┐  ┌── SWAP (your game) ──┐
│ core/shell/  GameSurface (fullscreen backdrop + scrim/vignette)        │  │ games/<id>/screen    │
│              ChromeProvider (immersive mode, scroll lock, boot phase)  │  │ games/<id>/client    │
│              BottomNav (capsule tabs), ShellHeader (3-col header)      │◀▶│   (optional engine   │
│              FullscreenStage (fade-in → tap-to-start → 3·2·1 → play)   │  │    adapter+backdrop) │
│ core/ui/     Avatar, Menu/CtxLink, tokens stylesheet, social rows      │  │ shell.config.tsx     │
└────────────────────────────────────────────────────────────────────────┘  └──────────────────────┘
```

## The three-column pattern

Pages use one scaffold (`.shell-columns`): a sticky **menu** on the left (`MenuButton` groups), the
active tab's **content** in the centre (or the live room when `?room=<id>` is open), and sticky
**context** cards on the right (`.ctx-card`, `CtxLink`). The Play hub and Profile ship as worked
examples. Rooms live *inside* the Play hub — create/join sets `?room=`, the stake step renders in
the centre card (presence widget included), and your registered game screen appears there when the
match goes live. Deep links via `/room/:id` redirect in.

## The game surface

`<GameSurface gameId="…">` renders your game full screen behind the page, under a scrim and
vignette. Register a backdrop in `apps/web/src/games/registry.tsx`:

```ts
const BACKDROPS: Record<string, GameBackdrop> = {
    "my-game": MyGameBackdrop, // fills its absolute inset-0 parent; typically the engine in attract mode
};
```

No backdrop → the shell renders an engine-free animated aurora, so the pattern works before any
engine exists.

## Engine adapters — Unity, Godot, GameMaker, plain canvas, anything

The shell contains **no engine code** and never will. Whatever your game runs on, from the shell's
point of view a web-embedded engine is *a DOM element plus a message bridge*. Your adapter lives in
`games/<id>/` and implements this contract:

1. **ensure(): Promise<boolean>** — load/instantiate the engine once per page (idempotent). Keep
   the instance handle on `window` (module state dies under HMR).
2. **adopt(host)** — re-parent the engine's canvas/iframe into a host element (backdrop or
   fullscreen stage) and keep its buffer sized to the host. `appendChild` moves DOM nodes; one
   instance serves every surface.
3. **startRound(payload) / beginRound()** — build the round ARMED but paused (opening frame,
   clock stopped); `beginRound` starts motion + clock. This is what makes the shell's
   tap-to-start → countdown gate seamless.
4. **onComplete(result)** — hand the player's *input log* back to the shell (never a score — the
   server replays inputs and derives results itself; see HOW-IT-WORKS on the untrusted client).

`FullscreenStage` consumes the contract generically:

```tsx
<FullscreenStage stageKey={`${roomId}:${round}`} prompt="Round 2 of 3" exitLabel="Forfeit"
    exitConfirm="Forfeit this round?" onExit={forfeit}
    hud={<span className="chip">1 – 0</span>}>
    {(begin) => <MyRoundPlayer payload={payload} begin={begin} onFinish={submitLog} fullscreen />}
</FullscreenStage>
```

Engine notes:

- **Unity (WebGL)** — `createUnityInstance` on a canvas with a real `id` (its keyboard hook does
  `querySelector('#'+id)`), buffer = CSS size × a pinned `devicePixelRatio`, bridge via
  `SendMessage` + a `.jslib` callback. Disable build compression to skip server config.
- **Godot (HTML5)** — same shape: engine canvas + `Engine.startGame`, bridge via
  `window` callbacks / `JavaScriptBridge`.
- **GameMaker (GX/HTML5)** — exported canvas + `gml_Script`/browser messaging.
- **Plain canvas/WebGL** — just a React component; implement `begin` as "don't start the clock".
- **Native-engine kits (Unreal, etc.)** are separate kits; this shell is the *web* kit's opinion.
  The concepts (armed rounds, immersive mode, social rows, boot phase) port; the DOM specifics
  don't.

Three browser realities no adapter can escape: OAuth/hosted-pay flows are top-level redirects (a
wasm app reboots on return), the **presence widget is an origin-isolated iframe by design** (a
client that could attest its own presence could fabricate it — float the widget above your canvas),
and text input inside engine canvases is poor on mobile — keep money and identity moments in the
DOM.

## Branding & boot

`shell.config.tsx` is the one file you edit for chrome: brand, tabs (the `primary` tab sits centre
with the glow), and `SHELL_BOOT_MS` — how long the chrome stays hidden after a page load so your
engine's splash owns the screen (the scrim lifts during boot; everything fades in together after).

## What stayed the same

The server seam is untouched: `GameModule` + two registries, the engine, payments, presence. The
shell adds identity polish server-side only where it's generic: the platform avatar is persisted on
the user row at sign-in and carried through `/me` and the lobby listing, so social rows show faces
— use them (`<Avatar>`, `.social-row`) anywhere players meet each other, with names and the amount
at stake visible.
