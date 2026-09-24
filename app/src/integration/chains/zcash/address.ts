/**
 * Zcash transparent (P2PKH) addresses.
 *
 * Free functions, guarding on `pub.algorithm` first, mirroring `toEvmAddress` in the SDK's own
 * key-evm adapter. A `PublicKey` carries no network, so the network is a parameter — which is why
 * this is two exported functions rather than one method on an adapter.
 *
 * The only difference from Bitcoin's P2PKH is the version prefix: Zcash uses **two** bytes where
 * Bitcoin uses one. Hash and checksum are identical, which is exactly why the two-byte prefix is
 * worth a comment — a one-byte assumption produces a valid-looking address on the wrong network.
 */
import { ripemd160 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";
import type { PublicKey } from "@nihilium/recovery-core";
import { base58check } from "@scure/base";

export type ZcashNetwork = "main" | "test";

/** t1… on mainnet, tm… on testnet. */
const P2PKH_PREFIX: Record<ZcashNetwork, readonly [number, number]> = {
    main: [0x1c, 0xb8],
    test: [0x1d, 0x25],
};

export function toZcashTransparentAddress(pub: PublicKey, network: ZcashNetwork): string {
    if (pub.algorithm !== "secp256k1") {
        // Shielded addresses use a different curve entirely — see keyAdapter.ts.
        throw new Error(
            `A Zcash transparent address needs a secp256k1 key; got ${pub.algorithm}.`,
        );
    }
    if (pub.bytes.length !== 33) {
        throw new Error(`Expected a 33-byte compressed public key; got ${pub.bytes.length}.`);
    }
    const hash = ripemd160(sha256(pub.bytes));
    const prefix = P2PKH_PREFIX[network];
    return base58check(sha256).encode(Uint8Array.from([prefix[0], prefix[1], ...hash]));
}

/** Round-trips an address to its 20-byte hash, so a test can check the prefix rather than trust it. */
export function decodeZcashTransparentAddress(
    address: string,
): { network: ZcashNetwork; hash: Uint8Array } {
    const bytes = base58check(sha256).decode(address);
    const prefix = [bytes[0], bytes[1]];
    for (const [network, expected] of Object.entries(P2PKH_PREFIX) as [ZcashNetwork, readonly [number, number]][]) {
        if (prefix[0] === expected[0] && prefix[1] === expected[1]) {
            return { network, hash: bytes.slice(2) };
        }
    }
    throw new Error(`Not a Zcash transparent address: prefix 0x${prefix.map(String).join(",")}`);
}
