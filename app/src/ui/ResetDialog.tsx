/**
 * Starting over, with what it costs said first.
 *
 * A `Dialog` because it is irreversible, and irreversible things do not happen on a page in this
 * app. The copy names what is destroyed and — as importantly — what is not: resetting the browser
 * does not move anything on-chain, and a user who read "reset" as "undo" would be wrong in the
 * direction that loses funds.
 */
import { useState } from "react";
import { resetDemo } from "../demo/reset.js";
import { Button, StatusMessage } from "./ds.js";
import { Dialog, DialogActions } from "./Dialog.js";
import { Notice } from "./Notice.js";

export function ResetDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function run(): Promise<void> {
        setBusy(true);
        setError(null);
        try {
            await resetDemo();
            // Reloaded rather than re-rendered: every hook here holds state derived from the two
            // stores that no longer exist, and reconciling that in place is a lot of code for a
            // path whose whole point is that nothing is worth keeping.
            window.location.reload();
        } catch (failure) {
            setBusy(false);
            setError(failure instanceof Error ? failure.message : String(failure));
        }
    }

    return (
        <Dialog
            open={open}
            title="Reset this demo"
            onClose={onClose}
            dismissible={!busy}
            footer={
                <DialogActions back={{ label: "Cancel", onClick: onClose, disabled: busy }}>
                    <Button onClick={() => void run()} disabled={busy}>
                        {busy ? "Clearing…" : "Delete everything"}
                    </Button>
                </DialogActions>
            }
        >
            <div className="stack">
                <Notice tone="caution">
                    Deletes every seed, seal, record and handover in this browser. Download seal files
                    first — they exist nowhere else.
                </Notice>
                <p>On-chain accounts and pending recoveries are unaffected.</p>
                {error !== null && <StatusMessage tone="error">{error}</StatusMessage>}
            </div>
        </Dialog>
    );
}
