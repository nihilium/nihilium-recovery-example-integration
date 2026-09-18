/**
 * `SealStore` over IndexedDB — where the demo keeps its bearer material.
 *
 * A seal is the one artifact that must not be duplicated carelessly: whoever holds it may *attempt*
 * a recovery, and the identity gate is all that stands between an attempt and a rotation. So this
 * store is the user's device, and the §12 placement rule says the copy the user keeps must not live
 * in the same domain as the identity factor it is gated behind — see `checkSealPlacement` in
 * `@nihilium/recovery-core`, which this app runs at setup time and renders the answer of.
 *
 * **To replace:** the whole file, if your wallet already has encrypted device storage — implement
 * the same four methods against it. Note `getSeal` **throws** on a missing vault rather than
 * resolving `undefined`; the SDK's conformance suite checks that, because a store that answers
 * "nothing here" for a seal a user believes in is worse than one that fails loudly.
 * **Assumes:** one seal per `vaultId`, and that a re-seal replaces (seals are mutable, unlike
 * records).
 */
import type { SealBlob, SealRef, SealStore } from "@nihilium/recovery-core";
import { detach, STORES, withStore, type IdbOptions } from "./indexeddb.js";

export class SealNotFoundError extends Error {
    override readonly name = "SealNotFoundError";
    constructor(vaultId: string) {
        super(`No seal for vault "${vaultId}" in this browser. Import the seal file you downloaded.`);
    }
}

interface SealRow {
    vaultId: string;
    storedAt: number;
    blob: SealBlob;
}

export class IdbSealStore implements SealStore {
    /**
     * Truthful, and load-bearing: `checkSealPlacement` compares this against the identity factor's
     * domain. "local" would be a lie that happens to pass the check.
     */
    readonly domain: string;

    constructor(private readonly options: IdbOptions & { domain?: string } = {}) {
        this.domain = options.domain ?? "browser-indexeddb";
    }

    async putSeal(vaultId: string, blob: SealBlob): Promise<void> {
        const row: SealRow = { vaultId, storedAt: Math.floor(Date.now() / 1000), blob };
        await withStore(this.options, STORES.seals, "readwrite", (store, run) =>
            run(store.put(row)),
        );
    }

    async getSeal(vaultId: string): Promise<SealBlob> {
        const row = await withStore(this.options, STORES.seals, "readonly", (store, run) =>
            run<SealRow | undefined>(store.get(vaultId)),
        );
        if (row === undefined) throw new SealNotFoundError(vaultId);
        return detach(row.blob);
    }

    /** A seal that is already gone is the state the caller wanted. Not an error. */
    async deleteSeal(vaultId: string): Promise<void> {
        await withStore(this.options, STORES.seals, "readwrite", (store, run) =>
            run(store.delete(vaultId)),
        );
    }

    async listSeals(): Promise<SealRef[]> {
        const rows = await withStore(this.options, STORES.seals, "readonly", (store, run) =>
            run<SealRow[]>(store.getAll()),
        );
        return rows.map((row) => ({ vaultId: row.vaultId, storedAt: row.storedAt }));
    }
}
