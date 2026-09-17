/**
 * Zcash testnet, transparent addresses — the UTXO shape, and an honest dead end.
 *
 * Two things this chain is here to show:
 *
 * 1. **One wallet is many addresses.** `deriveAccounts` returns three, and each is its own
 *    `ChainContext.accountId`, so protecting this wallet means three records in the vault rather
 *    than one. That is only bearable because `addChain()` costs nothing — which is the lesson.
 * 2. **An off-chain half with no on-chain half.** A t-address is a hash of a public key; there is
 *    nowhere in it to register a recovery key, no module to install, no veto to enforce. The SDK
 *    would need a script-tier construction here (a timelocked script, or a pre-signed sweep held by
 *    the guardian set) and this repo does not build one. So `tier` is `"script"`, `settlement` is
 *    `null`, and nothing in the UI offers a pause on this chain — not because a component checks
 *    for Zcash, but because there is no binding to ask.
 *
 * Shielded addresses are out of scope for a reason that is structural rather than lazy: their
 * spending keys are not secp256k1 or ed25519, so `KeyAlgorithm` in `@nihilium/recovery-core` has no
 * member for them. See `keyAdapter.ts`.
 */
import { bytesToHex } from "@noble/hashes/utils.js";
import { deriveSecp256k1 } from "../../keys/derive.js";
import { ZCASH_PATHS } from "../../keys/paths.js";
import type { Balance, ChainModule, DerivedAccount } from "../types.js";
import { toZcashTransparentAddress } from "./address.js";
import { ZcashTransparentKeyAdapter } from "./keyAdapter.js";

/** Zatoshis. Split across the three addresses, because that is what a UTXO wallet looks like. */
const SIMULATED_BALANCES = [125_000_000n, 40_000_000n, 0n];

export function createZcashTestnetChain(): ChainModule {
    const balances = new Map<string, bigint>();

    return {
        id: "zcash-testnet",
        label: "Zcash · testnet",
        icon: "LockClosed",
        // Pinned, and note this one is not a registered CAIP-2 namespace at all. Whatever string
        // sits here is an HKDF input forever; picking it is a decision, not a formatting choice.
        namespace: "zcash:testnet",
        // "script", not "smart-account": there is no program here that could enforce a veto, and
        // `capabilities()` on a settlement binding would have to say so. See the header.
        tier: "script",
        keyAdapter: new ZcashTransparentKeyAdapter(),

        async deriveAccounts(seed: Uint8Array): Promise<DerivedAccount[]> {
            return ZCASH_PATHS.map((entry, index) => {
                const key = deriveSecp256k1(seed, entry.path);
                const address = toZcashTransparentAddress(key.publicKey, "test");
                balances.set(address, SIMULATED_BALANCES[index] ?? 0n);
                return {
                    accountId: address,
                    address,
                    label: entry.label,
                    derivationPath: entry.path,
                    index,
                    signer: {
                        address,
                        publicKey: key.publicKey,
                        async sign(payload: Uint8Array) {
                            return new ZcashTransparentKeyAdapter().sign(key.privateKey, payload);
                        },
                        exportPrivateKeyHex_DEMO_ONLY: () => `0x${bytesToHex(key.privateKey)}`,
                    },
                } satisfies DerivedAccount;
            });
        },

        formatAddress(address, style = "short") {
            return style === "full" ? address : `${address.slice(0, 6)}…${address.slice(-4)}`;
        },

        explorerUrl() {
            return null;
        },

        async balanceOf(address: string): Promise<Balance> {
            return {
                raw: balances.get(address) ?? 0n,
                decimals: 8,
                symbol: "TAZ",
                source: "simulated",
            };
        },

        settlement: null,
    };
}
