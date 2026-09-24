/**
 * A small panel on hover and on keyboard focus, in the browser's top layer.
 *
 * The design system ships a tooltip, but only inside `TopBar` and only for a nowrap one-liner, so
 * this borrows its look — solid ink, `--nih-shadow-popover` — and none of its constraints. Every
 * other tooltip in this app is a bare `title=` attribute, which is right for a sentence and wrong
 * here: a fee breakdown is a small table, and `title` renders a table as one unstyled blob that no
 * keyboard ever reaches.
 *
 * **Why `popover` rather than a z-index.** This opens inside a modal `<dialog>` whose body scrolls,
 * and an `overflow` ancestor clips an absolutely-positioned descendant however high its `z-index` —
 * so the panel was cut off at the scroll edge, which looked like it was hiding behind the dialog
 * header. `position: fixed` does not fix it either: the design system's `Card` sets `backdrop-filter`,
 * which makes it the containing block for fixed descendants. The top layer sidesteps both, and a
 * popover opened after a modal dialog renders above it.
 *
 * **Focus as well as hover**, because the trigger is a real `<button>` and the content is the only
 * place some of these numbers appear. `aria-describedby` rather than `aria-label`: the summary on
 * screen is the name, and this is the description of it.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

/** Clear of the trigger, and of the viewport edge when the panel is clamped against it. */
const GAP = 8;

export function Tooltip({
    label,
    children,
    panel,
}: {
    /** What the trigger announces to a screen reader. The visible summary is usually not enough. */
    label: string;
    /** The trigger — rendered inside the button. */
    children: ReactNode;
    panel: ReactNode;
}) {
    const [open, setOpen] = useState(false);
    const id = useId();
    const trigger = useRef<HTMLButtonElement>(null);
    const surface = useRef<HTMLSpanElement>(null);

    useEffect(() => {
        if (!open) return;
        const onKey = (event: KeyboardEvent) => {
            if (event.key === "Escape") setOpen(false);
        };
        // A tooltip that cannot be dismissed without moving the pointer is a tooltip covering the
        // thing you were reading.
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [open]);

    // Layout, not effect: the panel is measured and placed before the browser paints it, so it never
    // appears at the top-left corner for a frame on its way to the trigger.
    useLayoutEffect(() => {
        const element = surface.current;
        const anchor = trigger.current;
        if (!open || element === null || anchor === null) return;

        // Feature-detected rather than assumed. Without it the panel still renders and is still
        // positioned — it is only the clipping escape that is missing, which is a worse tooltip
        // rather than no tooltip.
        const hasPopover = typeof element.showPopover === "function";
        if (hasPopover) {
            try {
                element.showPopover();
            } catch {
                // Already open, or the element left the document between render and here.
            }
        }

        const place = () => {
            const from = anchor.getBoundingClientRect();
            const box = element.getBoundingClientRect();
            // Above by preference, below when there is no room — a panel opening off the top of the
            // viewport is a panel nobody reads.
            const above = from.top - box.height - GAP;
            element.style.top = `${above >= GAP ? above : from.bottom + GAP}px`;
            const centred = from.left + from.width / 2 - box.width / 2;
            const limit = window.innerWidth - box.width - GAP;
            element.style.left = `${Math.max(GAP, Math.min(centred, limit))}px`;
        };

        place();
        // Capture, so a scroll inside the dialog body moves it too and not only a window scroll.
        window.addEventListener("scroll", place, true);
        window.addEventListener("resize", place);
        return () => {
            window.removeEventListener("scroll", place, true);
            window.removeEventListener("resize", place);
            if (hasPopover) {
                try {
                    element.hidePopover();
                } catch {
                    // Already closed. Nothing to undo.
                }
            }
        };
    }, [open]);

    return (
        <span
            className="tip"
            onMouseEnter={() => setOpen(true)}
            onMouseLeave={() => setOpen(false)}
        >
            <button
                type="button"
                ref={trigger}
                className="tip__trigger"
                aria-describedby={open ? id : undefined}
                aria-expanded={open}
                aria-label={label}
                onFocus={() => setOpen(true)}
                onBlur={() => setOpen(false)}
                // Tap opens it: on a touch screen there is no hover and no focus ring to rely on.
                onClick={() => setOpen((was) => !was)}
            >
                {children}
            </button>
            {open && (
                <span
                    className="tip__panel"
                    ref={surface}
                    id={id}
                    role="tooltip"
                    // Manual, not auto: light dismiss would close it on the first click inside, and
                    // hover, blur and Escape already cover every way out of it.
                    popover="manual"
                >
                    {panel}
                </span>
            )}
        </span>
    );
}
