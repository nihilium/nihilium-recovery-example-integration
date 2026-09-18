/**
 * A modal, built on `<dialog>` because the design system does not ship one.
 *
 * Sealing and recovering are multi-step, paid, slow operations. Rendered inline they sat on the page
 * permanently, so the page was mostly a form for something you do twice in a wallet's life. They are
 * modals now, and the page behind them is status.
 *
 * `showModal()` is doing real work here rather than being a stylistic choice: it gives the top layer,
 * the inert background, focus containment and ESC without a focus-trap library — which is the kind of
 * dependency CLAUDE.md asks us not to add for one screen.
 *
 * `dismissible` is the load-bearing prop. A ceremony in flight has bought seals or emailed people,
 * and ESC or a stray backdrop click must not look like a way out of it.
 */
import { useEffect, useRef } from "react";
import { Button, Heading } from "./ds.js";

export function Dialog({
    open,
    title,
    onClose,
    dismissible = true,
    footer,
    children,
}: {
    open: boolean;
    title: string;
    onClose: () => void;
    /** False while something paid or human-facing is running. */
    dismissible?: boolean;
    footer?: React.ReactNode;
    children: React.ReactNode;
}) {
    const ref = useRef<HTMLDialogElement>(null);

    useEffect(() => {
        const dialog = ref.current;
        if (dialog === null) return;
        if (open && !dialog.open) dialog.showModal();
        if (!open && dialog.open) dialog.close();
    }, [open]);

    useEffect(() => {
        const dialog = ref.current;
        if (dialog === null) return;
        // `cancel` is ESC. Cancelling it is the only way to keep the browser from closing a dialog
        // whose operation cannot be abandoned halfway.
        const onCancel = (event: Event) => {
            if (!dismissible) event.preventDefault();
        };
        dialog.addEventListener("cancel", onCancel);
        return () => dialog.removeEventListener("cancel", onCancel);
    }, [dismissible]);

    return (
        <dialog
            ref={ref}
            className="dialog nih-root"
            aria-label={title}
            onClose={onClose}
            // A click on the backdrop reports the dialog itself as the target; a click on any child
            // does not. That is the whole backdrop-dismiss implementation.
            onClick={(event) => {
                if (dismissible && event.target === ref.current) onClose();
            }}
        >
            <div className="dialog__panel">
                <div className="dialog__head">
                    <Heading level={3}>{title}</Heading>
                    {dismissible && (
                        <button
                            type="button"
                            className="dialog__close"
                            aria-label="Close"
                            onClick={onClose}
                        >
                            ×
                        </button>
                    )}
                </div>

                <div className="dialog__body">{children}</div>

                {footer !== undefined && <div className="dialog__foot">{footer}</div>}
            </div>
        </dialog>
    );
}

/** The footer's shape everywhere: secondary on the left, the one primary action on the right. */
export function DialogActions({
    back,
    children,
}: {
    back?: { label: string; onClick: () => void; disabled?: boolean };
    children: React.ReactNode;
}) {
    return (
        <>
            <span className="dialog__foot-left">
                {back !== undefined && (
                    <Button variant="ghost" onClick={back.onClick} disabled={back.disabled ?? false}>
                        {back.label}
                    </Button>
                )}
            </span>
            <span className="row">{children}</span>
        </>
    );
}
