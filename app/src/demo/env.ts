/**
 * Every `import.meta.env` read in the app, in one file.
 *
 * Config that is scattered is config nobody can audit, and this app ships an API key to the browser
 * in one of its modes — so where that key is read matters. Nothing outside this file touches
 * `import.meta.env`; `bindings.ts` turns what this returns into the app's one set of bindings.
 */

export interface DemoEnv {
    /** The chain whose Nihilium deployment verifies email proofs. Sepolia today. */
    chainId: number;
    serverUrl: string;
    sepoliaRpcUrl: string;
    bundlerUrl: string;
    /**
     * Whose module attestations this wallet's Safe trusts.
     *
     * Part of the Safe's address, so it belongs in configuration rather than a constant: a demo
     * pointing at a different deployment's attester would derive an account nobody funded. Written
     * by `server/scripts/attest-modules.ts`, which prints it on completion.
     */
    moduleAttester: `0x${string}`;
    /** Devnet RPC. Queried for real balances — this chain has no simulated ones. */
    solanaRpcUrl: string;
    /**
     * Ethereum **mainnet**, and it is read for prices only — never written to, never an account.
     *
     * This app runs on testnets where gas is free and the token is worthless, so a fee quoted from
     * the chains it actually uses would be a number near zero. The work is measured on Sepolia and
     * devnet; the price comes from here. See `integration/costs/prices.ts`.
     */
    mainnetRpcUrl: string;
    /** Arbitrum One, read for Chainlink's SOL/USD only — Ethereum's copy of that feed runs ~24h stale. */
    arbitrumRpcUrl: string;
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
        moduleAttester: (env.VITE_MODULE_ATTESTER ?? "0x4490f5D9f1cf47b2FBa68158c130aAE8107274a9") as `0x${string}`,
        solanaRpcUrl: env.VITE_SOLANA_RPC_URL ?? "https://api.devnet.solana.com",
        mainnetRpcUrl: env.VITE_MAINNET_RPC_URL ?? "https://ethereum-rpc.publicnode.com",
        arbitrumRpcUrl: env.VITE_ARBITRUM_RPC_URL ?? "https://arbitrum-one-rpc.publicnode.com",
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
        // setup:env writes app/.env.local and server/.env with one matching pair.
        throw new Error(
            `${which} is not set. Run \`npm run setup:env\` at the repository root.`,
        );
    }
    return value;
}
