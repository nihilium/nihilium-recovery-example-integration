# Deploying the demo: account-recovery.nihilium.io

The demo runs as two containers behind one hostname. They are built from this repo's
[`docker/Dockerfile`](../docker/Dockerfile) and deployed by `deploy_cli.sh` in
`nihilium-product-backend`.

| | image | container port | host port | nginx route |
|---|---|---|---|---|
| server (`server/`) | `recovery-backend` | 8787 | 3011 | `account-recovery.nihilium.io/api/` |
| app (`app/`) | `account-recovery` | 80 | 3012 | `account-recovery.nihilium.io/` |

Same origin for both, so the browser makes no cross-origin calls, and the seal file's record host
reads `https://account-recovery.nihilium.io/api`.

```bash
./deploy_cli.sh recovery-backend deploy     # server: pull, build, restart
./deploy_cli.sh account-recovery deploy     # app: pull, build with the VITE_ env, restart
./deploy_cli.sh recovery-backend logs       # boot banner: every role's address and balance
```

## Why the build context is the parent directory

Several SDK packages this repo uses are not on npm yet: the service, the watchtower and its probes,
the passport adapters, and the on-chain bindings. They are consumed through
`file:../../recovery-sdk/...` links, so the build needs this repo and a `recovery-sdk` checkout,
with its `onchain/` submodule, side by side. The deploy pulls both into `/root/git` and builds there.
[`docker/Dockerfile.dockerignore`](../docker/Dockerfile.dockerignore) limits the context to those
two trees.

The SDK is built inside the image (`npm ci && npm run build`, then the on-chain bindings' TypeScript
only). Neither Foundry nor Anchor is needed: the ABIs and the IDL are committed. When the packages
are published, the context can shrink to this repo, and the `sdk` stage goes away.

## Files on the server

These are not in git. Their contents are secrets or per-deployment.

### `/root/envs/.env-recovery-backend` (server, read at runtime)

The same keys as `server/.env.example`, with these set for the deployment:

```bash
CORS_ORIGIN=https://account-recovery.nihilium.io
ROLE_MNEMONIC=...                 # every role key derives from this
RECORD_APPEND_SECRET=...          # must equal the app's VITE_RECORD_APPEND_SECRET
WATCH_REGISTER_SECRET=...         # must equal the app's VITE_WATCH_REGISTER_SECRET
SEPOLIA_RPC_URL=...
SOLANA_RPC_URL=https://api.devnet.solana.com
ARBITRUM_SEPOLIA_RPC_URL=https://sepolia-rollup.arbitrum.io/rpc
```

`PORT`, `RECORDS_DIR` and `WATCHES_DIR` are pinned by the deploy (`-e`, which wins over the env
file), so a copy of a local `server/.env` that sets them to `./.data/...` cannot move the state
out of the mounted volume.

**`ROLE_MNEMONIC` decides every role address.** Reusing the phrase from a local `server/.env` keeps
the relayer's existing balances, and keeps the attester that `VITE_MODULE_ATTESTER` names. A new
phrase means new relayer addresses to fund on Sepolia, Arbitrum Sepolia and devnet. It also means a
new attester to set in the app and run `server/scripts/attest-modules.ts` for, since the attester is
part of every Safe's address. The boot banner (`recovery-backend logs`) prints each address and
balance.

### `/root/envs/.env-account-recovery` (app, baked in at build time)

```bash
VITE_SERVER_URL=https://account-recovery.nihilium.io
VITE_NIHILIUM_API_KEY=...
VITE_RECORD_APPEND_SECRET=...     # same value as the server's RECORD_APPEND_SECRET
VITE_WATCH_REGISTER_SECRET=...    # same value as the server's WATCH_REGISTER_SECRET
# Optional, the defaults are public endpoints:
# VITE_SEPOLIA_RPC_URL, VITE_BUNDLER_URL, VITE_SOLANA_RPC_URL, VITE_ARBITRUM_SEPOLIA_RPC_URL,
# VITE_MAINNET_RPC_URL, VITE_ARBITRUM_RPC_URL, VITE_MODULE_ATTESTER
```

The deploy copies this to `app/.env.production.local` before building.

**Everything in this file ends up in the public JavaScript**, including the API key and both write
secrets. That is accepted for this demo, as it is for the API key locally: anyone can read them and
use them to seal on the demo's key, append records, or register watches on the demo server. A real
wallet keeps all three behind its own backend.

### `/root/data/recovery-backend/` (server state)

Mounted at `/data`, which holds `records/` (the record host) and `watches/` (the watchtower). It
survives redeploys. Deleting it loses every vault's records on this host. A seal file then recovers
only from a browser that still holds the records.

## One-time setup

1. DNS: point `account-recovery.nihilium.io` at the server.
2. Certificate: `certbot --expand -d account-recovery.nihilium.io` alongside the existing names on
   the `nihilium.io` certificate.
3. nginx: the `account-recovery.nihilium.io` blocks in `nginx_nihilium.io.config`
   (nihilium-product-backend), then `./deploy_cli.sh maintenance nginx-reload`.
4. Both env files above, and deploy keys that can clone `nihilium-recovery-example-integration`,
   `recovery-sdk` and its `recovery-guardian-contracts` submodule.
5. Fund the relayer on each chain. The addresses are in the boot banner.
