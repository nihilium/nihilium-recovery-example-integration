/**
 * A `KeyAdapter` written **outside** the SDK — the example this chain exists for.
 *
 * The SDK ships two: secp256k1 (`key-evm`) and ed25519 (`key-solana`). Zcash has neither, so this
 * is what adding a chain to the SDK actually looks like from a wallet's side. Three rules it
 * follows, all of them load-bearing:
 *
 * 1. **Derivation is the SDK's, never yours.** `derivePrivateKey` delegates to
 *    `derivePrivateKeyBytes` — the byte-exact §11 KDF, including the rejection loop that keeps a
 *    secp256k1 scalar in range. Hand-rolling HKDF here would produce keys that seal and then cannot
 *    be recovered by anything else, and nothing would notice until someone needed their recovery.
 * 2. **`algorithm` must be one of the SDK's three.** `KeyAlgorithm` is a closed union, and Zcash's
 *    *transparent* keys are ordinary secp256k1, so this adapter reuses it honestly. Shielded keys
 *    (Sapling, Orchard) are on Jubjub and Pallas — no member of that union, and no branch in the
 *    KDF. Supporting them needs a change in `@nihilium/recovery-core`, not another adapter.
 * 3. **`thresholdSign` throws.** It is a declared seam, not an omission, and every shipped adapter
 *    throws from it too. Saying which backend it needs keeps the gap visible in the type surface.
 *
 * What this adapter deliberately does not do is make Zcash *recoverable*. A recovery key is only
 * protection once a chain has somewhere to register it, and a transparent address has nowhere —
 * see `index.ts`.
 */
import { secp256k1 } from "@noble/curves/secp256k1.js";
import {
    NotImplementedError,
    RecoverySdkError,
    derivePrivateKeyBytes,
    type ChainContext,
    type KeyAdapter,
    type KeyShare,
    type PrivateKeyBytes,
    type PublicKey,
    type RRS,
    type Signature,
} from "@nihilium/recovery-core";

export class ZcashTransparentKeyAdapter implements KeyAdapter {
    readonly algorithm = "secp256k1" as const;

    deriveRecoveryPubKey(rrs: RRS, chain: ChainContext): PublicKey {
        const priv = this.derivePrivateKey(rrs, chain);
        try {
            return this.publicKeyFor(priv);
        } finally {
            // The private half never outlives the projection, even if `publicKeyFor` throws.
            priv.fill(0);
        }
    }

    derivePrivateKey(rrs: RRS, chain: ChainContext): PrivateKeyBytes {
        return derivePrivateKeyBytes(rrs, chain, this.algorithm);
    }

    publicKeyFor(priv: PrivateKeyBytes): PublicKey {
        // Compressed: transparent addresses hash the 33-byte form, and hashing the uncompressed one
        // yields a different, perfectly valid address that holds none of the same coins.
        return { algorithm: this.algorithm, bytes: secp256k1.getPublicKey(priv, true) };
    }

    /**
     * DER-encoded, over a 32-byte sighash the caller computed.
     *
     * Two deliberate differences from the EVM adapter, and they are the whole reason a chain needs
     * its own: the encoding is DER rather than `r ‖ s ‖ v` (a script has no `ecrecover` to feed),
     * and the caller appends the one-byte sighash type itself, because which bytes the sighash
     * covered is knowledge this adapter does not have.
     */
    async sign(priv: PrivateKeyBytes, sighash: Uint8Array): Promise<Signature> {
        if (sighash.length !== 32) {
            throw new RecoverySdkError(
                `Zcash signing takes a 32-byte sighash, got ${sighash.length} bytes. Compute it ` +
                    "over the transaction with the digest scheme the consensus rules require (ZIP-243 " +
                    "for Overwinter onwards) first.",
            );
        }
        return { algorithm: this.algorithm, bytes: secp256k1.sign(sighash, priv, { format: "der" }) };
    }

    async thresholdSign(
        _shares: KeyShare[],
        _chain: ChainContext,
        _payload: Uint8Array,
    ): Promise<Signature> {
        throw new NotImplementedError(
            "secp256k1 threshold signing for Zcash",
            "Nihilium's threshold protects a BabyJubJub vault scalar, not a chain signing key. " +
                "This would need a threshold ECDSA backend (CGGMP or GG20) behind it. Use the " +
                "scoped, zeroizing capability from recover() until then.",
        );
    }
}
