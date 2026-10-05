# The watchtower: noticing a recovery you did not start

A recovery key opened by somebody else is still a recovery. The veto roles can pause or abort it,
but only if someone notices in time. The watchtower is that someone. It holds no keys, has no write
path, and cannot act. It notices, and it says so to whoever asks.

| | file |
|---|---|
| the role, on the server | [`server/src/roles/watchtower/index.ts`](../server/src/roles/watchtower/index.ts) |
| registration and status, copyable | [`app/src/integration/recovery/watch.ts`](../app/src/integration/recovery/watch.ts) |
| the demo's wiring | [`app/src/demo/useWatchtower.ts`](../app/src/demo/useWatchtower.ts) |

## Two planes, and why the first one matters most

- **Off-chain: the unsealing.** A Nihilium unseal publishes its reveal values to the datastream before
  any proof and before any processor answers. `NihiliumRevealProbe` asks whether they are there. It
  fires **while a hostile recovery is still in the ceremony**, before anything exists on a chain to
  pause. The browser's own on-chain polling can never see this.
- **On-chain: the countdown.** Once an intent is submitted, `EvmRecoveryProbe` (Sepolia) and
  `SolanaRecoveryProbe` read the attempt state and compute `actBefore`, the time by which a pause must
  land. They also catch the after-the-fact cases: an epoch that advanced (a recovery completed), or a
  recovery owner that changed (the protection was replaced).

## Registration: automatic here, opt-in in the SDK

The SDK treats watching as opt-in, because registering tells the operator three things: that a vault
exists, which processor cohort protects it, and, with on-chain targets, which accounts. One watch
covering both planes ties those together. This demo registers automatically, since the operator is
this repo's own server. A real wallet asks first.

`watch.ts` builds the registration from two sources:

1. `RecoverySDK.buildWatchRegistration({ publicComponent })` produces the off-chain targets, through
   the method's condition adapter. No ceremony runs.
2. One on-chain target per chain **protected by this vault right now**, built from what the chain holds
   (`recoveryOwner`, `epoch`, and `configNonce` on Solana). Those values exist only after a protect,
   which is why the SDK makes registration a separate, later step.

A watch's targets are fixed, so a changed chain set means a new watch. `syncVaultWatch` registers the
new one first and unregisters the old one second, so there is never a moment with no watch. Target ids
are deterministic, so an unchanged set is a no-op. The hook runs it whenever protection changes, and
keeps the current watch when a chain could not be read, rather than re-registering without it.

The watch id and manage credential live in `localStorage`, not on the vault row. The row is rewritten
by every seal, add and protect. The id changes with the chain set, and an imported vault simply
registers a fresh one.

## Arbitrum: watched off-chain only

`EvmRecoveryProbe` reads the ERC-7579 module. The 7702 account's views take no account argument, so the
probe cannot read it. Arbitrum Sepolia gets the off-chain target, which still catches the unseal, and is
listed on the card under "Not watched on-chain". The missing probe is proposed upstream in
[`sdk-proposals.md` §5](sdk-proposals.md).

## Broken is not quiet

| what the card shows | when |
|---|---|
| **Watched** | healthy, every target answered recently, no alarm |
| **Recovery attempt detected** | any target tripped; with `act before …` once the attempt is on-chain |
| **Watch status unknown** | never polled, degraded, suspended, the watchtower unreachable, or anything else it cannot vouch for |
| **No watchtower** | no watch registered |

Only one of those is green, and `unknown` is never drawn as it. The status line under it is the
watchtower's own `summary` sentence, verbatim.

On an on-chain alarm, the card's **Abort** button appears even when the tripped chain is not the one
on screen, because abort acts on every chain of the vault. Pause and resume are not wired to the card
yet.

## Running it

- **Server:** the role mounts at `/api/watchtower` and polls every `WATCHTOWER_POLL_SECONDS` (15 in the
  demo, 300 in production). `DEMO_ALLOW_FORCED_POLL` adds `POST /api/watchtower/poll`, which the card's
  "check now" uses. The SDK deliberately has no such route.
- **Store:** `LocalWatchStore` under `WATCHES_DIR`, with `heartbeatSeconds` set to the poll interval.
  The default misreports quiet watches as degraded; see [`sdk-proposals.md` §6](sdk-proposals.md).
- **App:** `VITE_WATCH_REGISTER_SECRET` must match the server's `WATCH_REGISTER_SECRET` (`npm run
  setup:env` writes both). Reading a status needs no credential: the watch id is the read capability.
