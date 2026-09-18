import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

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

export default defineConfig({
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
        // A linked package is treated as source rather than a dependency, so Vite walks its whole
        // tree on every start. Pre-bundling collapses each into one chunk and keeps the crawl out
        // of the sibling checkout in the first place.
        include: [
            "@nihilium/recovery-core",
            "@nihilium/recovery-condition-quorum",
            "@nihilium/recovery-condition-zkemail",
            "@nihilium/recovery-key-evm",
            "@nihilium/recovery-key-solana",
            "@nihilium/recovery-nihilium",
            "@nihilium/recovery-resolver-dkim",
            "@nihilium/recovery-veto",
        ],
    },
});
