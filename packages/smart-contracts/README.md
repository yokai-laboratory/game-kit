# `@game-kit/smart-contracts` — optional custom on-chain logic

> **This package is OPTIONAL and is an EXAMPLE scaffold.** Most games built on the
> Titanium Games (TTG) platform never need it: payments, entry fees, pots, prize
> escrow and signed payouts all flow through **TTG's platform rails** (the
> `CreditVault` pots in the TTG monorepo, reached off-chain via the TTG SDK). Reach
> for this package only when your game needs its **own** bespoke on-chain logic —
> e.g. an on-chain match-result attestation, a custom leaderboard, an NFT mint, or a
> commit-reveal scheme — that goes beyond what TTG's pots already do.
>
> The included `GameSettlement` contract is a throwaway example. Replace it with your
> game's contracts, or delete this whole directory if you don't need it.

It is **not** a pnpm workspace package on purpose: there is intentionally **no
`package.json` here**, so the `packages/*` workspace glob ignores it. It is a
standalone [Foundry](https://book.getfoundry.sh/) project managed with `forge`.

## What's inside

| Path | Purpose |
| --- | --- |
| `src/GameSettlement.sol` | EXAMPLE match-result attestor / registry. Holds no funds. |
| `test/GameSettlement.t.sol` | forge-std tests (happy path + access-control + double-report). |
| `script/Deploy.s.sol` | EXAMPLE deploy script (broadcasts `GameSettlement`). |
| `foundry.toml` | solc `0.8.35`, optimizer + `via_ir` on, soldeer deps. |

## Toolchain

- **Foundry** — install via `curl -L https://foundry.paradigm.xyz | bash && foundryup`.
- **Solidity `0.8.35`**, optimizer on (`200` runs), `via_ir = true` — matched to the
  TTG platform contracts.
- Dependencies are managed with **[soldeer](https://soldeer.xyz/)** (declared in
  `foundry.toml` + pinned in `soldeer.lock`, installed into `dependencies/`), the same
  mechanism TTG uses. Only `forge-std` is vendored for this example.

## Install · build · test

```bash
# from this directory: packages/smart-contracts/

# 1. install pinned dependencies into dependencies/ (creates soldeer.lock if missing)
forge soldeer install

# 2. compile
forge build

# 3. run the tests
forge test
# verbose traces: forge test -vvvv
```

> `dependencies/` (and `out/`, `cache/`, `broadcast/`) are git-ignored, so a fresh
> clone must run `forge soldeer install` before building. The install step is fully
> reproducible from `foundry.toml` + `soldeer.lock`.

## Deploy to local Anvil

The optional `deploy/docker-compose.anvil.yml` overlay (at the repo root) runs an
[Anvil](https://book.getfoundry.sh/anvil/) node on **`http://localhost:8545`**. You can
also just run `anvil` directly. Anvil prints ten funded dev accounts on boot.

```bash
# anvil account #0 — a well-known PUBLIC dev key. NEVER use it on a real network.
export PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80

# optional: point the owner (backend signer) at a different account than the deployer
# export SETTLEMENT_OWNER=0x70997970C51812dc3A010C7d01b50e0d17dc79C8

forge script script/Deploy.s.sol:Deploy \
  --rpc-url http://localhost:8545 \
  --broadcast
```

The script logs the deployed `GameSettlement` address. Copy it from the console output
(or from `broadcast/Deploy.s.sol/<chainId>/run-latest.json`).

## Wiring the deployed address into the app

Expose the address to the game's frontend/backend via env, then read it with the TTG
SDK / [viem](https://viem.sh/):

```bash
# apps/web/.env.local (or your service's env)
NEXT_PUBLIC_GAME_SETTLEMENT_ADDRESS=0xYourDeployedAddress
NEXT_PUBLIC_GAME_CHAIN_RPC_URL=http://localhost:8545
```

```ts
import {createPublicClient, http} from "viem";

const client = createPublicClient({transport: http(process.env.NEXT_PUBLIC_GAME_CHAIN_RPC_URL)});

const match = await client.readContract({
  address: process.env.NEXT_PUBLIC_GAME_SETTLEMENT_ADDRESS as `0x${string}`,
  abi: gameSettlementAbi, // generate from out/GameSettlement.sol/GameSettlement.json
  functionName: "getMatch",
  args: [matchId],
});
```

The backend signer (the deployer / `SETTLEMENT_OWNER` account) is the only address that
can call `openMatch` / `reportResult`, so those writes belong in a trusted server, not
the browser.

## Reminder: money still flows through TTG

This example contract is a registry, not a vault — it deliberately custodies nothing.
For anything involving real value (entry fees, pots, payouts, fees, disputes), use the
TTG `CreditVault` pots through the platform SDK. Keep bespoke contracts here scoped to
game-specific logic that the platform doesn't already provide.
