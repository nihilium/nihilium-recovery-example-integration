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
import { secp256k1 } from "@noble/curves/secp256k1.js";
import type { Authority, PublicKey } from "@nihilium/recovery-core";
import { toEvmAddress } from "@nihilium/recovery-key-evm";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { bytesToHex, type Hex } from "viem";

/** The Hardhat/Anvil default, matching `app/src/demo/mnemonic.ts`. Public, on purpose. */
export const DEMO_ROLE_MNEMONIC = "test test test test test test test test test test test junk";

export type RoleName = "relayer" | "pause" | "abort" | `resume-${number}`;

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
    // Solana and Zcash have no settlement program for a role to act on yet. When one lands, its
    // entry goes here — and an ed25519 entry needs `deriveOnCurve` below to grow a SLIP-0010 branch,
    // which means promoting `app/src/integration/keys/` to a workspace package both halves import
    // rather than copying it. That move is the point at which it earns its keep, not before.
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
 */
function assertSuppliedKeyUsable(name: RoleName, key: Hex, scheme: RoleChainScheme): Hex {
    if (scheme.curve !== "secp256k1") {
        throw new Error(
            `${name} was given a raw private key, but ${scheme.namespace} uses ${scheme.curve}. ` +
                "Supply a key for that curve under its own variable, or let the role phrase derive it.",
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
            // Deliberately a throw rather than a silent BIP-32 derivation: BIP-32 is secp256k1-only,
            // and ed25519 needs SLIP-0010. Wiring it means sharing `app/src/integration/keys/`
            // between the two halves rather than copying it here.
            throw new Error(
                `${scheme.namespace} needs ed25519 (SLIP-0010) role keys, which this server cannot ` +
                    "derive yet. Promote app/src/integration/keys/ to a workspace package and import " +
                    "slip10Ed25519 here.",
            );
    }
}

function publicKeyFor(privateKey: Hex, curve: Curve): PublicKey {
    if (curve !== "secp256k1") {
        throw new Error(`No public-key derivation wired for ${curve}; see deriveOnCurve.`);
    }
    const bytes = secp256k1.getPublicKey(hexToBytes32(privateKey), true);
    return { algorithm: "secp256k1", bytes };
}

function hexToBytes32(hex: Hex): Uint8Array {
    const bare = hex.slice(2);
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++) out[i] = Number.parseInt(bare.slice(i * 2, i * 2 + 2), 16);
    return out;
}
