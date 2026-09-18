/**
 * Every `import.meta.env` read in the app, in one file.
 *
 * Config that is scattered is config nobody can audit, and this app ships an API key to the browser
 * in one of its modes — so where that key is read matters. Nothing outside this file touches
 * `import.meta.env`; `bindings.ts` turns what this returns into the app's one set of bindings.
 */
import { DEMO_MNEMONIC } from "./mnemonic.js";

export interface DemoEnv {
    /** The chain whose Nihilium deployment verifies email proofs. Sepolia today. */
    chainId: number;
    serverUrl: string;
    sepoliaRpcUrl: string;
    bundlerUrl: string;
    mnemonic: string;
    /**
     * Write capabilities on the record host and the watchtower, generated per machine by
     * `scripts/setup-env.mjs`. `undefined` when nothing generated them — and deliberately not
     * defaulted to a constant, because a credential a repository ships is one every clone shares.
     * Whatever needs one demands it by name; see `requireCredential`.
     */
    recordAppendSecret: string | undefined;
    watchRegisterSecret: string | undefined;
    nihilium: {
        /**
         * Shipped to the browser, and that is an accepted demo trade-off rather than an oversight:
         * it is a spend limit on sealing, not access to anyone's funds. A production wallet puts
         * the payment provider behind its own backend.
         *
         * Without it there is no ceremony, and the recovery panel says so rather than the app
         * quietly doing something free instead.
         */
        apiKey: string | undefined;
        apiUrl: string;
        emailServiceUrl: string;
        processorThreshold: number;
        processorCount: number;
    };
}

export function readEnv(): DemoEnv {
    const env = import.meta.env;
    return {
        chainId: Number(env.VITE_CHAIN_ID ?? "11155111"),
        serverUrl: env.VITE_SERVER_URL ?? "http://localhost:8787",
        sepoliaRpcUrl: env.VITE_SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com",
        bundlerUrl: env.VITE_BUNDLER_URL ?? "https://public.pimlico.io/v2/11155111/rpc",
        mnemonic: env.VITE_DEMO_MNEMONIC ?? DEMO_MNEMONIC,
        // Matched by `server/.env`; both sides must agree or appends and registrations are refused.
        recordAppendSecret: blank(env.VITE_RECORD_APPEND_SECRET),
        watchRegisterSecret: blank(env.VITE_WATCH_REGISTER_SECRET),
        nihilium: {
            apiKey: blank(env.VITE_NIHILIUM_API_KEY),
            apiUrl: env.VITE_NIHILIUM_API_URL ?? "https://api.nihilium.io",
            emailServiceUrl: env.VITE_NIHILIUM_EMAIL_SERVICE_URL ?? "https://zkemail.nihilium.io",
            // Nihilium's processor cohort. One processor is published, so both default to 1.
            processorThreshold: Number(env.VITE_NIHILIUM_THRESHOLD ?? "1"),
            processorCount: Number(env.VITE_NIHILIUM_PROCESSOR_COUNT ?? "1"),
        },
    };
}

/** An empty string in a .env file means "not set", not "set to nothing". */
function blank(value: string | undefined): string | undefined {
    return value === undefined || value.trim() === "" ? undefined : value;
}

/**
 * Demands a credential at the point of use, naming what to run. Called by the record-host and
 * watchtower clients rather than at start-up: the app is fully usable without either of them, and
 * refusing to boot over a credential nothing has asked for yet would be theatre.
 */
export function requireCredential(
    value: string | undefined,
    which: "VITE_RECORD_APPEND_SECRET" | "VITE_WATCH_REGISTER_SECRET",
): string {
    if (value === undefined) {
        throw new Error(
            `${which} is not set, so this demo cannot write to the server role that needs it. ` +
                "Run `npm run setup:env` at the repository root — it writes app/.env.local and " +
                "server/.env with one matching pair.",
        );
    }
    return value;
}
