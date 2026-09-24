/// <reference types="vite/client" />

// Every one of these is read in exactly one place: `src/demo/env.ts`. Nothing else in the app
// touches `import.meta.env`.
interface ImportMetaEnv {
    /** Sepolia by default: the chain whose Nihilium deployment verifies email proofs. */
    readonly VITE_CHAIN_ID?: string;
    readonly VITE_SERVER_URL?: string;
    readonly VITE_SEPOLIA_RPC_URL?: string;
    readonly VITE_BUNDLER_URL?: string;
    readonly VITE_MODULE_ATTESTER?: string;
    /** Overrides the plaintext demo mnemonic in `src/demo/mnemonic.ts`. */
    readonly VITE_RECORD_APPEND_SECRET?: string;
    readonly VITE_WATCH_REGISTER_SECRET?: string;
    /** Required: the ceremony is paid, and there is no free mode. Ships to the browser on purpose. */
    readonly VITE_NIHILIUM_API_KEY?: string;
    readonly VITE_NIHILIUM_API_URL?: string;
    readonly VITE_NIHILIUM_EMAIL_SERVICE_URL?: string;
    /** Nihilium's processor cohort, not the guardian quorum. */
    readonly VITE_NIHILIUM_THRESHOLD?: string;
    readonly VITE_NIHILIUM_PROCESSOR_COUNT?: string;
    /** Ethereum mainnet, read for gas and token prices only — see `integration/costs/prices.ts`. */
    readonly VITE_MAINNET_RPC_URL?: string;
    /** Arbitrum One, read for Chainlink's SOL/USD only. */
    readonly VITE_ARBITRUM_RPC_URL?: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}
