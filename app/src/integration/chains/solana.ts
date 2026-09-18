/**
 * Solana devnet — a second curve, and the cheapest demonstration that `addChain()` is free.
 *
 * Everything off-chain here is real: real ed25519 derivation, the SDK's real `SolanaKeyAdapter`,
 * the same KDF. What does not exist is the **on-chain half**: the SDK has no Solana settlement
 * program yet, so a recovery key derived for this chain is registered nowhere and protects nothing
 * until one ships. `settlement` says so by being a simulation, and the balance says so by being
 * `source: "simulated"`.
 *
 * **To replace:** `balanceOf` (query a real RPC) and `settlement` (a vault program is live on devnet
 * at `DaLebS3k5gD1k42uGU6LPnSP9qTNwYxaKqLQBb7BqgkG`, but the SDK has no settlement adapter reaching
 * it yet). **Assumes:** the namespace comes from `SOLANA_NAMESPACE` and never from a literal — every
 * recovery key derived for this chain depends on it byte for byte.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { SOLANA_NAMESPACE, SolanaKeyAdapter, toSolanaAddress } from "@nihilium/recovery-key-solana";
import { base58 } from "@scure/base";
import { bytesToHex } from "@noble/hashes/utils.js";
import { deriveEd25519 } from "../keys/derive.js";
import { SOLANA_PATH } from "../keys/paths.js";
import type { Balance, ChainModule, DerivedAccount } from "./types.js";

/** A fixed, obviously-round number. Nothing here pretends to be a devnet balance we read. */
const SIMULATED_LAMPORTS = 2_500_000_000n;

export function createSolanaDevnetChain(): ChainModule {
    return {
        id: "solana-devnet",
        label: "Solana · devnet",
        icon: "Key",
        // Never hand-written. CAIP-2 for Solana is the truncated genesis hash, not the cluster
        // name — `solana:devnet` is not a chain id, it just looks like one, and it would have sealed
        // perfectly happily. The namespace is a KDF input, so a wrong value is not a bug that gets
        // fixed later: it is a vault whose keys nothing on that chain will ever accept.
        namespace: SOLANA_NAMESPACE.devnet,
        tier: "smart-account",
        keyAdapter: new SolanaKeyAdapter(),

        async deriveAccounts(seed: Uint8Array): Promise<DerivedAccount[]> {
            const key = deriveEd25519(seed, SOLANA_PATH);
            const address = toSolanaAddress(key.publicKey);
            return [
                {
                    accountId: address,
                    address,
                    label: "Account 0",
                    derivationPath: SOLANA_PATH,
                    index: 0,
                    signer: {
                        address,
                        publicKey: key.publicKey,
                        async sign(payload: Uint8Array) {
                            // ed25519 signs the message, not a digest — the opposite of the EVM
                            // adapter, and the reason `sign` is per-chain rather than shared.
                            return {
                                algorithm: "ed25519" as const,
                                bytes: ed25519.sign(payload, key.privateKey),
                            };
                        },
                        exportPrivateKeyHex_DEMO_ONLY: () => `0x${bytesToHex(key.privateKey)}`,
                    },
                },
            ];
        },

        formatAddress(address, style = "short") {
            return style === "full" ? address : `${address.slice(0, 4)}…${address.slice(-4)}`;
        },

        // No explorer link: this demo never puts anything on devnet, and a link to an address with
        // no history is a link that teaches someone the wrong thing about what happened here.
        explorerUrl() {
            return null;
        },

        async balanceOf(): Promise<Balance> {
            return { raw: SIMULATED_LAMPORTS, decimals: 9, symbol: "SOL", source: "simulated" };
        },

        settlement: null,
    };
}

/** Exported for the address test: base58 is the encoding, and the test pins it independently. */
export const solanaBase58 = base58;
