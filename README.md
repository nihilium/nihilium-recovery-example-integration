# nihilium-recovery-example-integration

An example integration of the [Nihilium Recovery SDK](https://github.com/nihilium): a demo wallet
that seals a recovery, loses its keys, and recovers — across three chains, with every role the SDK
separates running as its own code with its own keys.

It is **a demo, not a wallet**. It holds plaintext 12-word seed phrases, prints them on screen, and
lets you throw them away on purpose. Everything that is *recovery* is the SDK's; what is here is the
wiring, the chain configuration and the UI — which is the point.

> **Recovery covers loss, not theft.** It restores access to an owner who lost it. It does not
> defend a wallet whose seed someone else already holds.

## What is SDK and what is example

| The SDK does | This repo does |
|---|---|
| seals a vault, adds chains for free, recovers every chain from one ceremony (`@nihilium/recovery-core`, `-sdk`) | names the guardians, picks a timelock, shows the keys that came out |
| registers the recovery key on-chain and drives the handover (`@nihilium/recovery-settlement-evm`, `-settlement-solana`) | builds the three chain modules: a Safe on Sepolia, a 7702 EOA on Arbitrum Sepolia, a vault PDA on devnet |
| pays gas and publishes the operator's veto keys (`@nihilium/recovery-relayer`) | runs it behind Express with one key per role per chain |
| keeps the ledger, the handovers and the watch (`@nihilium/recovery-storage-indexeddb`) | keeps its database name so earlier vaults survive |
| scans a passport (`@nihilium/recovery-passport-zkpassport`) | renders the QR code |

`app/src/wiring.ts` is where the two meet: one file that builds every SDK instance this app uses.

## What is here

| | |
|---|---|
| `app/` | React + Vite. The wallet, the chain modules, the recovery methods, and the hooks that put SDK calls into React state. |
| `app/src/integration/` | **The part to copy.** Chain modules on the SDK's adapters, and the recovery methods on its gates. Imports nothing from the demo. |
| `app/src/wiring.ts` | The binding point. |
| `server/` | Express. The record host, the watchtower, and the relayer with the operator's veto keys — the SDK's own services, one host each. |
| `docs/` | [Configuration and role keys](docs/configuration.md), [Arbitrum through EIP-7702](docs/arbitrum-7702.md), [email and passport](docs/email-and-passport.md), [the watchtower](docs/watchtower.md). |

`CLAUDE.md` states the repository's goal and the rules the code follows; read it before changing
anything here.

## Running it

**Prerequisite:** a sibling checkout of `recovery-sdk`, because its packages and the on-chain
bindings are not published to npm yet.

```bash
git clone git@github.com:nihilium/recovery-sdk.git ../recovery-sdk
git -C ../recovery-sdk submodule update --init --recursive
npm --prefix ../recovery-sdk install && npm --prefix ../recovery-sdk run build

npm install
npm run dev          # the app on :5173
npm run dev:server   # the roles on :8787 — prints every role's address and balance
```

`npm install` writes `app/.env.local` and `server/.env` from the two `.env.example` templates,
generating one matching pair of credentials for the record host, the relayer's faucet and the
watchtower. Existing files are never overwritten; `npm run setup:env` recreates a missing one.

The ceremony is **live and paid**: sealing buys one zkEmail seal per guardian, and recovering emails
real people. It needs a Nihilium API key in `app/.env.local`; without one the recovery panel says so
rather than running something free. Everything else has a working default: public RPCs, and server
roles derived from `ROLE_MNEMONIC`. [docs/configuration.md](docs/configuration.md) covers all of it.

`npm test`, `npm run typecheck` and `npm run lint` cover all three projects.

## What is real

| | Ethereum · Sepolia | Arbitrum · Sepolia | Solana · devnet | Zcash · testnet |
|---|---|---|---|---|
| account | Safe with Safe7579 | the EOA itself, delegated | recovery vault PDA | transparent addresses |
| key derivation, sealing, recovery | real | real | real | real |
| settlement (register, timelock, veto) | `RecoveryModule`, ERC-7579 | `Eip7702RecoveryAccount` | the recovery vault program | none — and the UI says so |
| watched on-chain | yes | off-chain only (no 7702 probe yet) | yes | — |
| balances | read from chain | read from chain | read from chain | simulated, labelled |

Zcash is here to make two points: a UTXO chain is *several* addresses per wallet, and its key adapter
is written in this repo rather than shipped by the SDK — that is what adding a chain looks like. Its
transparent addresses have nowhere to register a recovery key, and the UI says so rather than
pretending otherwise.
