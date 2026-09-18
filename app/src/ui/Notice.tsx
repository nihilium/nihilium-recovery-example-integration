/**
 * A neutral or cautionary note.
 *
 * The design system ships exactly one inline feedback pattern, `StatusMessage`, and its tones are
 * success and error — so rather than invent tones on it, anything that is neither lands here,
 * styled from the same `--nih-*` tokens. Keeping it out of `ds.ts` is the point: this is app glue,
 * not a component the design system offers.
 */
export function Notice({
    tone = "neutral",
    children,
}: {
    tone?: "neutral" | "caution";
    children: React.ReactNode;
}) {
    return <div className={`notice notice--${tone}`}>{children}</div>;
}
