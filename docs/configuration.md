# Configuration, secrets and role keys

Everything this demo needs to run, where it comes from, and which parts are demo shortcuts you must
not copy into a wallet.

There are two `.env` files and they are not independent — `app/.env.local` and `server/.env` share a
pair of credentials, and the app half is `VITE_`-prefixed because Vite only exposes variables under
that prefix to browser code.

```
npm install          # writes both files if missing, then never touches them again
npm run setup:env    # the same step, on demand
```

Neither file is committed; both are gitignored. The templates beside them (`.env.example`) are, and
they carry the explanation of every key.

---

## The two generated credentials

| | `RECORD_APPEND_SECRET` | `WATCH_REGISTER_SECRET` |
|---|---|---|
| held by | the wallet, beside its seal | the wallet operator |
| authorises | appending a record to the record host | registering a watch with the watchtower |
| does **not** authorise | reading a record | reading a watch's status |

Both are **write capabilities**, which is why they are generated per machine rather than shipped as
constants in the templates: a credential committed to a repository is a credential every clone of
that repository shares. Reading needs neither — a record id is its own read capability (120
unguessable bits yielding ciphertext), and a `watchId` is a read capability on an alarm. That
asymmetry is the SDK's design, and the configuration is shaped to keep it visible rather than
contradict it.

### The pair is the unit

`scripts/setup-env.mjs` never modifies an existing file, and it never mints a secret that
contradicts one. Concretely:

| Starting state | What happens |
|---|---|
| neither file exists | one fresh pair is generated, written to both |
| one file exists | the missing one is rebuilt **from the survivor's values** |
| both exist | nothing, even if they disagree — it says so and leaves it to you |

The middle row is the one that matters. Regenerating only the missing half would produce two files
that each look fine and disagree, and nothing would notice until the record host answered `403` to
an append — long after the change that caused it. If the script ever reports that the two differ,
fix one by hand; it will not choose for you.

---

## Server role keys

A role is a **party**, not a key. The same party needs a key on every chain it acts on, and those
keys are not interchangeable: EVM wants secp256k1 at one derivation path, Solana ed25519 at another.
A hex string in `.env` can only ever be one of them.

So a role is an **account index against `ROLE_MNEMONIC`**, and each chain declares how that index
becomes key material — `ROLE_CHAINS` in [`server/src/roleIdentity.ts`](../server/src/roleIdentity.ts):

```ts
"eip155:11155111": {
    namespace: "eip155:11155111",
    curve: "secp256k1",
    path: (index) => `m/44'/60'/1'/0/${index}`,
    addressOf: toEvmAddress,
}
```

`identity.on(namespace)` returns the key plus an `Authority` (`{namespace, id}`) — the shape a
`VetoConfig` names its authorities with, so the value flows straight into the module's install data.

| Role | Index | Acts on |
|---|---|---|
| relayer | 0 | submits `initiateRecovery` / `executeRecovery`, pays gas, funds the demo account |
| pause authority | 1 | `pause` — may stall an in-flight recovery, and nothing else |
| abort authority | 2 | `abort` — may kill one, irreversibly |
| resume members | 10, 11, 12 | a threshold of them lifts a pause early |

Role keys sit on coin-type branch `1'` where a wallet uses `0'`, so a role key can never collide
with an account the demo wallet is showing.

### Adding a chain the roles act on

One entry in `ROLE_CHAINS`. If that chain is on a curve other than secp256k1, `deriveOnCurve` throws
rather than deriving — BIP-32 is secp256k1-only, and using it for ed25519 yields a valid key for an
account nobody named. Wiring ed25519 means promoting `app/src/integration/keys/` to a workspace
package both halves import, rather than copying SLIP-0010 into the server.

The watchtower needs none of this: it holds no keys by construction, so watching another chain is a
probe and an RPC endpoint, not a derivation.

---

## What is a demo shortcut

Three things here are deliberate conveniences, and each is the wrong shape for production:

1. **One phrase derives every role.** The three veto authorities are supposed to be three separate
   parties — that is the entire mechanism: no single compromise reaches two of them, and no veto key
   can move funds alone. Deriving them from one phrase throws that away while leaving everything
   looking correctly configured. The boot banner says so on every start.
2. **`ROLE_MNEMONIC` is required, and generated per machine.** It used to fall back to the
   Hardhat/Anvil phrase, chosen so nobody could mistake it for a wallet worth funding. That
   backfired: those addresses are derivable by anyone, so strangers fund them, sweep them and
   repurpose them — the Solana account that phrase derives is now somebody else's durable nonce
   account, which is what made `create_vault` fail with `Transfer: 'from' must not carry data`. Role
   keys hold gas and veto authority, so `npm run setup:env` now mints a phrase for this machine and
   the server refuses to start without one. The addresses are still stable across restarts; you
   still fund them once.
3. **The wallet's seed is generated in the browser.** `app/src/demo/seeds.ts` mints one on first run
   and keeps it in `localStorage` in the clear, so the
   demo can show it and lose it on command. A wallet keeps a seed in a device keystore and never
   lets it reach application code.

**The production shape is already supported.** Setting a role's key in `server/.env`
(`PAUSE_AUTHORITY_PRIVATE_KEY`, …) stops that role being derived, and each party supplies its own
from wherever it keeps it. A real deployment holds no phrase that derives all of them.

---

## Reference

### `server/.env`

| Key | Default | Notes |
|---|---|---|
| `PORT`, `CORS_ORIGIN` | `8787`, `http://localhost:5173` | |
| `CHAIN_ID`, `SEPOLIA_RPC_URL` | Sepolia, a public RPC | `CHAIN_ID` also forms the CAIP-2 namespace |
| `ROLE_MNEMONIC` | the public demo phrase | every role's keys derive from this |
| `RELAYER_PRIVATE_KEY`, `PAUSE_AUTHORITY_PRIVATE_KEY`, `ABORT_AUTHORITY_PRIVATE_KEY`, `RESUME_MEMBER_PRIVATE_KEYS` | derived | per-role overrides; secp256k1 only |
| `RESUME_THRESHOLD` | `2` | k of the resume members. `validateVetoConfig` refuses 1 unless the account is declared low-value |
| `TIMELOCK_SECONDS`, `PAUSE_CEILING_SECONDS` | `300`, `900` | wall-clock seconds (module v2; v1 counted blocks) |
| `RECORDS_DIR`, `WATCHES_DIR` | `./.data/*` | ciphertext and watch state; neither holds a seal |
| `RECORD_APPEND_SECRET`, `WATCH_REGISTER_SECRET` | **generated** | required; must match the app's copy |
| `WATCHTOWER_POLL_SECONDS` | `15` | 300 in production — 15 so a scenario need not wait |
| `DEMO_ALLOW_FORCED_POLL` | `true` | adds `POST /api/watchtower/poll`, which the watchtower's own API deliberately lacks |
| `DEMO_FUND_MAX_WEI` | 0.02 ETH | ceiling on the relayer's funding route |
| `LOG_STACKS` | unset | `1` for full stack traces |

### `app/.env.local`

| Key | Default | Notes |
|---|---|---|
| `VITE_NIHILIUM_THRESHOLD`, `VITE_NIHILIUM_PROCESSOR_COUNT` | `1`, `1` | Nihilium's **processor** cohort, not the guardian quorum. One processor is published |
| `VITE_SERVER_URL` | `http://localhost:8787` | |
| `VITE_SEPOLIA_RPC_URL`, `VITE_BUNDLER_URL` | public endpoints | |
| `VITE_DEMO_MNEMONIC` | the phrase in `src/demo/mnemonic.ts` | the wallet's seed, not the roles' |
| `VITE_RECORD_APPEND_SECRET`, `VITE_WATCH_REGISTER_SECRET` | **generated** | must match `server/.env` |
| `VITE_NIHILIUM_API_KEY` | **required** | the ceremony is paid and there is no free mode; without it the recovery panel says so rather than degrading to a simulation. Reaches the browser, which is an accepted demo trade-off — it is a spend limit on sealing, not access to funds |
| `VITE_NIHILIUM_API_URL`, `VITE_NIHILIUM_EMAIL_SERVICE_URL` | `api.nihilium.io`, `zkemail.nihilium.io` | where the ceremony runs, and where the DKIM registry check asks |

---

## Troubleshooting: `ENOSPC: System limit for number of file watchers reached`

`npm run dev` or `npm run dev:server` dies at startup, naming a file that has nothing wrong with it.
It is the Linux inotify limit, and there are two halves to it.

**This repo's half, already fixed.** The SDK arrives through `file:` links, which are symlinks into
a sibling checkout — so the dev servers resolve them to real paths *outside* this project, where the
default `node_modules` ignores never match. Left alone they watch all ~33,000 files of
`../recovery-sdk` (and `nihilium-core`'s client-sdk through it).

| where | what stops it |
|---|---|
| `app/vite.config.ts` | `server.watch.ignored` for the linked trees, plus `optimizeDeps.include` so a linked package is pre-bundled instead of crawled as source |
| `server/package.json` | `tsx watch --exclude`. Note it excludes **`../node_modules/**`**: this is an npm workspace, so dependencies hoist to the *root*, and excluding `./node_modules/**` matches nothing |

**Your machine's half.** The limit is per user, across every process. An IDE indexing a few large
repos routinely holds most of it — on the machine this was diagnosed on, the editor held ~59,000 of
65,536, leaving under a thousand for everything else, which is not enough for any dev server however
well configured. Check who is holding them:

```bash
cat /proc/sys/fs/inotify/max_user_watches     # the limit
```

Raising it is the durable fix, and it is cheap — each watch costs under a kilobyte of kernel memory:

```bash
echo 'fs.inotify.max_user_watches=524288' | sudo tee /etc/sysctl.d/60-inotify.conf
sudo sysctl --system
```

Stale dev servers from earlier runs also hold watches; `pgrep -af "bin/vite|bin/tsx"` finds them.
