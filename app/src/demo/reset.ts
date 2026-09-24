/**
 * Throw everything away and start over.
 *
 * **Demo-only, and the honest answer to a wedged state.** This app has no migration paths by
 * design: a seal is bearer material, records are append-only, and a handover row is the only
 * surviving record of an intent whose signing key was destroyed on purpose. There is no shape of
 * "repair" that is truthful. What there *is* — on a throwaway devnet wallet — is starting again,
 * and having that be one visible button beats a user clearing site data by hand and wondering what
 * they just lost.
 *
 * It takes both stores because they are two halves of one wallet: seeds live in `localStorage` and
 * everything they derived lives in IndexedDB. Clearing one leaves seeds whose vaults are gone, or
 * vaults no seed can claim — states the app would render, and would be right to.
 *
 * **To replace:** all of it. A wallet has no reset button; losing the device is the reset, which is
 * the event this whole repo is about.
 */
import { deleteDatabase } from "../integration/storage/indexeddb.js";

export interface ResetSummary {
    /** What was on devnet stays there. Saying so stops "reset" reading as "refunded". */
    note: string;
}

export async function resetDemo(): Promise<ResetSummary> {
    // IndexedDB first: it is the one that can refuse, and clearing the seeds before finding that
    // out would leave a wallet that cannot derive the accounts its vaults still point at.
    await deleteDatabase();
    try {
        window.localStorage.clear();
    } catch {
        // A private window, or blocked site data. The seeds were never persisted there anyway.
    }
    return {
        note:
            "Every seed, seal, record and handover this browser held is gone. Nothing on-chain " +
            "changed: the accounts still exist on Sepolia and devnet, and anything they hold is " +
            "still there — this browser simply no longer has the keys or the seals for them.",
    };
}
