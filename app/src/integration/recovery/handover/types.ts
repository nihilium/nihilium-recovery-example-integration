/**
 * Moving a recovered account, as one shape for every chain.
 *
 * Three steps and a wait, and the wait is the chain's, not ours: **initiate** submits a signed
 * intent, the timelock runs, **execute** moves control, **sweep** sends what the account holds to
 * somewhere the new owner already controls. A caller drives all three the same way on every chain,
 * which is what lets one button move a whole vault instead of one chain at a time.
 *
 * The split between `initiate` and the rest is where the key lives. `initiate` is the only step that
 * needs the recovered key — it signs the intent — and it happens immediately, so the key can be
 * wiped before anything waits. `execute` takes no signature at all (the timelock is the authority),
 * and `sweep` is signed by the destination key, which the wallet holds anyway. That is what makes a
 * recovery survivable across a reload without any key ever reaching disk.
 *
 * **To replace:** the implementations, one per chain. **Assumes:** the intent handed to `execute` is
 * byte-identical to the one `initiate` submitted — the module re-hashes it and compares, so a
 * re-encoded field is an attempt that can never mature.
 */
import type { KeyAdapter } from "@nihilium/recovery-core";

/**
 * The little a handover needs to know about the account, and deliberately not `VaultChainRecord`.
 *
 * `execute` and `sweep` run in a later session, from a row in IndexedDB — long after the vault
 * record that produced it may have been deleted. Narrowing to these three fields is what lets the
 * stored row be the whole input, rather than something that has to be joined back to a ledger the
 * user is free to clear.
 */
export interface HandoverAccount {
    /** `ChainContext.accountId` — the Safe on EVM, the vault PDA on Solana. */
    accountId: string;
    /**
     * The key that created the account, where the account is not that key.
     *
     * Solana's PDA is seeded by its creator and the seed is not reversible, so without this the
     * addresses cannot be rebuilt in a session that does not hold the original seed — which is the
     * ordinary case for a recovery. Absent on EVM, where the account is its own address.
     */
    signerAddress?: string | undefined;
    /** The recovery key this vault registered. Read by `initiate`; never re-derived. */
    recoveryPubKeyHex?: string | undefined;
}

export interface HandoverContext {
    chainRecord: HandoverAccount;
    /** Where the relayer lives. It pays the gas; the account being recovered has none by definition. */
    serverUrl: string;
    onProgress?(message: string): void;
}

export interface InitiateParams extends HandoverContext {
    /** The curve's signer, from the chain module. */
    keyAdapter: KeyAdapter;
    /** The recovered key, in the clear. Used once, here, and wiped by the caller straight after. */
    material: Uint8Array;
    /** The key that will control the account — one the destination seed derives. */
    newOwner: string;
}

export interface InitiateResult {
    /** Kept verbatim for `execute`. Opaque to everything above this layer. */
    intent: unknown;
    hash: string;
}

export interface ExecuteParams extends HandoverContext {
    /** Byte-identical to what `initiate` submitted. */
    intent: unknown;
}

export interface SweepParams extends HandoverContext {
    /** Where the funds go. The destination seed's own account, not the key that now controls this one. */
    to: string;
    /** The new owner's key, so this can sign as the account it just took over. */
    ownerPrivateKeyHex: string;
    /** Base units. `null` sweeps everything the account holds, less whatever it must keep back. */
    amount: bigint | null;
}

export interface AbortParams extends HandoverContext {
    /**
     * The abort authority's key, in the clear.
     *
     * In this demo that is the **wallet's own EOA** — the SDK calls it the natural default, because
     * the common case for abort is not a rogue provider at all: it is somebody opening a recovery
     * while the owner still has access, and the obvious party to stop that is whoever holds the key.
     *
     * It follows that abort is the one step the relayer cannot do. `initiate` and `execute` carry
     * their authority in a signature, so anyone with gas may submit them; `abort` checks the
     * *sender*, so this key signs its own transaction and must be able to pay for it. And it follows
     * that in the case recovery exists for — the seed is gone — this key is gone with it, which is
     * the cost of seating abort with the owner rather than with a third party.
     */
    authorityPrivateKeyHex: string;
}

export interface SweepResult {
    hash: string;
    /** What actually moved, after any reserve the chain requires. */
    moved: bigint;
}

/** One chain's implementation. `null` on a chain this demo cannot carry through. */
export interface ChainHandover {
    initiate(params: InitiateParams): Promise<InitiateResult>;
    execute(params: ExecuteParams): Promise<{ hash: string }>;
    sweep(params: SweepParams): Promise<SweepResult>;
    /**
     * Kill an attempt. Terminal on both chains: a new recovery must start from a fresh ceremony.
     *
     * Unlike every other step here, this one is not part of finishing a handover — it is how the
     * owner refuses one.
     */
    abort(params: AbortParams): Promise<{ hash: string }>;
}
