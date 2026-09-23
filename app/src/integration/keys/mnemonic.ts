/**
 * Mnemonic -> seed. The one place BIP-39 is spoken.
 *
 * What a real wallet must replace: everything about *where the mnemonic comes from*. This demo
 * takes it as a string from a module constant (`demo/mnemonic.ts`) because it needs to show and
 * lose it; a wallet takes it from a keystore and never lets it reach application code.
 *
 * What does not change: the seed is the wallet's, not the recovery system's. The SDK derives its
 * recovery keys from a Recovery Root Secret it generates itself (§11) — no function here feeds it.
 */
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

export class InvalidMnemonicError extends Error {
    override readonly name = "InvalidMnemonicError";
    constructor() {
        super("Not a valid BIP-39 English mnemonic (checksum or wordlist).");
    }
}

/**
 * A fresh 12-word English mnemonic, from the platform CSPRNG.
 *
 * 128 bits of entropy, not 256: twelve words is what wallets show, and a demo whose phrase does not
 * look like a wallet's phrase is teaching a different thing by accident.
 */
export function newMnemonic(): string {
    return generateMnemonic(wordlist, 128);
}

export function isValidMnemonic(mnemonic: string): boolean {
    return validateMnemonic(normalize(mnemonic), wordlist);
}

/** 64 bytes. No passphrase: a demo that could hide a 13th word would be demonstrating the wrong thing. */
export function seedFromMnemonic(mnemonic: string): Uint8Array {
    const normalized = normalize(mnemonic);
    if (!validateMnemonic(normalized, wordlist)) throw new InvalidMnemonicError();
    return mnemonicToSeedSync(normalized);
}

function normalize(mnemonic: string): string {
    return mnemonic.trim().replace(/\s+/g, " ").toLowerCase();
}
