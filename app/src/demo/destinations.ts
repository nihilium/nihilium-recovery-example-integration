/**
 * Where a recovery hands control, derived from a seed rather than typed as an address.
 *
 * **Why a seed and not a string.** The destination is chain-shaped: on EVM it is the EOA the
 * installed `OwnableValidator` will answer to, on Solana it is the ed25519 key the vault's `owner`
 * is rotated to. One pasted `0x…` cannot be both — and until this existed, that is exactly what
 * happened: `useRecoveryChain` typed `target` as an EVM `Address` and passed it to Solana as
 * `newOwner` unchanged, so a Solana recovery named a destination the program could never accept.
 * Naming a *seed* lets each chain derive its own.
 *
 * **Why not `ChainModule.deriveAccounts`.** That returns the accounts a wallet *protects* — on EVM a
 * counterfactual smart account, which needs a network round trip to compute and is the wrong answer
 * anyway: control lands on a plain key. These are the keys themselves, derived locally, with no RPC.
 *
 * Demo-shaped, so it lives here: it takes a mnemonic, which `integration/` never does.
 */
import { toEvmAddress } from "@nihilium/recovery-key-evm";
import { toSolanaAddress } from "@nihilium/recovery-key-solana";
import { deriveEd25519, deriveSecp256k1 } from "@nihilium-demo/keys";
import { seedFromMnemonic } from "../integration/keys/mnemonic.js";
import { EVM_RECOVERY_TARGET_PATH, SOLANA_PATH } from "../integration/keys/paths.js";

export interface Destination {
    chainId: string;
    /** In that chain's own notation. Goes into the intent verbatim. */
    address: string;
    derivationPath: string;
    /**
     * The key control lands on, so this demo can *use* it once the handover executes — signing the
     * transfer that proves the account changed hands. Named the way the SDK names its own escape
     * hatches so nobody copies it into a wallet by accident; a real wallet holds this on the device
     * it stands in for and never exports bytes.
     */
    exportPrivateKeyHex_DEMO_ONLY(): string;
}

function hex(bytes: Uint8Array): string {
    return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Every chain's destination for one seed.
 *
 * EVM uses the `1'` account branch rather than `0'`, so the key control lands on is not the key the
 * account being recovered was built from. On Solana the wallet's own path is used, because a Solana
 * recovery rotates the vault to a key you hold and the vault is a separate account from that key.
 */
export function destinationsFor(mnemonic: string): readonly Destination[] {
    const seed = seedFromMnemonic(mnemonic);
    const evm = deriveSecp256k1(seed, EVM_RECOVERY_TARGET_PATH);
    const solana = deriveEd25519(seed, SOLANA_PATH);
    return [
        {
            chainId: "evm-sepolia",
            address: toEvmAddress(evm.publicKey),
            derivationPath: EVM_RECOVERY_TARGET_PATH,
            exportPrivateKeyHex_DEMO_ONLY: () => hex(evm.privateKey),
        },
        {
            chainId: "solana-devnet",
            address: toSolanaAddress(solana.publicKey),
            derivationPath: SOLANA_PATH,
            exportPrivateKeyHex_DEMO_ONLY: () => hex(solana.privateKey),
        },
    ];
}

/** `null` on a chain this demo has no destination for — rendered, never guessed at. */
export function destinationFor(mnemonic: string, chainId: string): Destination | null {
    return destinationsFor(mnemonic).find((entry) => entry.chainId === chainId) ?? null;
}

/**
 * The seeds that may receive control — never the one the vault protects.
 *
 * A recovery decrypts **every** record in the vault, so the protected wallet's root secret is now
 * known to whoever ran the ceremony. Handing the account back to that seed would hand it to a key
 * the recovery just exposed, and a fresh gate on the same seed does not help: the key is derived
 * from the root, not from the gate. The SDK states this as "a recovery spends the vault — there is
 * no rotation, and a new epoch is not an escape"; this is the same rule as a list the user picks
 * from, so it cannot be clicked past.
 *
 * Returning an empty list is a real answer, not a failure: a wallet with one seed has nowhere for
 * control to go yet, and the honest next step is to make a seed for it.
 */
export function eligibleOwners<T extends { mnemonic: string }>(
    seeds: readonly T[],
    /** The vault's `walletId` — in this demo, `seedFingerprint(mnemonic)`. */
    vaultWalletId: string,
    fingerprintOf: (mnemonic: string) => string,
): readonly T[] {
    return seeds.filter((entry) => fingerprintOf(entry.mnemonic) !== vaultWalletId);
}
