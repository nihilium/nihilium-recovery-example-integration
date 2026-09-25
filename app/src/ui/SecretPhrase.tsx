/**
 * A seed phrase that is hidden until asked for.
 *
 * The demo prints its seed on purpose — the point is to lose it convincingly, not to guard it — but
 * a phrase permanently readable on screen ends up in every screenshot and screen share of the demo.
 * So it is blurred by default, one click shows it, and copying works either way.
 */
import { useState } from "react";
import { AddressChip } from "./AddressChip.js";

export function SecretPhrase({ phrase }: { phrase: string }) {
    const [shown, setShown] = useState(false);
    return (
        <span className="secret-phrase">
            <AddressChip value={phrase} display={phrase} concealed={!shown} />
            <button
                type="button"
                className="linkish"
                aria-pressed={shown}
                onClick={() => setShown((value) => !value)}
            >
                {shown ? "Hide" : "Show"}
            </button>
        </span>
    );
}
