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
    delay = 0,
    as = "button",
}: {
    /** What the trigger announces to a screen reader. The visible summary is usually not enough. */
    label: string;
    /** The trigger — rendered inside the button, unless `as="div"`. */
    children: ReactNode;
    panel: ReactNode;
    /**
     * Milliseconds the pointer must hold before the panel opens. Zero by default; a status line on a
     * disabled control wants a hold, because a tooltip that fires on the way past is a flicker.
     */
    delay?: number;
    /**
     * `"button"` (default) renders the trigger button this component owns. `"div"` is for a caller
     * that already renders its own control — a disabled tab, say — where a second button would nest
     * invalidly; the wrapper carries the handlers instead, and the caller's control carries the name.
     */
    as?: "button" | "div";
}) {
    const [open, setOpen] = useState(false);
    const id = useId();
    // The element the panel anchors to. The button branch never needs it — the wrapper span is the
    // same box as its button — but `as="div"` uses `display: contents`, which has no box of its own,
    // so the caller's control is named as the anchor instead.
    const anchor = useRef<HTMLSpanElement>(null);
    const surface = useRef<HTMLSpanElement>(null);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const cancel = () => {
        if (timer.current !== null) {
            clearTimeout(timer.current);
            timer.current = null;
        }
    };
    const schedule = () => {
        cancel();
        if (delay <= 0) {
            setOpen(true);
            return;
        }
        timer.current = setTimeout(() => {
            timer.current = null;
            setOpen(true);
        }, delay);
    };
    // The wrapper span is the anchor and carries the handlers: `as="div"` gives its child
    // `display: contents`, which has no box to measure, and a disabled control fires no pointer
    // events of its own — which is exactly why the wrapper, not the control, must own them.
    useEffect(() => cancel, []);

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
        const from = anchor.current ?? undefined;
        if (!open || element === null || from === undefined) return;
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
            const box = element.getBoundingClientRect();
            const at = from.getBoundingClientRect();
            // Above by preference, below when there is no room — a panel opening off the top of the
            // viewport is a panel nobody reads.
            const above = at.top - box.height - GAP;
            element.style.top = `${above >= GAP ? above : at.bottom + GAP}px`;
            const centred = at.left + at.width / 2 - box.width / 2;
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
            ref={anchor}
            onMouseEnter={schedule}
            onMouseLeave={() => {
                cancel();
                setOpen(false);
            }}
        >
            {as === "div" ? (
                <div className="tip__trigger tip__trigger--plain" aria-describedby={open ? id : undefined}>
                    {children}
                </div>
            ) : (
                <button
                    type="button"
                    className="tip__trigger"
                    aria-describedby={open ? id : undefined}
                    aria-expanded={open}
                    aria-label={label}
                    onFocus={schedule}
                    onBlur={() => {
                        cancel();
                        setOpen(false);
                    }}
                    // Tap opens it: on a touch screen there is no hover and no focus ring to rely on.
                    onClick={() => setOpen((was) => !was)}
                >
                    {children}
                </button>
            )}
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
