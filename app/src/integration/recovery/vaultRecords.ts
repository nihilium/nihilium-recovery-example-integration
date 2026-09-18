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
    type ChainContext,
    type KeyAlgorithm,
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
}

export interface VaultRecord {
    vaultId: string;
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
 * Run after **every** recovery, on every path. This is not a defensive extra: it is the only check
 * that exists for a wrong epoch, and it necessarily happens after the fact — the ceremony has
 * already run, and the money has already been spent, by the time it can be made.
 */
export function assertRecoveredKeyMatches(
    authority: RecoveredAuthority,
    chain: VaultChainRecord,
): void {
    const actual =
        authority.kind === "capability"
            ? bytesToHex(authority.capability.publicKey.bytes)
            : undefined;
    if (actual === undefined) {
        // `rawKey` mode hands back private bytes with no public half attached; a caller using it owns
        // this check itself, and saying so beats pretending we made it.
        throw new Error(
            "assertRecoveredKeyMatches needs a capability. In rawKey mode, derive the public key " +
                "with the chain's KeyAdapter and compare it yourself — do not skip the comparison.",
        );
    }
    if (actual !== chain.recoveryPubKeyHex) {
        throw new RecoveredKeyMismatchError(chain.recoveryPubKeyHex, actual, chain);
    }
}

/** The display form, for anything a human reads or is invited to write down. */
export function displayRecordId(record: VaultRecord): string {
    return formatRecordId(record.recordId);
}
