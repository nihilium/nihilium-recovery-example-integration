/**
 * `Buffer`, in a browser, because the Solana surface is typed and written against Node's.
 *
 * `@nihilium/recovery-onchain-solana` returns `Buffer` from `clusterTag` and `vetoFingerprint`,
 * takes one in `signAll`, and `@solana/web3.js` v1 uses it throughout for PDA seeds and instruction
 * data. None of that is optional and none of it is ours to change — so the global has to exist
 * before any of it runs.
 *
 * Imported for its side effect from `main.tsx`, first, in the same way `ui/vendor/react-global.ts`
 * is imported before the design-system bundle. Import order is load-bearing: a Solana module that
 * evaluates before this one reads `Buffer` as undefined at module scope and fails in a way that
 * points nowhere near here.
 *
 * It lives here rather than under `ui/vendor/`, which `readSources` deliberately skips — that
 * directory is for vendored third-party bundles, and a file nobody checks is a poor home for one of
 * ours.
 *
 * **To replace:** delete it, if your bundler already polyfills Node globals or your app never
 * touches Solana. **Assumes:** nothing else has installed a different `Buffer` — it does not
 * overwrite one that is already there.
 */
import { Buffer } from "buffer";

const scope = globalThis as typeof globalThis & { Buffer?: typeof Buffer };

if (scope.Buffer === undefined) {
    scope.Buffer = Buffer;
}
