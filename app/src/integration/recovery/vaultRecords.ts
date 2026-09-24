/**
 * This app's ledger of what it sealed — and the file that keeps the epoch footgun from firing.
 *
 * `ChainContext` is entirely KDF input: namespace, accountId, vaultId and epoch all feed the
 * derivation, and the envelope records every one of them **except `epoch`**. So a recovery run at
 * the wrong epoch does not fail — it derives a different, perfectly valid key for an account that
 * has never heard of it, with no error at any layer. The only thing that catches it is comparing the
 * recovered public key against the one `seal()` handed back, which is why this file owns both the
 * record and the check.
 *
 * **To replace:** the storage calls, and nothing else. Whatever a real wallet keeps its metadata in,
 * it must keep *these fields*, and it must build its `ChainContext` through one function rather than
 * writing the literal in three places that drift.
 * **Assumes:** one vault per `vaultId`, and that `chainContextOf` is the only constructor of a
 * `ChainContext` in the codebase. A test enforces the second part.
 */
import {
    formatRecordId,
    type KeyAdapter,
    type ChainContext,
    type KeyAlgorithm,
    type PublicKey,
    type RecordId,
    type RecoveredAuthority,
    type SealPublicComponent,
    type Tier,
} from "@nihilium/recovery-core";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { GateRecord } from "../conditions/types.js";
import { detach, STORES, withStore, type IdbOptions } from "../storage/indexeddb.js";

/** One chain this vault protects. One per `addChain()`, and one per t-address on a UTXO chain. */
export interface VaultChainRecord {
    chainId: string;
    /** Pinned at seal time. Never recomputed from the registry — it is a KDF input. */
    namespace: string;
    tier: Tier;
    /** Verbatim: the SDK compares it as a raw string, so case is part of the key. */
    accountId: string;
    /** The footgun. See the header. */
    epoch: number;
    algorithm: KeyAlgorithm;
    /** What `seal()` / `addChain()` returned. The only evidence a recovery derived the right key. */
    recoveryPubKeyHex: string;
    entryId: string;
    addedAt: number;
    /** Milliseconds the write took — how the ceremony/append asymmetry gets measured, not asserted. */
    writeMs: number;
    /** Null until the chain has registered this key. Sealed is not the same as protected. */
    settlement: { address: string; txHash: string | null; registeredAt: number } | null;
    /**
     * The wallet key behind this account, where the account is not that key.
     *
     * Needed to recover a vault whose seed this browser no longer holds — the case recovery exists
     * for. On EVM nothing reads it: `accountId` is the Safe and the module is driven by the
     * recovered key's signature. On Solana `accountId` is a PDA seeded by its **creator**, which is
     * not derivable from the PDA, so without this the addresses cannot be rebuilt and the on-chain
     * handover has nothing to act on.
     *
     * Optional because records written before this existed do not carry it. A vault missing it is
     * still fully recoverable off-chain; it is the on-chain step that cannot run.
     */
    signerAddress?: string;
}

export interface VaultRecord {
    vaultId: string;
    /**
     * Which wallet this vault belongs to — the seed, not an address.
     *
     * **A vault is per wallet and covers many chains, so it cannot be identified by an address.**
     * Each chain's protected account is a different thing: on EVM it is the smart account, on
     * Solana a program-owned PDA that is not the wallet's key at all. Looking a vault up by "the
     * current chain's account" therefore finds it on the chain it was sealed from and misses it
     * everywhere else — which reads as "no recovery here" and offers a second paid ceremony. That
     * is the exact failure this field exists to make impossible.
     *
     * Opaque to this file, and supplied by the caller: the demo passes a fingerprint of the seed
     * phrase, and a real wallet would pass whatever it calls an account. Never the seed itself.
     */
    walletId: string;
    recordId: RecordId;
    createdAt: number;
    /**
     * Milliseconds `createVault()` took — the paid, online, once-per-vault half.
     *
     * Kept beside each chain's `writeMs` because the ratio between them is the thing worth seeing:
     * a ceremony is seconds and money, and putting another chain in the vault it produced is
     * milliseconds and free.
     */
    ceremonyMs: number;
    publicComponent: SealPublicComponent;
    gate: GateRecord;
    chains: VaultChainRecord[];
    /** Set once a recovery has opened it. A spent vault is never silently reused. */
    spent: { at: number; reason: string } | null;
    /**
     * How long a recovery must wait before it can execute, chosen at seal time and written into
     * each chain's veto config when that chain is protected.
     *
     * Absent on vaults sealed before it could be chosen; those use the operator's default. The chain
     * is still the authority on what is actually installed — this is what the *next* protect writes.
     */
    timelockSeconds?: number;
}

export class VaultRecordStore {
    constructor(private readonly options: IdbOptions = {}) {}

    async put(record: VaultRecord): Promise<void> {
        await withStore(this.options, STORES.vaults, "readwrite", (store, run) => run(store.put(record)));
    }

    async get(vaultId: string): Promise<VaultRecord | undefined> {
        const row = await withStore(this.options, STORES.vaults, "readonly", (store, run) =>
            run<VaultRecord | undefined>(store.get(vaultId)),
        );
        return row === undefined ? undefined : detach(row);
    }

    async list(): Promise<VaultRecord[]> {
        const rows = await withStore(this.options, STORES.vaults, "readonly", (store, run) =>
            run<VaultRecord[]>(store.getAll()),
        );
        return rows.map((row) => detach(row));
    }

    async delete(vaultId: string): Promise<void> {
        await withStore(this.options, STORES.vaults, "readwrite", (store, run) =>
            run(store.delete(vaultId)),
        );
    }
}

/**
 * The only place a `ChainContext` is constructed.
 *
 * Every field is a KDF input, and three of the four are checked against the envelope at recovery
 * time. The fourth, `epoch`, is not — so it can only come from a record written at seal time, never
 * from "what the chain says now". After a completed recovery the chain's epoch is ahead of this
 * record's, and that is correct: the seal was made under the old one.
 */
export function chainContextOf(
    vault: Pick<VaultRecord, "vaultId">,
    chain: Pick<VaultChainRecord, "namespace" | "tier" | "accountId" | "epoch">,
): ChainContext {
    return {
        namespace: chain.namespace,
        tier: chain.tier,
        accountId: chain.accountId,
        vaultId: vault.vaultId,
        epoch: chain.epoch,
    };
}

/**
 * The id for a new vault on this account — and the reason a re-seal cannot reuse the old one.
 *
 * `vaultId` is an HKDF input (see `chainContextOf`), so sealing twice under one id derives the **same
 * recovery key** behind a different gate: the seal you replaced still opens the account you thought
 * you had re-protected. It is also the key `SealStore` stores by, so the second seal would overwrite
 * the first with no error. A new gate needs a new id, and this is the only place one is minted.
 *
 * **Random, not a counter.** A counter would have to be derived from the vaults this device still
 * holds, and a replaced vault is deleted — so the count resets and the next gate is minted under an
 * id a discarded one already used. The old seal file on the user's disk does not know it was
 * discarded, and the record store is append-only, so that collision is not recoverable from. Six
 * random characters cost nothing and cannot count backwards. `existing` is still consulted, as the
 * cheap guard it is.
 */
export function nextVaultId(accountId: string, existing: readonly VaultRecord[]): string {
    const base = `vault-${accountId.replace(/^0x/i, "").slice(0, 8).toLowerCase()}`;
    const taken = new Set(existing.map((record) => record.vaultId));
    for (;;) {
        const candidate = `${base}-${randomSuffix()}`;
        if (!taken.has(candidate)) return candidate;
    }
}

function randomSuffix(): string {
    const bytes = new Uint8Array(4);
    crypto.getRandomValues(bytes);
    let value = 0;
    for (const byte of bytes) value = value * 256 + byte;
    return value.toString(36).padStart(6, "0").slice(-6);
}

export class RecoveredKeyMismatchError extends Error {
    override readonly name = "RecoveredKeyMismatchError";
    constructor(expected: string, actual: string, chain: VaultChainRecord) {
        super(
            `The recovered key is not the one this vault registered for ${chain.accountId} on ` +
                `${chain.namespace}: expected ${expected}, derived ${actual}. The derivation inputs ` +
                `differed — almost always the epoch, which is an HKDF input that the envelope does ` +
                `not carry, so nothing else in the stack can notice. This capability would sign ` +
                `perfectly valid signatures that the account rejects.`,
        );
    }
}

/**
 * The recovered key's public half, whichever mode the recovery ran in.
 *
 * A capability carries its own public key. `rawKey` hands back private bytes and nothing else, so
 * the public half has to be derived — and it must be derived with **this chain's** `KeyAdapter`,
 * because the curve belongs to the chain: deriving an ed25519 point from secp256k1 bytes would not
 * fail, it would produce a different key that matches nothing.
 */
export function recoveredPublicKey(
    authority: RecoveredAuthority,
    keyAdapter: KeyAdapter,
): PublicKey {
    return authority.kind === "capability"
        ? authority.capability.publicKey
        : keyAdapter.publicKeyFor(authority.material);
}

export function recoveredPublicKeyHex(
    authority: RecoveredAuthority,
    keyAdapter: KeyAdapter,
): string {
    return bytesToHex(recoveredPublicKey(authority, keyAdapter).bytes);
}

/**
 * Run after **every** recovery, on every path. This is not a defensive extra: it is the only check
 * that exists for a wrong epoch, and it necessarily happens after the fact — the ceremony has
 * already run, and the money has already been spent, by the time it can be made.
 *
 * It used to refuse `rawKey` outright and tell the caller to do the comparison themselves. That was
 * a check nobody would make: the mode that hands you bare private bytes is exactly the one where
 * skipping it is easiest, and a silent wrong epoch produces a key that signs perfectly valid
 * signatures the account rejects. The adapter is a parameter now, and the check runs either way.
 */
export function assertRecoveredKeyMatches(
    authority: RecoveredAuthority,
    chain: VaultChainRecord,
    keyAdapter: KeyAdapter,
): void {
    const actual = recoveredPublicKeyHex(authority, keyAdapter);
    if (actual !== chain.recoveryPubKeyHex) {
        throw new RecoveredKeyMismatchError(chain.recoveryPubKeyHex, actual, chain);
    }
}

/** The display form, for anything a human reads or is invited to write down. */
export function displayRecordId(record: VaultRecord): string {
    return formatRecordId(record.recordId);
}
