# nihilium-recovery-example-integration

A **demo application** whose only product is *example code*: how a wallet integrates the
[Nihilium Recovery SDK](../recovery-sdk). Every screen exists to make one integration point visible
and one file worth copying.

It is not a wallet. It holds one plaintext 12-word seed phrase, in the open, on purpose — the point
is to lose it convincingly, not to guard it.

> **Status:** the wallet, the role identities and the first recovery method (an email quorum, sealed
> and recovered through the live ceremony) exist. Settlement, the watchtower, the veto, the record
> host and the scenario runner do not. This file states the goal; it is not a log of what exists.

## The two things this repo optimises for

1. **Copyability.** Someone reading this repo wants to paste a file into their own app. So the
   SDK-facing code lives apart from the demo chrome, depends on nothing the demo owns, and says at
   the top of each file what to replace. See [The copy line](#the-copy-line).
2. **Honesty about a demo.** A recovery demo that looks production-grade is a liability. "DEMO" is
   visible on every screen, the seed phrase is printed, simulated steps say they are simulated, and
   no copy claims a property the SDK does not deliver. See
   [Claims that must not drift](#claims-that-must-not-drift).

Where those two conflict, copyability wins in `integration/` and honesty wins in `demo/`.

## Shape

```
app/                  React + Vite. The wallet, the roles a user plays, the scenario runner.
  src/integration/    ── THE COPY LINE ──  SDK-facing code, copy-pasteable, no demo imports
    chains/           one module per chain + the registry
    recovery/         seal, addChain, recover, watch registration, settlement bindings
    conditions/       condition adapters and their wiring (simulated + live)
  src/scenarios/      one file per scenario, plus the registry that lists them
  src/demo/           seed phrase, loss simulation, fake funds — demo-only, never copied
  src/ui/             design-system components, layout, the demo banner
server/               Express. Every role that cannot run in a browser, each on its own router.
  src/roles/          records, watchtower, veto, relayer — one directory each
docs/                 per-scenario walkthroughs, written for someone integrating
```

`app/` and `server/` are separate npm projects (like `../keyless-recovery`), each with its own
`package.json`. Root scripts proxy to both.

### The copy line

Everything under `app/src/integration/**` and `server/src/roles/**` must be liftable into another
codebase with a single copy, so:

- It may import `@nihilium/recovery-*`, chain libraries (`viem`, `@solana/kit`, …), and its own
  siblings. **It may not import from `demo/`, `ui/` or `scenarios/`.** Anything demo-shaped arrives
  as a parameter.
- No React outside of a hook that wraps it; the logic is plain functions and classes so a Vue or
  Node caller can use the same file.
- Each file opens with a header comment: **what it does**, **what a real app must replace**, and
  **what it assumes** (e.g. "assumes the seal is already on disk").
- A lint-ish test guards the direction of imports. Document the boundary and then enforce it —
  the SDK's own `boundaries.test.ts` is the model.

`demo/` is the inverse: it may import anything, and nothing outside it may import it except through
props. Simulated loss, fake balances and the plaintext mnemonic live there so a reader can see at a
glance what is theatre.

## Roles

The SDK splits recovery across parties that deliberately do not trust each other. This repo plays
**all of them**, each in its own place, so the separation is legible rather than collapsed into one
process.

| Role | Holds | Lives in | Notes |
|---|---|---|---|
| **Wallet / user** | the seal (bearer), the public component, record ids | `app/src/integration/recovery` | seals, adds chains, recovers, reads watch status |
| **Record host** | encrypted records — inert without the seal | `server/src/roles/records` | `@nihilium/recovery-service` behind Express; §12 value decomposition |
| **Watchtower** | watch registrations, poll results | `server/src/roles/watchtower` | `@nihilium/recovery-watchtower`; pull-only, holds no keys |
| **Pause authority** | one key; may pause an in-flight recovery | `server/src/roles/veto` | separate key, separate route, separate UI panel |
| **Abort authority** | one key; may kill a recovery, irreversibly | `app/src/integration/recovery/settlement/evm` | **the wallet's own active EOA**, signed in the browser — see below |
| **Resume quorum** | k of n member keys; lifts a pause early | `server/src/roles/veto` | three keys, one operator: plural in key material and nothing else |
| **Relayer** | gas, and nothing else | `server/src/roles/relayer` | submits initiate/execute for an account with no funds |
| **Identity processors, DKIM registry** | — | *external* | Nihilium's, not ours; simulated in offline mode |

Three veto roles on one key looks correctly configured and is worthless. The demo therefore gives
each its own key, its own route, and its own visibly separate control — and says why in the UI.

**Abort is the wallet's own key, by decision, and it costs something.** The provider holds pause and
resume because a wallet provider wants those controls; abort sits with the owner so that a recovery
started against someone who still has their keys can always be killed by them. The SDK's §7 says an
abort key must *not* be seed-derived — in true seed loss it is gone exactly when it is needed, so it
cannot back up a Nihilium failure — and `validateVetoConfig` throws on it. This build does not
declare `seedDerived` to the validator, so that check does not fire. The demo therefore calls
`reviewVetoConfig` instead and renders its `unverified` line, which says the check could not be made
rather than that it passed. Anyone copying this should choose a bare owner-held key instead.

`server/` is the only place a private key that is not the demo wallet's may exist. A role there is
an account index against `ROLE_MNEMONIC`, resolved per chain through that chain's own curve and
derivation path — so one phrase gives every role a key on every chain it acts on, and a per-role
`.env` key overrides it, which is the shape a real deployment uses. That and the two generated
shared credentials are documented in [docs/configuration.md](docs/configuration.md).

## Chains and wallets

One 12-word mnemonic (plaintext, fixed by default so a reload does not reset the demo) derives every
chain's keys. The top of the page is a wallet switcher: **EVM (Sepolia)**, **Solana**, **Zcash**,
with room for more.

Adding a chain must mean adding one file under `integration/chains/` and one line in the registry.
Each chain module declares the common surface:

| | |
|---|---|
| `id`, `label`, `icon` | display. `icon` is a **name**, not a component: React may not cross the copy line |
| `namespace` | CAIP-2 — `eip155:11155111`, `solana:devnet`, … (a KDF input; pin it) |
| `tier` | `"smart-account"` or `"script"` — decides which veto capabilities exist at all |
| `keyAdapter` | the SDK's `KeyAdapter`, or one written here |
| `deriveAccounts(seed)` | returns **a list** — account-model chains return one, UTXO chains return several |
| `formatAddress`, `explorerUrl`, `balanceOf` | display and demo funds |
| `settlement` | how a `recoveryPubKey` is registered on this chain, or `null` |

Three things this multiplicity is here to teach, and each is a scenario:

- **`addChain()` is free.** A ceremony is paid, plural and slow; putting a second chain into the
  vault it produced is ~2 ms and local. The UI should make that asymmetry impossible to miss.
- **A key adapter is an extension point.** The SDK ships secp256k1 (`key-evm`) and ed25519
  (`key-solana`). **Zcash has neither an adapter nor a settlement program**, so this repo writes its
  own `KeyAdapter` for it — that is the example, not an accident. It also exercises the multi-address
  case that account-model chains hide.
- **The off-chain half is only half.** Sealing protects nothing until the chain registers the
  recovery key. Only EVM has a real module (`RecoveryModule`, deployed on Sepolia). Solana and Zcash
  settlement is **simulated locally by this repo** and must be labelled as simulated everywhere it
  appears — an unlabelled fake here would teach exactly the wrong lesson.

## Scenarios

The middle and lower page is a scenario runner. A scenario is one self-contained file in
`app/src/scenarios/` exporting a descriptor:

```ts
{
  id, title,
  question,          // the one thing this scenario answers
  roles,             // which of the roles above it involves — rendered as badges
  chains,            // which chains it touches
  mode,              // "simulated" | "live"  (live = paid, slow, human-in-the-loop)
  preconditions,     // e.g. "a sealed vault exists" — checked, and offered as a fix
  steps: [{ label, teaches, run(ctx) }],
}
```

`ctx` gives a scenario the wallet, the chain registry, the SDK instance and a logger; it never gives
it React. Adding a scenario is one file plus one registry line — no globbing, the registry is a
readable list.

Each step logs what it did in SDK terms (`sealVault`, `sealRecord`, `openRecords`, `initiateRecovery`)
so the transcript reads as the API, not as prose. Every scenario links to its file, and to the
section of [`../recovery-sdk/README.md`](../recovery-sdk/README.md) it demonstrates.

Scenarios worth having, roughly in build order:

1. **Seal and recover, one identity** — the whole loop on EVM, simulated condition.
2. **Add a chain** — Solana into an existing vault; no ceremony, no payment.
3. **k-of-n quorum** — three guardians, recover with two, watch the third never get contacted.
4. **Lost seal / lost records** — the two distinct failure modes, and why records belong everywhere
   while the seal does not.
5. **Watchtower alarm** — an unseal begins, the alarm trips, the user still has time.
6. **The graduated veto** — pause, resume by quorum, abort; the ceiling auto-lifting a pause.
7. **A recovery spends the vault** — the aftermath: `spent`, no rotation, re-seal, `discardSpentSeal`.
8. **Relayer-paid recovery** — an account with zero balance recovering anyway.
9. **Provider-hosted records** — the same recovery with records on `server/`, showing what the host
   can and cannot see.

## Live, and only live

The app runs the real ceremony: `ZKEmailConditionAdapter` over Nihilium's processor cohort. Sealing
is **paid**, once per guardian; recovering sends real email to the guardians named and blocks until
those humans reply — minutes, not seconds, and there is no fast path. The UI says so before anything
is spent, and the API key reaching the browser (`NihiliumPaymentProviderClientAPIKEY_DO_NOT_USE`) is
an accepted demo trade-off that belongs in visible copy, not a comment.

**There is no free mode to fall back to, deliberately.** A demo that quietly ran something free
while presenting itself as real would teach the wrong thing about what a recovery costs. Without an
API key there is no method to offer, and the recovery panel says exactly that — it does not
degrade to a simulation.

`DemoEmailConditionAdapter` and its cohort survive under `integration/conditions/simulated/` as
**test fixtures only**, because a suite that bought a seal on every run is a suite nobody runs. They
are not reachable from the app, and their headers say so.

What *is* real regardless of any of this: the DKIM registry check. Whether zkEmail can prove a
domain is a fact about the registry, not about the ceremony, so `preflight` hits the live service
while the user is still typing — and blocks sealing against a domain whose share could never be
opened.

## Claims that must not drift

The SDK is careful about what it promises. A demo is where that care gets thrown away, so these are
binding on UI copy, docs and comments:

- **Recovery covers loss, not theft.** It restores access to an owner who lost it; it does not defend
  a wallet whose seed someone else holds.
- **The key is assembled.** `recover()` returns a scoped, zeroizing capability — not never-assemble
  threshold signing. Never write copy that says the key is never assembled.
- **A recovery spends the vault.** It decrypts every record, exposing every chain's root secret.
  There is no rotation, and a new epoch is not an escape.
- **The seal is bearer material; records are inert without it.** Opposite placement rules: never
  duplicate the seal into the identity factor's domain; do duplicate the records everywhere.
- **A broken watchtower is not a quiet one.** `unknown` never renders as "all clear".
- **Simulated is labelled.** Local settlement, the demo condition and fake balances each say so where
  they are shown, not only in a README.

## Conventions

- **React basics only.** Hooks, context, props. No Redux/Zustand/Jotai/react-query — a reader should
  be able to see where state lives by reading one component. Server calls go through small typed
  `fetch` helpers, not a data layer.
- **Dependencies stay boring.** `@nihilium/recovery-*` from npm; a `file:../recovery-sdk/...` link
  only where a package is not published. Four are not: `recovery-service`, `recovery-watchtower`,
  `recovery-watchtower-evm`, `recovery-watchtower-nihilium` — plus `@nihilium/recovery-onchain-evm`,
  which lives in a git submodule. The record host is built on the first of those, so this is not a
  corner case. Adding any other dependency needs a reason a reader of the example would accept.
- **Do not edit `../recovery-sdk` or `../nihilium-core` from here.** If the SDK needs a change to
  make an example clean, write the example around it and propose the change to Olaf, with what it
  costs us if declined.
- **Comments explain why.** The SDK's own source is the register to match: a comment earns its place
  by explaining a constraint or a trade-off, not by restating the line under it.
- **Status at rest, explanation on demand.** A card shows a heading, at most one sentence, its state
  and its actions; everything longer goes inside `<Explain>` and renders only when the reader turns
  the top-bar toggle on. The test is *reports* versus *teaches*: a domain verdict, a price before a
  paid button, `spent.reason` or the `Demo` tag is a fact about this run and is always visible, while
  why §12 exists or what a quorum survives is true regardless and belongs behind the toggle. Both
  directions are pinned by `app/test/copy.test.ts`. Anything paid, slow or irreversible happens in a
  `Dialog`, not on the page — and a dialog whose operation is in flight is not dismissible.
- **Styling is the nihilium-design-system.** Load the skill before writing any UI and use its
  components and `--nih-*` tokens; do not invent a palette. It is a **light** system — pale-blue
  surface, near-black ink, translucent cards behind hard 2px borders — so dense and
  information-first, not terminal-dark. `../keyless-recovery` is the nearest reference for layout
  density and for the demo-chrome pattern, and for nothing about colour. `@nihilium/ds` is not
  published, so the skill's bundle is vendored into `app/src/ui/vendor/` and updated from there.
- **Commit only when asked.**

## Commands

```bash
npm run dev          # app on :5173
npm run dev:server   # Express on :8787 — prints every role's address on boot
npm run build
npm run typecheck
npm run lint
```

`server/` printing each role's key and address at boot is deliberate: the roles are the lesson, and
the boot log is where a reader first sees there are four of them.

## Where to look

| | |
|---|---|
| [`../recovery-sdk/README.md`](../recovery-sdk/README.md) | the integration surface, and every constraint above stated at length |
| [`../recovery-sdk/examples/quorum-recovery.mjs`](../recovery-sdk/examples/quorum-recovery.mjs) | a working offline tour; the `DemoCondition` pattern this repo builds on |
| `../recovery-sdk/packages/service/README.md` | the record host's routes and its non-capabilities |
| `../recovery-sdk/packages/watchtower/README.md` | the watchtower's routes, and "broken is not quiet" |
| [`../keyless-recovery`](../keyless-recovery) | a production-shaped integration: the provider seam, the relayer, the loss lab |
