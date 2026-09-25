/**
 * An address, click to copy. Copy failure is shown, not swallowed: in an insecure context
 * `navigator.clipboard` is undefined, and a button that silently does nothing is worse than one
 * that says it could not.
 */
import { useState } from "react";

export function AddressChip({
    value,
    display,
    concealed = false,
}: {
    value: string;
    display: string;
    /**
     * Blur the text and drop the tooltip, for a value that should not sit readable on screen — a
     * seed phrase. Copying still works: taking the value elsewhere is the point, showing it is not.
     */
    concealed?: boolean;
}) {
    const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

    return (
        <button
            type="button"
            className="address-chip mono"
            // A tooltip is the value in plain text on hover, which would undo the blur.
            title={concealed ? "Copy" : value}
            {...(concealed ? { "aria-label": "Copy the hidden phrase" } : {})}
            onClick={async () => {
                try {
                    await navigator.clipboard.writeText(value);
                    setState("copied");
                } catch {
                    setState("failed");
                }
                setTimeout(() => setState("idle"), 1400);
            }}
        >
            <code
                className={concealed ? "concealed" : undefined}
                aria-hidden={concealed || undefined}
            >
                {display}
            </code>
            <span aria-hidden="true">
                {state === "copied" ? "✓" : state === "failed" ? "✗" : "⧉"}
            </span>
            {state === "failed" && <span className="address-chip__note">clipboard unavailable</span>}
        </button>
    );
}
