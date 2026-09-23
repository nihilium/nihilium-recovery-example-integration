/**
 * What an operation is doing, and — once it is done — what it did.
 *
 * The lines themselves are the point of this repo: every step logs in SDK terms (`sealVault`,
 * `openRecords`, `initiateRecovery`) so a reader sees the API rather than prose. But a growing wall
 * of monospace is the wrong shape for *watching* something happen, and it stayed on screen long
 * after anyone cared. So the same lines get two forms:
 *
 * - **Running:** one bar and the newest line. The bar is indeterminate on purpose. A ceremony is
 *   paid, plural and human — it finishes when guardians answer their email — so a bar that filled
 *   toward a predicted end would be inventing a number the app does not have, and this repo's whole
 *   argument is that recovery is slow in ways a progress bar cannot flatter.
 * - **Finished:** collapsed to a single summary the reader can open. `<details>` starts closed, so
 *   the transcript hides itself the moment the operation ends without anything having to remember
 *   to clear it.
 *
 * **To replace:** nothing — this is presentation. **Assumes:** `lines` is append-only for one
 * operation. A channel shared by two would show the wrong one's last line as "now", which is the
 * bug `transcripts.test.ts` exists to prevent.
 */
export function Transcript({
    lines,
    running,
    label,
}: {
    lines: readonly string[];
    /** Whether the operation is still going. Flipping this to false is what collapses the log. */
    running: boolean;
    /** What is happening, for the bar's own line. Two or three words. */
    label: string;
}) {
    if (lines.length === 0 && !running) return null;

    const latest = lines.at(-1);

    if (running) {
        return (
            <div className="progress" role="status" aria-live="polite">
                <div className="progress__bar" aria-hidden="true">
                    <span className="progress__sweep" />
                </div>
                <span className="progress__line mono">{latest ?? `${label}…`}</span>
            </div>
        );
    }

    return (
        <details className="transcript-fold">
            <summary>
                <span className="disclosure__marker" aria-hidden="true" />
                {label} · {lines.length} {lines.length === 1 ? "line" : "lines"}
            </summary>
            <pre className="transcript">{lines.join("\n")}</pre>
        </details>
    );
}
