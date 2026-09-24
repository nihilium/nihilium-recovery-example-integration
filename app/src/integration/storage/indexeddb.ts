/**
 * The twenty lines of IndexedDB plumbing everything else in this directory sits on.
 *
 * Opens per operation and closes when the transaction completes. That is not tidiness: the SDK's
 * storage conformance suites build a store, use it, and then build a *second* one expecting to see
 * the first one's data — a "survives a reopen" case that a long-lived connection would pass for the
 * wrong reason. Opening per call makes the reopen real every time.
 *
 * **To replace:** the database name, if your app already owns one. **Assumes:** a browser with
 * IndexedDB, or `fake-indexeddb` under a test runner; nothing here touches `window`.
 */

/**
 * 2 — the quorum condition changed shape.
 *
 * `nihilium-quorum-vault-v1` and `-record-v1` now tag a *different* structure than they did before:
 * one keypair per vault instead of one split per record. The tag did not change with it, so a seal
 * written by the old code does not fail a version check — it fails later, on a missing `splitId`,
 * during a recovery the user has already paid for and waited on.
 *
 * So the upgrade drops what is there. Those rows are not recoverable by this build under any
 * circumstances, and a demo that keeps them is a demo that fails at the least helpful moment.
 */
/**
 * 3 — a vault is identified by its wallet, and the EVM account moved.
 *
 * Two changes land together and either one alone would strand what is stored. `VaultRecord` gained
 * `walletId`, without which a vault is invisible to every lookup rather than merely wrong. And the
 * Safe now names a module attester, which is hashed into its address — so `ChainContext.accountId`
 * for EVM is a different address than it was, and `accountId` is a KDF input the envelope does not
 * carry. A vault sealed by the old build derives keys for an account that no longer exists.
 *
 * Dropped rather than migrated, for the same reason as v2: there is no version of these rows this
 * build can honour, and a demo that keeps them fails at the least helpful moment — after a paid
 * ceremony, during a recovery.
 */
/**
 * 4 — the Solana vault address stopped depending on the gate.
 *
 * The program's PDA seed was a hash of the SDK's `vaultId`, which is minted fresh on every re-seal,
 * so replacing guardians created a *new* vault at a new address and left the balance in the old
 * one. It is a constant now, and every stored Solana chain record therefore holds an `accountId`
 * this build no longer derives — a KDF input pointing at an account it will not find.
 *
 * Dropped rather than migrated, as at v2 and v3: there is no rewriting that makes those rows true,
 * and keeping them means a recovery derived against an address nothing honours.
 */
/**
 * **v5 adds `handovers` and drops nothing.** Unlike v2–v4, this is a purely additive upgrade: the
 * clearing below is gated on `oldVersion < 4`, and every store is created only when absent. A
 * recovery in flight survives it, which matters because that is exactly what the new store holds.
 */
export const DB_VERSION = 5;

/** Every store this app keeps. Declared in one place so an upgrade is a diff, not an archaeology. */
export const STORES = {
    /** vaultId -> { vaultId, storedAt, blob }. Bearer material: one row is a whole seal. */
    seals: "seals",
    /** Append-only encrypted records, indexed by recordId and by (recordId, entryId). */
    records: "records",
    /** This app's own ledger of what it sealed — see `recovery/vaultRecords.ts`. */
    vaults: "vaults",
    /** Simulated settlement attempts, so a demo veto survives a reload. */
    simAttempts: "sim-attempts",
    /**
     * Recoveries submitted on-chain and waiting out a timelock — see `recovery/handovers.ts`.
     *
     * Holds **signed intents, never keys**. A timelock can outlast a browser session by days, and
     * the recovered key cannot be kept for it: writing bearer material to disk is the thing §12
     * exists to prevent, and a vault is spent once opened, so losing the key means losing the
     * recovery with no way to redo it short of another paid ceremony. Signing every chain's intent
     * at recovery time and storing *those* gets the wait for free — an intent authorises one
     * handover to one named owner and nothing else.
     */
    handovers: "handovers",
} as const;

export interface IdbOptions {
    /** Defaults to `nihilium-recovery-demo`. Tests pass a fresh name per case. */
    dbName?: string;
}

export const DEFAULT_DB_NAME = "nihilium-recovery-demo";

function open(dbName: string): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(dbName, DB_VERSION);

        request.onupgradeneeded = (event) => {
            const db = request.result;

            // Anything written before v4 holds seals or vaults this build cannot honour — see
            // `DB_VERSION`. Cleared here rather than filtered on read, so there is no path where a
            // stale seal reaches a paid ceremony.
            if (event.oldVersion > 0 && event.oldVersion < 4) {
                const upgrade = request.transaction;
                for (const name of [STORES.seals, STORES.records, STORES.vaults]) {
                    if (db.objectStoreNames.contains(name)) upgrade?.objectStore(name).clear();
                }
            }

            if (!db.objectStoreNames.contains(STORES.seals)) {
                db.createObjectStore(STORES.seals, { keyPath: "vaultId" });
            }
            if (!db.objectStoreNames.contains(STORES.records)) {
                const records = db.createObjectStore(STORES.records, { autoIncrement: true });
                records.createIndex("byRecord", "recordId", { unique: false });
                // Unique, so IndexedDB itself rejects a duplicate entry rather than this app
                // read-modify-writing its way into a race. The rejection becomes the SDK's own
                // `OneWayViolationError` in `dataStore.ts`.
                records.createIndex("byEntry", ["recordId", "entryId"], { unique: true });
            }
            if (!db.objectStoreNames.contains(STORES.vaults)) {
                db.createObjectStore(STORES.vaults, { keyPath: "vaultId" });
            }
            if (!db.objectStoreNames.contains(STORES.handovers)) {
                // `${vaultId}:${chainId}` — one handover per chain per vault, replaced in place as
                // it advances from submitted to executed to swept.
                const handovers = db.createObjectStore(STORES.handovers, { keyPath: "id" });
                handovers.createIndex("byVault", "vaultId", { unique: false });
            }
            if (!db.objectStoreNames.contains(STORES.simAttempts)) {
                db.createObjectStore(STORES.simAttempts, { keyPath: "attemptId" });
            }
        };

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("Could not open IndexedDB"));
    });
}

function promisify<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
    });
}

/**
 * Runs `fn` inside one transaction and resolves when the transaction *completes* — not when the
 * request succeeds. A write that resolved on `onsuccess` would let a caller observe data that the
 * transaction had not yet committed.
 */
export async function withStore<T>(
    options: IdbOptions,
    storeName: string,
    mode: IDBTransactionMode,
    fn: (store: IDBObjectStore, run: <R>(request: IDBRequest<R>) => Promise<R>) => Promise<T> | T,
): Promise<T> {
    const db = await open(options.dbName ?? DEFAULT_DB_NAME);
    try {
        const tx = db.transaction(storeName, mode);
        const store = tx.objectStore(storeName);

        const settled = new Promise<void>((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
            tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
        });
        // A failed request aborts its transaction, so one cause rejects both promises. Marking this
        // one observed keeps the abort from surfacing as a second, unhandled rejection — the request's
        // own error is the specific one, and it is what the caller gets.
        void settled.catch(() => undefined);

        const result = await fn(store, promisify);
        await settled;
        return result;
    } finally {
        db.close();
    }
}

/** Structured-cloned on the way out, so a caller mutating what it got cannot reach this store. */
export function detach<T>(value: T): T {
    return structuredClone(value);
}

/**
 * Delete the whole database.
 *
 * A demo affordance, and deliberately blunt: there is no migration path here and no attempt at one.
 * Seals are bearer material and records are append-only, so "repair the rows" is not a thing this
 * app can honestly offer — what it can offer is starting over, which is the right answer for a
 * throwaway devnet wallet and never the right answer for a real one.
 *
 * Resolves once the delete completes. A blocked delete — another tab holding the database open —
 * rejects rather than hanging, because a reset that silently did nothing is worse than one that
 * says which tab to close.
 */
export function deleteDatabase(dbName = DEFAULT_DB_NAME): Promise<void> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.deleteDatabase(dbName);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error ?? new Error(`Could not delete ${dbName}.`));
        request.onblocked = () =>
            reject(
                new Error(
                    `Another tab still has "${dbName}" open, so it cannot be deleted. Close the ` +
                        "other tabs on this app and try again.",
                ),
            );
    });
}
