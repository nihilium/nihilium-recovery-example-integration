/**
 * A text field the browser should not fill or remember: guardian addresses, names, a birth date.
 *
 * On a shared screen, an autofill dropdown under a guardian field lists every address typed into
 * this browser before, which is the guardian set of every earlier demo. The design system's
 * `TextInput` does not forward `autoComplete`, so this renders the same `nih-input` itself and
 * stacks the three things Chrome honours:
 *
 * - `autocomplete="off"`, which stops the history dropdown;
 * - `type="text"` with an email keyboard instead of `type="email"`, because Chrome treats an email
 *   type as a contact field to fill from the profile whatever `autocomplete` says;
 * - a `name` unique to this mount, so there is no history stored under it to suggest.
 *
 * The `data-*` flags ask 1Password and LastPass to stay out too.
 */
import { useState, type ChangeEventHandler } from "react";

export function PrivateInput({
    kind,
    value,
    onChange,
    placeholder,
    ariaLabel,
}: {
    kind: "email" | "text";
    value: string;
    onChange: ChangeEventHandler<HTMLInputElement>;
    placeholder?: string;
    ariaLabel?: string;
}) {
    const [name] = useState(() => `f-${crypto.randomUUID()}`);
    return (
        <input
            className="nih-input"
            type="text"
            inputMode={kind === "email" ? "email" : "text"}
            name={name}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            data-1p-ignore=""
            data-lpignore="true"
            value={value}
            onChange={onChange}
            placeholder={placeholder}
            aria-label={ariaLabel}
        />
    );
}
