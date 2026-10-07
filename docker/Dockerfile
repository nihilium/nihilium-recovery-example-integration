# Two images from one build: the server (`recovery-backend`) and the app (`account-recovery`).
#
# BUILD CONTEXT IS THE PARENT DIRECTORY, holding this repo and a `recovery-sdk` checkout side by
# side. The SDK's packages are not all on npm yet, so this repo consumes them through
# `file:../../recovery-sdk/...` links, and the build has to see both trees at the same relative
# layout. `Dockerfile.dockerignore` (next to this file) trims the context to those two repos.
#
#   cd /root/git    # the directory holding both checkouts
#   docker build -f nihilium-recovery-example-integration/docker/Dockerfile --target server -t recovery-backend .
#   docker build -f nihilium-recovery-example-integration/docker/Dockerfile --target web    -t account-recovery .
#
# The app's VITE_ settings are read at build time from `app/.env.production.local`, which the deploy
# writes from /root/envs/.env-account-recovery. They end up in the public bundle, API key and write
# secrets included: an accepted demo trade-off, stated in docs/deployment.md.

ARG NODE_IMAGE=node:24-bookworm-slim

# ── 1. The SDK, built from source ────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS sdk
WORKDIR /src/recovery-sdk
COPY recovery-sdk/ ./
RUN npm ci --no-audit --no-fund \
 && npm run build
# The on-chain bindings are separate projects with their own lockfiles. Only their TypeScript is
# built here: the ABIs and IDL are committed, so neither Foundry nor Anchor is needed.
RUN cd onchain/evm && npm ci --no-audit --no-fund && npx tsc -b \
 && cd ../solana && npm ci --no-audit --no-fund && npx tsc -p tsconfig.bindings.json

# ── 2. This repo's dependencies ──────────────────────────────────────────────────────────────
FROM sdk AS deps
WORKDIR /src/nihilium-recovery-example-integration
COPY nihilium-recovery-example-integration/ ./
RUN npm ci --no-audit --no-fund \
 # `postinstall` generates a fresh ROLE_MNEMONIC and secrets for local development. In an image
 # they would silently stand in for anything the runtime env file forgot, so they go.
 && rm -f server/.env app/.env.local

# ── 3. The server ────────────────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS server
ENV NODE_ENV=production \
    PORT=8787 \
    RECORDS_DIR=/data/records \
    WATCHES_DIR=/data/watches
# The whole tree: `file:` dependencies are symlinks into the SDK checkout.
COPY --from=deps /src /src
WORKDIR /src/nihilium-recovery-example-integration/server
VOLUME ["/data"]
EXPOSE 8787
CMD ["../node_modules/.bin/tsx", "src/index.ts"]

# ── 4. The app ───────────────────────────────────────────────────────────────────────────────
FROM deps AS web-build
WORKDIR /src/nihilium-recovery-example-integration/app
ENV NODE_OPTIONS=--max-old-space-size=4096
RUN test -f .env.production.local \
 || (echo "app/.env.production.local is missing: the deploy writes it from /root/envs/.env-account-recovery" >&2 && exit 1)
RUN npm run build

FROM nginx:1.27-alpine AS web
COPY nihilium-recovery-example-integration/docker/nginx.web.conf /etc/nginx/conf.d/default.conf
COPY --from=web-build /src/nihilium-recovery-example-integration/app/dist /usr/share/nginx/html
EXPOSE 80
