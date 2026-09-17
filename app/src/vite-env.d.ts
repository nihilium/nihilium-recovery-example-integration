/// <reference types="vite/client" />

// Every one of these is read in exactly one place: `src/demo/env.ts`. Nothing else in the app
// touches `import.meta.env`.
interface ImportMetaEnv {
    /** `simulated` (default) runs the identity ceremony locally, offline and free. `live` spends money. */
    readonly VITE_RECOVERY_MODE?: "simulated" | "live";
    readonly VITE_SERVER_URL?: string;
    readonly VITE_SEPOLIA_RPC_URL?: string;
    readonly VITE_BUNDLER_URL?: string;
    /** Overrides the plaintext demo mnemonic in `src/demo/mnemonic.ts`. */
    readonly VITE_DEMO_MNEMONIC?: string;
    readonly VITE_RECORD_APPEND_SECRET?: string;
    readonly VITE_WATCH_REGISTER_SECRET?: string;
    /** Live mode only. Ships to the browser on purpose; see `src/demo/env.ts`. */
    readonly VITE_NIHILIUM_API_KEY?: string;
    readonly VITE_NIHILIUM_API_URL?: string;
    readonly VITE_NIHILIUM_EMAIL_SERVICE_URL?: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}
