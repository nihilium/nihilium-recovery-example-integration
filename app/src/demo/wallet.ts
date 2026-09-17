/**
 * The demo wallet: one seed, every chain's accounts derived from it.
 *
 * Demo-shaped, so it lives here rather than under `integration/` — it holds a seed in memory, which
 * is the thing a real wallet must not do. What it hands to the rest of the app is ordinary:
 * `DerivedAccount`s from the chain registry, which is exactly what a real wallet would supply from
 * its own keystore.
 */
import type { ChainRegistry, DerivedAccount } from "../integration/chains/types.js";
import { seedFromMnemonic } from "../integration/keys/mnemonic.js";

export interface WalletSnapshot {
    mnemonic: string;
    /** 64 bytes. Kept because scenarios re-derive accounts for chains the user has not opened yet. */
    seed: Uint8Array;
    accounts: Record<string, DerivedAccount[]>;
    /** Chains whose derivation failed, with the reason. A chain that needs an RPC can fail here. */
    failures: Record<string, string>;
}

export async function deriveWallet(
    registry: ChainRegistry,
    mnemonic: string,
): Promise<WalletSnapshot> {
    const seed = seedFromMnemonic(mnemonic);
    const accounts: Record<string, DerivedAccount[]> = {};
    const failures: Record<string, string> = {};

    // Sequential would make the whole wallet as slow as its slowest chain, and one chain here needs
    // a network round-trip to learn its smart-account address.
    await Promise.all(
        registry.all().map(async (chain) => {
            try {
                accounts[chain.id] = await chain.deriveAccounts(seed);
            } catch (error) {
                // A chain that cannot derive must not take the wallet down with it: the other two
                // are still usable, and the card says which one failed and why.
                failures[chain.id] = error instanceof Error ? error.message : String(error);
                accounts[chain.id] = [];
            }
        }),
    );

    return { mnemonic, seed, accounts, failures };
}
