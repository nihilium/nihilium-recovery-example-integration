# nihilium-recovery-example-integration

A **demo application** whose only product is *example code*: how a wallet integrates the
[Nihilium Recovery SDK](../recovery-sdk). Every screen exists to make one integration point visible
and one file worth copying.

It is not a wallet. It holds one plaintext 12-word seed phrase, in the open, on purpose — the point
is to lose it convincingly, not to guard it.

> **Status:** the wallet, the role identities, on-chain settlement on all three chains through the
> SDK's settlement adapters, the record host, the watchtower (off-chain unsealing plus Sepolia and
> Solana on-chain; Arbitrum off-chain only), and two recovery methods: an email quorum, and the
> owner's own email and passport fused into one ceremony — both through the live ceremony. The
> orchestration (ledger, protect, one-ceremony recovery, handovers, watch) is the SDK's
> `@nihilium/recovery-sdk`; this repo wires it. This file states the goal; it is not a log of what
> exists.

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
app/                  React + Vite. The wallet and the hooks that put SDK calls into React state.
  src/wiring.ts       the binding point: every SDK instance this app uses, built once
  src/integration/    ── THE COPY LINE ──  SDK-facing code, copy-pasteable, no demo imports
    chains/           one module per chain + the registry; each wraps an SDK settlement adapter
    conditions/       recovery methods on the SDK's gates: subject kinds, presets, copy, live wiring
    costs/, keys/     fee estimation; derivation paths
  src/demo/           seeds, destinations, the hooks (`use*.ts`), the veto config — demo-only
  src/ui/             design-system components, layout, the demo banner
server/               Express. The SDK's three services behind one host each.
  src/index.ts        records, watchtower, and one `RelayerService` for every chain
  src/roles/          records, watchtower — the two with demo affordances around them
packages/keys/        BIP-32 + SLIP-0010 derivation. The one thing both halves must agree on
docs/                 walkthroughs, written for someone integrating
```

What used to be `app/src/integration/recovery/` and `server/src/roles/{relayer,veto}/` — the ledger,
the settlement, the handovers, the relayer — is the SDK now (`@nihilium/recovery-sdk`,
`@nihilium/recovery-settlement-*`, `@nihilium/recovery-relayer`). A wallet copies this repo's
*wiring*, not an implementation of recovery.

`app/`, `server/` and `packages/keys` are separate npm projects (like `../keyless-recovery`), each
with its own `package.json`. Root scripts proxy to all three.

`packages/keys` exists because the server derives **role** keys on two curves and the app derives
wallet keys on the same two. A copy in each would be two implementations that must agree about what
a path means, with vectors in only one — and that failure is silent, because a wrong derivation
still yields a valid key, just for an account nobody named. It holds the scheme and nothing else:
paths stay with whoever owns the branch.

### The copy line

Everything under `app/src/integration/**` and `server/src/roles/**` must be liftable into another
codebase with a single copy, so:

- It may import `@nihilium/recovery-*`, chain libraries (`viem`, `@solana/web3.js`, …), and its own
  siblings. **It may not import from `demo/` or `ui/`.** Anything demo-shaped arrives as a parameter.
- The SDK's settlement packages and `permissionless` are reached **only** from `integration/chains/`
  and `wiring.ts`: an adapter is constructed once and arrives everywhere else as an instance. No file
  here re-derives a digest or a clock; that arithmetic is the SDK's.
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
| **Wallet / user** | the seal (bearer), the public component, record ids | `app/src/demo/use*.ts` over `@nihilium/recovery-sdk` | seals, adds chains, recovers, reads watch status |
| **Record host** | encrypted records — inert without the seal | `server/src/roles/records` | `@nihilium/recovery-service` behind Express; §12 value decomposition |
| **Watchtower** | watch registrations, poll results | `server/src/roles/watchtower` | `@nihilium/recovery-watchtower`; pull-only, holds no keys |
| **Pause authority** | one key; may pause an in-flight recovery | `server/src/index.ts`, `operators.pause` | separate key, separate route (`POST /api/relay/:ns/pause`) |
| **Abort authority** | one key; may kill a recovery, irreversibly | `app/src/demo/useAbort.ts` | **the wallet's own active key**, signed in the browser — see below |
| **Resume quorum** | k of n member keys; lifts a pause early | `server/src/index.ts`, `operators.resume` | three keys, one operator: plural in key material and nothing else |
| **Relayer** | gas, and nothing else | `server/src/index.ts`, `RelayerService` | `@nihilium/recovery-relayer`; submits initiate/execute for an account with no funds |
| **Identity processors, DKIM registry** | — | *external* | Nihilium's, not ours; simulated in offline mode |

Three veto roles on one key looks correctly configured and is worthless. The demo therefore gives
each its own key, its own route, and its own visibly separate control — and says why in the UI.

**Abort is the wallet's own key, which the SDK calls the natural default.** The provider holds pause
and resume because a wallet provider wants those controls; abort sits with the owner, because the
common case is not a rogue Nihilium at all — it is someone opening a recovery while the owner still
has access, and the obvious party to stop that is whoever holds the key. §7 has exactly one hard
rule left: the abort key **must not be seal-gated**, since it would then inherit Nihilium's liveness
and could not back up Nihilium's failure. Seed-derived is explicitly fine — provenance is not what
makes a key a backstop, sitting outside Nihilium's control is. A separate offline key is *stronger*,
because it survives losing the owner key, but that is a tradeoff to offer and never a requirement to
enforce: do not build a UI that forces a distinct abort key, and do not validate against one.

`validateVetoConfig` runs inside the SDK's `protect`, against the context this app declares in
`demo/vetoConfig.ts` — never `{}`, which would make the seal-gated check silently unrunnable. The
chain cannot make that check: the module will install a config whose pause authority also sits in
the resume quorum without complaint.

`server/` is the only place a private key that is not the demo wallet's may exist. A role there is
an account index against `ROLE_MNEMONIC`, resolved per chain through that chain's own curve and
derivation path — so one phrase gives every role a key on every chain it acts on, and a per-role
`.env` key overrides it, which is the shape a real deployment uses. That and the two generated
shared credentials are documented in [docs/configuration.md](docs/configuration.md).

## Chains and wallets

One 12-word mnemonic (plaintext, fixed by default so a reload does not reset the demo) derives every
chain's keys. The top of the page is a wallet switcher: **EVM (Sepolia)**, **Arbitrum (Sepolia)**,
**Solana**, **Zcash**, with room for more.

Adding a chain must mean adding one file under `integration/chains/` and one line in the registry.
Each chain module declares the common surface:

| | |
|---|---|
| `id`, `label`, `icon` | display. `icon` is a **name**, not a component: React may not cross the copy line |
| `namespace` | CAIP-2 — `eip155:11155111`, `SOLANA_NAMESPACE.devnet`, … (a KDF input; never hand-written — `solana:devnet` is not a chain id) |
| `tier` | `"smart-account"`, `"delegated-eoa"` or `"script"` — which veto capabilities can exist; not a KDF input |
| `keyAdapter` | the SDK's `KeyAdapter`, or one written here |
| `deriveAccounts(seed)` | returns **a list** — account-model chains return one, UTXO chains return several; each account's `signer.executor()` is the SDK's `AccountExecutor` for it |
| `formatAddress`, `explorerUrl`, `balanceOf` | display and funds |
| `settlement` | the SDK's `SettlementAdapter` for this chain's construction, or `null` |
| `sweep` | moving value out of a *recovered* account as its new owner — a wallet concern, so it lives here |

Three things this multiplicity is here to teach, and each is a scenario:

- **`addChain()` is free.** A ceremony is paid, plural and slow; putting a second chain into the
  vault it produced is ~2 ms and local. The UI should make that asymmetry impossible to miss.
- **A key adapter is an extension point.** The SDK ships secp256k1 (`key-evm`) and ed25519
  (`key-solana`). **Zcash has neither an adapter nor a settlement program**, so this repo writes its
  own `KeyAdapter` for it — that is the example, not an accident. It also exercises the multi-address
  case that account-model chains hide.
- **The off-chain half is only half.** Sealing protects nothing until the chain registers the
  recovery key. Sepolia installs `RecoveryModule` on a Safe; Arbitrum Sepolia delegates a plain EOA
  to `Eip7702RecoveryAccount` (see [docs/arbitrum-7702.md](docs/arbitrum-7702.md)); Solana registers
  with the recovery vault program. **Zcash has no settlement at all**, and anything shown for it
  must be labelled as simulated — an unlabelled fake here would teach exactly the wrong lesson.

## The flow, and where each step lives

Every transcript line names the SDK call that produced it (`createVault`, `addChain`, `register`,
`openRecords`, `initiate`, `execute`), so the screen reads as the API rather than as prose.

| Step | SDK | Here |
|---|---|---|
| seal, and add a second chain for free | `sealVault`, `addChain` | `useRecoveryFlow.ts` |
| protect every funded chain, one press | `protect`, `protectAll` | `useSettlement.ts`, `useProtectAll.ts` |
| recover every chain from one ceremony | `recoverVault` over core's `recoverAll` | `useRecoveryFlow.ts` |
| submit intents now, finish after the timelock with no key | `submitHandovers`, `moveHandovers` | `useRecoveryFlow.ts`, `useHandovers.ts` |
| refuse a recovery as the owner | `abortRecoveries` | `useAbort.ts` |
| pause and resume as the operator | `RelayerService` operator routes | `server/src/index.ts` |
| notice a recovery somebody else started | `buildVaultWatch`, `syncVaultWatch` | `useWatchtower.ts` |
| a recovery spends the vault | `markSpent`, `discardVault` | `useRecoveryFlow.ts`, `useHandovers.ts` |

## Live, and only live

The app runs the real ceremony: `ZKEmailConditionAdapter` over Nihilium's processor cohort. Sealing
is **paid**, once per guardian; recovering sends real email to the guardians named and blocks until
those humans reply — minutes, not seconds, and there is no fast path. The UI says so before anything
is spent. The Nihilium API key is the **server's** (`NIHILIUM_API_KEY`): the app pays through
`BackendPaymentProvider` → the server's `PaymentTokenService`, so the key never reaches the bundle.
The app authenticates with the record append secret, which does, so `NIHILIUM_MAX_TOKENS_PER_HOUR`
is the real spend bound.

**There is no free mode to fall back to, deliberately.** A demo that quietly ran something free
while presenting itself as real would teach the wrong thing about what a recovery costs. Without an
API key on the server the payment route is not mounted, and the banner says exactly that — it does not
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
  only where a package is not published — which today is all of them, including the on-chain
  bindings in a git submodule. `scripts/check-sdk-checkout.mjs` lists the links. Two copies of viem
  come with linking (the app's and the SDK's); `integration/chains/sdkClients.ts` is the one place
  that bridges them, and it goes when the SDK installs from npm. Adding any other dependency needs a
  reason a reader of the example would accept.
- **Do not edit `../recovery-sdk` or `../nihilium-core` from here.** If the SDK needs a change to
  make an example clean, write the example around it and propose the change to Olaf, with what it
  costs us if declined.
- **Comments explain why.** The SDK's own source is the register to match: a comment earns its place
  by explaining a constraint or a trade-off, not by restating the line under it.
- **Status and actions, and nothing else.** A card shows a heading, at most one sentence, its state
  and its actions. There is no explanation layer: the `<Explain>` toggle this app used to carry was
  removed, and `app/test/copy.test.ts` fails if one comes back. What the screen owes the reader is
  facts about *this run* — a domain verdict, a price before a paid button, `spent.reason`, what a
  recovery cost, the `Demo` tag — and that test pins each of them by name, with the reason it
  matters. Teaching belongs in file headers and in `docs/`, where it is read by someone who came
  looking. Copy earns its place by reporting, not by explaining; no rhetorical asides. Anything paid,
  slow or irreversible happens in a `Dialog`, not on the page — and a dialog whose operation is in
  flight is not dismissible.
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
| [`../recovery-sdk/examples/`](../recovery-sdk/examples/) | `key-only.mjs` (Tier 0), `settlement-evm.mjs` and `settlement-solana.mjs` (Tier 1), `quorum-recovery.mjs` |
| `../recovery-sdk/packages/sdk/README.md` | the orchestration this repo's hooks call |
| `../recovery-sdk/packages/relayer/README.md` | the relayer's routes and its non-capabilities |
| `../recovery-sdk/packages/service/README.md` | the record host's routes and its non-capabilities |
| `../recovery-sdk/packages/watchtower/README.md` | the watchtower's routes, and "broken is not quiet" |
| [`../keyless-recovery`](../keyless-recovery) | a production-shaped integration: the provider seam, the relayer, the loss lab |
