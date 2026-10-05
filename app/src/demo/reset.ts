/**
 * Start the wallet over, and by default keep what a recovery needs.
 *
 * **Two resets, because the demo has two questions.** The common one is "I lost my seed, can I get
 * back in?", and that is only a smooth demo if the seal and records survive: they stand in for the
 * copy a real user keeps somewhere other than the device, and making them re-import a file every
 * time proves nothing new. So the default clears the **seeds** and the **handovers**, and keeps the
 * seals, the records and the vault ledger. The other question, "start from nothing", is still one
 * checkbox away and deletes the whole database, as it always did.
 *
 * Handovers go either way. Each one names a destination seed, and the seeds are what is being
 * reset, so a kept handover would point at a key this browser no longer has.
 *
 * It takes both stores because they are two halves of one wallet: seeds live in `localStorage` and
 * everything they derived lives in IndexedDB. The watch records in `localStorage` follow the vaults:
 * kept when the vaults are, cleared when they are not.
 *
 * **To replace:** all of it. A wallet has no reset button; losing the device is the reset, which is
 * the event this whole repo is about.
 */
import { clearStores, deleteDatabase, STORES } from "../integration/storage/indexeddb.js";

export interface ResetSummary {
    /** What was on devnet stays there. Saying so stops "reset" reading as "refunded". */
    note: string;
}

/** `localStorage` keys that belong to a vault rather than to a seed. */
const VAULT_KEY_PREFIX = "nihilium-demo-watch:";

export async function resetDemo(options: { keepRecovery: boolean }): Promise<ResetSummary> {
    // IndexedDB first: it is the one that can refuse, and clearing the seeds before finding that
    // out would leave a wallet that cannot derive the accounts its vaults still point at.
    if (options.keepRecovery) {
        await clearStores([STORES.handovers, STORES.simAttempts]);
    } else {
        await deleteDatabase();
    }
    try {
        if (options.keepRecovery) {
            const drop: string[] = [];
            for (let i = 0; i < window.localStorage.length; i += 1) {
                const key = window.localStorage.key(i);
                if (key !== null && !key.startsWith(VAULT_KEY_PREFIX)) drop.push(key);
            }
            for (const key of drop) window.localStorage.removeItem(key);
        } else {
            window.localStorage.clear();
        }
    } catch {
        // A private window, or blocked site data. The seeds were never persisted there anyway.
    }
    return {
        note: options.keepRecovery
            ? "Every seed and handover is gone. The seals and records stayed, so a recovery needs no file."
            : "Every seed, seal, record and handover this browser held is gone.",
    };
}
