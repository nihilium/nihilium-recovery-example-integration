/**
 * `SealedDataStore` over IndexedDB — the encrypted records, which are inert without the seal.
 *
 * The placement rule here is the exact inverse of the seal's: a record discloses nothing on its own,
 * so the failure to design against is *losing* it, and the mitigation is to keep copies everywhere.
 * `mirrorDataStore.ts` is that, and this is the local half.
 *
 * **To replace:** the storage calls. What must not change is the shape of the guarantees: add-only,
 * no update, no delete, and no listing — there is deliberately no `listRecords` on the interface,
 * because a listing would make whoever holds the records a directory of who has a recovery.
 * **Assumes:** the caller passes record ids in any form; every method normalizes first, so the
 * display form `K7M2-9QX4-…` and the canonical form hit the same record.
 */
import {
    normalizeRecordId,
    OneWayViolationError,
    SEALED_DATA_STORE_SUBJECT,
    type RecordId,
    type SealedDataEntry,
    type SealedDataStore,
} from "@nihilium/recovery-core";
import { detach, STORES, withStore, type IdbOptions } from "./indexeddb.js";

interface RecordRow {
    recordId: string;
    entryId: string;
    entry: SealedDataEntry;
}

export class IdbSealedDataStore implements SealedDataStore {
    readonly domain: string;

    constructor(private readonly options: IdbOptions & { domain?: string } = {}) {
        this.domain = options.domain ?? "browser-indexeddb";
    }

    async addEntry(recordId: RecordId, entry: SealedDataEntry): Promise<void> {
        // First, and not defensively: a malformed id must be refused here rather than becoming a
        // record nobody can look up again.
        const id = normalizeRecordId(recordId);
        const row: RecordRow = {
            recordId: id,
            entryId: entry.entryId,
            entry: { ...entry, storedAt: entry.storedAt ?? Math.floor(Date.now() / 1000) },
        };

        try {
            await withStore(this.options, STORES.records, "readwrite", (store, run) => run(store.add(row)));
        } catch (error) {
            // The unique `byEntry` index is what detects this, so the rejection is atomic — no
            // read-then-write window where two appends both see an empty slot. Re-thrown as the
            // SDK's own error rather than a new one, so callers catch what the contract names.
            if (isConstraintError(error)) {
                throw new OneWayViolationError(
                    id,
                    `entry "${entry.entryId}" already exists and records are never replaced`,
                    SEALED_DATA_STORE_SUBJECT,
                );
            }
            throw error;
        }
    }

    /** Oldest first — which is insertion order, which is primary-key order for an autoIncrement store. */
    async getEntries(recordId: RecordId): Promise<SealedDataEntry[]> {
        const id = normalizeRecordId(recordId);
        const rows = await withStore(this.options, STORES.records, "readonly", (store, run) =>
            run<RecordRow[]>(store.index("byRecord").getAll(id)),
        );
        // IndexedDB already deserializes fresh, but the clone is the greppable guarantee: the
        // conformance suite mutates what it is handed and expects the store to be unmoved.
        return rows.map((row) => detach(row.entry));
    }
}

function isConstraintError(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        "name" in error &&
        (error as { name?: unknown }).name === "ConstraintError"
    );
}
