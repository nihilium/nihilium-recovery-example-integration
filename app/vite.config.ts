import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type UserConfig } from "vite";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));

/**
 * The SDK arrives through `file:` links, which are symlinks into a sibling checkout — so Vite
 * resolves them to real paths *outside* this project, where its default `node_modules` ignore never
 * matches. Left alone it crawls and watches the whole of `../recovery-sdk` (33k files, and
 * `nihilium-core`'s client-sdk through it) against an inotify limit of 65k, and `npm run dev` dies
 * at startup with `ENOSPC: System limit for number of file watchers reached`.
 *
 * Nothing here is a workaround for the SDK: the packages are browser-safe and need no shims. It is
 * a workaround for *linking* them, and it disappears the day they are installed from npm.
 */
const linkedSdkPaths = ["**/recovery-sdk/**", "**/nihilium-core/**"];

/**
 * Variables that must never reach the bundle, because `src/demo/env.ts` reads `import.meta.env` as
 * a whole object and Vite then inlines **every** `VITE_*` variable it finds, referenced or not. The
 * Nihilium API key used to be one of them; it is the server's now. `npm run setup:env` moves an old
 * one across, and this refuses to build or serve if one comes back.
 */
const FORBIDDEN_ENV = ["VITE_NIHILIUM_API_KEY"];

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, projectRoot, "VITE_");
    const leaked = FORBIDDEN_ENV.filter((name) => (env[name] ?? "").trim() !== "");
    if (leaked.length > 0) {
        throw new Error(
            `${leaked.join(", ")} is set for the app, and would ship in the public bundle. The Nihilium ` +
                "API key belongs in server/.env as NIHILIUM_API_KEY; run `npm run setup:env` to move it.",
        );
    }
    return config;
});

const config = {
    plugins: [react()],
    server: {
        port: 5173,
        watch: {
            // Watch this app, not the library it links. We never edit the SDK from here (CLAUDE.md
            // says so outright), so losing hot-reload on it costs nothing.
            ignored: linkedSdkPaths,
        },
        fs: {
            // The links point outside the project root, so the dev server still has to be allowed
            // to *serve* from there — this is about reading files, not watching them.
            allow: [projectRoot, fileURLToPath(new URL("../../", import.meta.url))],
        },
    },
    optimizeDeps: {
        // Two reasons, and the second one is load-bearing rather than an optimisation.
        //
        // 1. A linked package is treated as source rather than a dependency, so Vite walks its
        //    whole tree on every start. Pre-bundling collapses each into one chunk and keeps the
        //    crawl out of the sibling checkout in the first place.
        // 2. `recovery-onchain-solana` is **CommonJS** — the only one in the SDK; every other
        //    package is ESM. A browser `import { recoveryVaultProgramIds } from …` against a CJS
        //    module fails at runtime with "does not provide an export named", because Vite serves
        //    linked packages unbundled and there is no interop layer. Pre-bundling is what converts
        //    the named exports. The production build never showed it: Rollup applies its own
        //    CommonJS interop, so `npm run build` passed while `npm run dev` did not.
        include: [
            "@nihilium/recovery-core",
            "@nihilium/recovery-condition-quorum",
            "@nihilium/recovery-condition-zkemail",
            "@nihilium/recovery-condition-zkemail-zkpassport",
            "@nihilium/recovery-condition-zkpassport",
            "@nihilium/recovery-key-evm",
            "@nihilium/recovery-key-solana",
            "@nihilium/recovery-nihilium",
            "@nihilium/recovery-resolver-dkim",
            "@nihilium/recovery-veto",
            "@nihilium/recovery-onchain-evm",
            "@nihilium/recovery-onchain-solana",
            "@nihilium/recovery-watchtower-evm",
            "@nihilium/recovery-watchtower-solana",
        ],
    },
} satisfies UserConfig;
