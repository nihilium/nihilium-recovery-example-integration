/**
 * SLIP-0010 ed25519 derivation, in the thirty lines it takes.
 *
 * `@scure/bip32` implements BIP-32, which is secp256k1-only: its child derivation adds scalars on
 * that curve, and ed25519 keys are not scalars you may add. SLIP-0010 is the scheme that covers
 * ed25519, and it is simpler — hardened derivation only, and the private key is the left half of an
 * HMAC rather than the result of any curve arithmetic.
 *
 * A non-hardened index has no defined answer here, so this throws rather than deriving something
 * that looks like a key and is not the one any other wallet would produce.
 *
 * **To replace:** nothing — this is the published scheme, pinned against its own test vectors.
 * **Assumes:** hardened segments only, which is all SLIP-0010 ed25519 defines.
 */
import { hmac } from "@noble/hashes/hmac.js";
import { sha512 } from "@noble/hashes/sha2.js";

const ED25519_SEED = new TextEncoder().encode("ed25519 seed");
const HARDENED = 0x80000000;

export class UnhardenedPathError extends Error {
    override readonly name = "UnhardenedPathError";
    constructor(path: string, segment: string) {
        super(
            `SLIP-0010 ed25519 derives hardened indices only; "${segment}" in "${path}" is not ` +
                `hardened. Append "'" to every segment.`,
        );
    }
}

export function parseHardenedPath(path: string): number[] {
    const segments = path.split("/");
    if (segments[0] !== "m") throw new Error(`A derivation path starts at "m": "${path}"`);
    return segments.slice(1).map((segment) => {
        if (!segment.endsWith("'") && !segment.endsWith("h")) {
            throw new UnhardenedPathError(path, segment);
        }
        const index = Number(segment.slice(0, -1));
        if (!Number.isInteger(index) || index < 0 || index >= HARDENED) {
            throw new Error(`Segment "${segment}" is not a valid index in "${path}"`);
        }
        return index + HARDENED;
    });
}

/** The 32 private-key bytes at `path`. `@noble/curves`' ed25519 turns them into a public key. */
export function slip10Ed25519(seed: Uint8Array, path: string): Uint8Array {
    let I = hmac(sha512, ED25519_SEED, seed);
    let key = I.slice(0, 32);
    let chainCode = I.slice(32);

    for (const index of parseHardenedPath(path)) {
        const data = new Uint8Array(1 + 32 + 4);
        data[0] = 0x00; // SLIP-0010's leading zero byte; BIP-32 puts a public key here instead.
        data.set(key, 1);
        new DataView(data.buffer).setUint32(33, index, false);
        I = hmac(sha512, chainCode, data);
        key = I.slice(0, 32);
        chainCode = I.slice(32);
    }
    return key;
}
