/**
 * Seed + path -> a key pair the rest of the app can use, on either curve.
 *
 * Returns the SDK's own `PublicKey` shape (algorithm + compressed bytes) rather than a chain's
 * address, because an address is a chain's business and this file has no chain in it. The chain
 * modules turn these into addresses.
 *
 * What a real wallet must replace: the private key never leaves this function's return value here,
 * and that is only acceptable because the seed is public. A wallet signs inside its keystore.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import type { PublicKey } from "@nihilium/recovery-core";
import { HDKey } from "@scure/bip32";
import { slip10Ed25519 } from "./slip10.js";

export interface DerivedKey {
    privateKey: Uint8Array;
    publicKey: PublicKey;
    path: string;
}

/** BIP-32 over secp256k1: EVM, and Zcash's transparent addresses. */
export function deriveSecp256k1(seed: Uint8Array, path: string): DerivedKey {
    const node = HDKey.fromMasterSeed(seed).derive(path);
    if (node.privateKey === null) throw new Error(`No private key at ${path}`);
    return {
        privateKey: node.privateKey,
        // Compressed, 33 bytes — what `PublicKey` documents for secp256k1.
        publicKey: { algorithm: "secp256k1", bytes: secp256k1.getPublicKey(node.privateKey, true) },
        path,
    };
}

/** SLIP-0010 over ed25519: Solana. */
export function deriveEd25519(seed: Uint8Array, path: string): DerivedKey {
    const privateKey = slip10Ed25519(seed, path);
    return {
        privateKey,
        publicKey: { algorithm: "ed25519", bytes: ed25519.getPublicKey(privateKey) },
        path,
    };
}
