/**
 * Has anyone started a recovery against this vault?
 *
 * This is the watchtower's question, and the answer this build can honestly give is mostly **no
 * idea**. A recovery started from somewhere else is exactly the event a watchtower exists to catch,
 * and there is no watchtower here yet — so the resting state is `unwatched`, not "healthy".
 *
 * CLAUDE.md is explicit that `unknown` never renders as all-clear, and this is where that rule earns
 * its keep: a green tick over an unmonitored vault is a worse lie than no indicator at all, because
 * the user stops looking. What the app *does* know is what it did itself, and those two states
 * (`in-progress`, `spent`) are reported as facts rather than as reassurance.
 */
import type { VaultRecord } from "../integration/recovery/vaultRecords.js";

export type RecoveryHealth = "in-progress" | "spent" | "unwatched";

export function healthOf(vault: VaultRecord | null, recovering: boolean): RecoveryHealth | null {
    if (vault === null) return null;
    if (recovering) return "in-progress";
    if (vault.spent !== null) return "spent";
    return "unwatched";
}

export const HEALTH_LABELS: Record<RecoveryHealth, string> = {
    "in-progress": "Recovery under way",
    spent: "Recovery completed",
    // Never "healthy", never a tick — but it names the missing piece rather than reading as an
    // accusation. "Not being watched" makes a reader ask why; this answers it in the badge.
    unwatched: "No watchtower yet",
};

export const HEALTH_DETAIL: Record<RecoveryHealth, string> = {
    "in-progress": "A recovery started from this browser is running now.",
    spent: "This vault has been opened. Every chain it protected was exposed to whoever opened it.",
    unwatched:
        "Nothing is registered to watch this vault, so a recovery started by somebody else would " +
        "not appear here. This is not the same as “nothing is happening”. The watchtower role is " +
        "not built in this demo yet — server/src/roles/ is empty.",
};
