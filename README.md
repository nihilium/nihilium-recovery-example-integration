# nihilium-recovery-example-integration

An example integration of the [Nihilium Recovery SDK](https://github.com/nihilium): a demo wallet
that seals a recovery, loses its keys, and recovers — across three chains, with every role the SDK
separates running as its own code with its own keys.

It is **a demo, not a wallet**. It holds one plaintext 12-word seed phrase (the public Hardhat/Anvil
test mnemonic), prints it on screen, and lets you throw it away on purpose. The code worth taking is
under `app/src/integration/` and `server/src/roles/`; everything else is staging.

> **Recovery covers loss, not theft.** It restores access to an owner who lost it. It does not
> defend a wallet whose seed someone else already holds.

## What is here

| | |
|---|---|
| `app/` | React + Vite. The wallet, the chain registry, and the scenario runner. |
| `app/src/integration/` | **The part to copy.** SDK-facing code that imports nothing from the demo. |
| `server/` | Express. The record host, the watchtower, the three veto authorities and the relayer — one router each. |
| `docs/` | A walkthrough per scenario. |

`CLAUDE.md` states the repository's goal and the rules the code follows; read it before changing
anything here.

## Running it

**Prerequisite:** a sibling checkout of `recovery-sdk`, because four of its packages and the
on-chain bindings are not published to npm yet.

```bash
git clone git@github.com:nihilium/recovery-sdk.git ../recovery-sdk
git -C ../recovery-sdk submodule update --init --recursive
npm --prefix ../recovery-sdk install && npm --prefix ../recovery-sdk run build

npm install
npm run dev          # the app on :5173
npm run dev:server   # the roles on :8787 — prints every role's address and balance
```

Nothing needs configuring: the app runs against public RPCs with a simulated identity ceremony, and
the server derives its role keys from the demo mnemonic when `.env` supplies none. Copy
`app/.env.example` and `server/.env.example` when you want your own.

`npm test`, `npm run typecheck` and `npm run lint` cover both projects.

## The two modes

| | Simulated (default) | Live (`VITE_RECOVERY_MODE=live`) |
|---|---|---|
| identity ceremony | local, instant, free | the real zkEmail ceremony |
| cost | none | **paid**, per member |
| duration | milliseconds | minutes, blocked on a human answering an email |

Everything else is real in both: real key adapters, the real KDF, the real envelope, the real stores.

## What is real, and what is staged

Recovery has an off-chain half (the identity gate) and an on-chain half (what the recovered key is
allowed to do, and how slowly). Only one chain here has both.

| | EVM · Sepolia | Solana · devnet | Zcash · testnet |
|---|---|---|---|
| key derivation, sealing, recovery | real | real | real |
| settlement (register, timelock, veto) | real — `RecoveryModule` on Sepolia | simulated, labelled | simulated, labelled |
| balances | read from chain | simulated, labelled | simulated, labelled |

Zcash is here to make two points: a UTXO chain is *several* addresses per wallet, and its key adapter
is written in this repo rather than shipped by the SDK — that is what adding a chain looks like.
Its transparent addresses have nowhere to register a recovery key, and the UI says so rather than
pretending otherwise.

## Status

Built so far: the app shell and design system, one seed deriving all three chains, and the server's
role scaffolding. Sealing, recovery, the scenario runner, the on-chain settlement and the record
host / watchtower roles are in progress — see `CLAUDE.md` for the shape they are being built into.
