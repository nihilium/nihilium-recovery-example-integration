/**
 * Who the server's roles *are*, per chain.
 *
 * A role is not a private key — it is a party, and the same party needs a key on every chain it
 * acts on. Those keys are not interchangeable: EVM wants secp256k1 at one path, Solana ed25519 at
 * another, and a hex string in `.env` can only ever be one of them. So a role here is an **account
 * index against a seed phrase**, and a chain's scheme turns that index into the key material that
 * chain actually uses.
 *
 * Adding a chain the roles must act on is one entry in `ROLE_CHAINS`.
 *
 * **One seed for every role is a demo convenience, and in production it is the bug this repo is
 * about.** The three veto authorities are supposed to be three parties precisely so that no single
 * compromise reaches two of them; deriving them from one phrase throws that away while leaving
 * everything looking correctly configured. Hence the per-role overrides below — a real deployment
 * supplies each role's key separately, from wherever that party keeps it, and never holds a seed
 * that derives all of them. The boot banner says which of the two you are running.
 *
 * Demo-shaped, so it lives outside `roles/`: a role receives its signer as a parameter and never
 * learns whether it came from a phrase or an envelope (CLAUDE.md -> The copy line).
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { slip10Ed25519 } from "@nihilium-demo/keys";
import type { Authority, PublicKey } from "@nihilium/recovery-core";
import { toEvmAddress } from "@nihilium/recovery-key-evm";
import { SOLANA_NAMESPACE, toSolanaAddress } from "@nihilium/recovery-key-solana";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { bytesToHex, type Hex } from "viem";

export type RoleName = "relayer" | "pause" | "abort" | "attester" | `resume-${number}`;

export type Curve = "secp256k1" | "ed25519";

/**
 * How one chain turns a role's account index into a key.
 *
 * `path` deliberately sits on a coin-type branch of its own (`1'` where a wallet uses `0'`), so a
 * role key can never collide with an account the demo wallet is showing.
 */
export interface RoleChainScheme {
    /** CAIP-2. Becomes `Authority.namespace`, which is what a `VetoConfig` names. */
    namespace: string;
    curve: Curve;
    path(accountIndex: number): string;
    addressOf(pub: PublicKey): string;
}

export const ROLE_CHAINS: Record<string, RoleChainScheme> = {
    "eip155:11155111": {
        namespace: "eip155:11155111",
        curve: "secp256k1",
        path: (index) => `m/44'/60'/1'/0/${index}`,
        addressOf: toEvmAddress,
    },
    [SOLANA_NAMESPACE.devnet]: {
        // Never hand-written. CAIP-2 for Solana is the truncated genesis hash, not the cluster
        // name — and this value is a KDF input, so a wrong one is not a bug that gets fixed later.
        namespace: SOLANA_NAMESPACE.devnet,
        curve: "ed25519",
        // Fully hardened, because SLIP-0010 ed25519 defines nothing else — `parseHardenedPath`
        // throws on an unhardened segment rather than inventing an answer. The `1'` account branch
        // is the same trick the EVM path uses: a role key can never collide with an account the
        // demo wallet is showing.
        path: (index) => `m/44'/501'/1'/${index}'`,
        addressOf: toSolanaAddress,
    },
    // Zcash has no settlement program for a role to act on. When one lands, its entry goes here.
};

export interface RoleKeyOnChain {
    role: RoleName;
    privateKey: Hex;
    publicKey: PublicKey;
    /** `{namespace, id}` — the shape `VetoConfig` names its authorities with. */
    authority: Authority;
    /** True when `.env` supplied this role's key rather than the shared phrase deriving it. */
    supplied: boolean;
}

export interface RoleIdentity {
    name: RoleName;
    /** Stable per role: the account index every chain's path is built around. */
    accountIndex: number;
    /** Key material for one chain. Throws for a chain no role can act on. */
    on(namespace: string): RoleKeyOnChain;
}

export interface RoleIdentityOptions {
    mnemonic: string;
    /** Per-role raw keys from `.env`. secp256k1 only — see `assertSuppliedKeyUsable`. */
    supplied: Partial<Record<RoleName, string | undefined>>;
}

export function createRoleIdentity(
    name: RoleName,
    accountIndex: number,
    options: RoleIdentityOptions,
): RoleIdentity {
    const supplied = normalizeSupplied(name, options.supplied[name]);

    return {
        name,
        accountIndex,
        on(namespace: string): RoleKeyOnChain {
            const scheme = ROLE_CHAINS[namespace];
            if (scheme === undefined) {
                throw new Error(
                    `No role key scheme for "${namespace}". Roles only hold keys on chains they act ` +
                        `on; known: ${Object.keys(ROLE_CHAINS).join(", ") || "(none)"}.`,
                );
            }

            const privateKey =
                supplied !== undefined
                    ? assertSuppliedKeyUsable(name, supplied, scheme)
                    : deriveOnCurve(options.mnemonic, scheme, accountIndex);

            const publicKey = publicKeyFor(privateKey, scheme.curve);
            return {
                role: name,
                privateKey,
                publicKey,
                authority: { namespace: scheme.namespace, id: scheme.addressOf(publicKey) },
                supplied: supplied !== undefined,
            };
        },
    };
}

function normalizeSupplied(name: RoleName, value: string | undefined): Hex | undefined {
    if (value === undefined || value.trim() === "") return undefined;
    if (!/^0x[0-9a-fA-F]{64}$/.test(value.trim())) {
        throw new Error(`${name}: not a 32-byte hex private key (got ${value.trim().length} chars)`);
    }
    return value.trim() as Hex;
}

/**
 * A supplied key is 32 bytes and says nothing about which curve it belongs to, so the check is
 * whether this chain's curve can use it at all. Silently using secp256k1 bytes as an ed25519 seed
 * produces a perfectly valid key for an account nobody named.
 *
 * **ed25519 is refused rather than accepted, deliberately.** `supplied` is keyed by role name
 * alone, so there is nowhere to put a per-chain override — one `RELAYER_PRIVATE_KEY` cannot mean
 * two curves. And a Solana secret arrives as a base58 keypair or 64 bytes, while SLIP-0010 yields a
 * 32-byte seed, so "it is 32 hex bytes" does not identify which one was meant. Guessing is exactly
 * the failure above. Supporting it means making `supplied` per-(role, chain) and naming the
 * encoding; until then the phrase derives Solana role keys.
 */
function assertSuppliedKeyUsable(name: RoleName, key: Hex, scheme: RoleChainScheme): Hex {
    if (scheme.curve !== "secp256k1") {
        throw new Error(
            `${name} was given a raw private key, but ${scheme.namespace} uses ${scheme.curve}. ` +
                "This server has one key slot per role, not one per role and chain, so it cannot " +
                "tell which chain that key was for — and a 32-byte value is a valid seed on either " +
                "curve, so guessing yields a key for an account nobody named. Clear the override " +
                "and let ROLE_MNEMONIC derive this role, or add a per-chain slot first.",
        );
    }
    return key;
}

function deriveOnCurve(mnemonic: string, scheme: RoleChainScheme, accountIndex: number): Hex {
    if (!validateMnemonic(mnemonic.trim().replace(/\s+/g, " "), wordlist)) {
        throw new Error("ROLE_MNEMONIC is not a valid BIP-39 English mnemonic.");
    }
    const seed = mnemonicToSeedSync(mnemonic.trim().replace(/\s+/g, " "));

    switch (scheme.curve) {
        case "secp256k1": {
            const node = HDKey.fromMasterSeed(seed).derive(scheme.path(accountIndex));
            if (node.privateKey === null) throw new Error(`No private key at ${scheme.path(accountIndex)}`);
            return bytesToHex(node.privateKey);
        }
        case "ed25519":
            // Not BIP-32: that scheme adds scalars on secp256k1, and ed25519 keys are not scalars
            // you may add. SLIP-0010 is the one that covers this curve, and it comes from the
            // shared package so the server and the wallet cannot disagree about what a path means.
            return bytesToHex(slip10Ed25519(seed, scheme.path(accountIndex)));
    }
}

function publicKeyFor(privateKey: Hex, curve: Curve): PublicKey {
    const seed = hexToBytes32(privateKey);
    switch (curve) {
        case "secp256k1":
            // Compressed, 33 bytes — what `PublicKey` documents for this algorithm.
            return { algorithm: "secp256k1", bytes: secp256k1.getPublicKey(seed, true) };
        case "ed25519":
            return { algorithm: "ed25519", bytes: ed25519.getPublicKey(seed) };
    }
}

function hexToBytes32(hex: Hex): Uint8Array {
    const bare = hex.slice(2);
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++) out[i] = Number.parseInt(bare.slice(i * 2, i * 2 + 2), 16);
    return out;
}
