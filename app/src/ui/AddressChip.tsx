/**
 * An address, click to copy. Copy failure is shown, not swallowed: in an insecure context
 * `navigator.clipboard` is undefined, and a button that silently does nothing is worse than one
 * that says it could not.
 */
import { useState } from "react";

export function AddressChip({ value, display }: { value: string; display: string }) {
    const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

    return (
        <button
            type="button"
            className="address-chip mono"
            title={value}
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
            <code>{display}</code>
            <span aria-hidden="true">
                {state === "copied" ? "✓" : state === "failed" ? "✗" : "⧉"}
            </span>
            {state === "failed" && <span className="address-chip__note">clipboard unavailable</span>}
        </button>
    );
}
