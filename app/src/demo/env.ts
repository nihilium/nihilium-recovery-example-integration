/**
 * Every `import.meta.env` read in the app, in one file.
 *
 * Config that is scattered is config nobody can audit, and this app ships an API key to the browser
 * in one of its modes — so where that key is read matters. Nothing outside this file touches
 * `import.meta.env`; `bindings.ts` turns what this returns into the app's one set of bindings.
 */
import { DEMO_MNEMONIC } from "./mnemonic.js";

export type RecoveryMode = "simulated" | "live";

export interface DemoEnv {
    /**
     * `simulated` runs the identity ceremony locally: offline, instant, free, and every other part
     * of the SDK real. `live` runs the actual zkEmail ceremony — it is **paid**, takes minutes, and
     * blocks on a human answering an email.
     */
    mode: RecoveryMode;
    serverUrl: string;
    sepoliaRpcUrl: string;
    bundlerUrl: string;
    mnemonic: string;
    recordAppendSecret: string;
    watchRegisterSecret: string;
    nihilium: {
        /**
         * Live mode ships this to the browser, and that is an accepted demo trade-off rather than an
         * oversight: it is a spend limit on sealing, not access to anyone's funds. A production
         * wallet puts the payment provider behind its own backend.
         */
        apiKey: string | undefined;
        apiUrl: string;
        emailServiceUrl: string;
    };
}

export function readEnv(): DemoEnv {
    const env = import.meta.env;
    return {
        mode: env.VITE_RECOVERY_MODE === "live" ? "live" : "simulated",
        serverUrl: env.VITE_SERVER_URL ?? "http://localhost:8787",
        sepoliaRpcUrl: env.VITE_SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com",
        bundlerUrl: env.VITE_BUNDLER_URL ?? "https://public.pimlico.io/v2/11155111/rpc",
        mnemonic: env.VITE_DEMO_MNEMONIC ?? DEMO_MNEMONIC,
        // Shared secrets with the server's record host and watchtower. Demo defaults, matched by
        // `server/.env.example`; both sides must agree or appends and registrations are refused.
        recordAppendSecret: env.VITE_RECORD_APPEND_SECRET ?? "demo-append-secret",
        watchRegisterSecret: env.VITE_WATCH_REGISTER_SECRET ?? "demo-watch-secret",
        nihilium: {
            apiKey: env.VITE_NIHILIUM_API_KEY,
            apiUrl: env.VITE_NIHILIUM_API_URL ?? "https://api.nihilium.io",
            emailServiceUrl: env.VITE_NIHILIUM_EMAIL_SERVICE_URL ?? "https://zkemail.nihilium.io",
        },
    };
}
