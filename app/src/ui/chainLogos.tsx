/**
 * The chains' own marks, so a wallet switcher looks like a wallet switcher.
 *
 * These were generic design-system glyphs — a shield for Ethereum, a key for Solana — which said
 * nothing about which chain a tab was. The design system ships six Heroicons and no chain logos, and
 * it is not going to: brand marks belong to the chains, not to Nihilium.
 *
 * **Drawn in `currentColor`, deliberately.** The wallet tab inverts to a dark fill when selected, so
 * a mark in Ethereum blue or Solana's gradient would either fight that or need a second copy for the
 * inverted state. Inheriting the text colour means one mark works on both, and it keeps this file
 * inside CLAUDE.md's rule against inventing a palette. Ethereum's faces are still distinguishable:
 * the original distinguishes them by opacity rather than by hue, and that survives monochrome.
 *
 * **To replace:** all of it, with your own asset pipeline. Inline SVG is used here so the demo has no
 * image loading, no icon dependency and nothing to 404 — not because inlining is the better habit.
 * **Assumes:** the caller sizes these through `className`; each mark fills its box.
 */

type MarkProps = { className?: string };

/** The octahedron, in its canonical six faces. Opacity carries the geometry, as in the original. */
export function EthereumMark({ className }: MarkProps) {
    return (
        <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M12 1.75v6.9l5.82 2.6z" opacity="0.6" />
            <path d="M12 1.75 6.18 11.25 12 8.65z" />
            <path d="M12 16.42v4.83l5.83-8.06z" opacity="0.6" />
            <path d="M12 21.25v-4.83l-5.82-3.23z" />
            <path d="M12 15.33l5.82-3.43L12 9.31z" opacity="0.2" />
            <path d="M6.18 11.9 12 15.33V9.31z" opacity="0.6" />
        </svg>
    );
}

/**
 * Three slanted bars, at the official proportions.
 *
 * The official artwork is 397.7 x 311.7 — wider than tall — and every slot here is square. The
 * viewBox is squared by shifting its origin up 43 units rather than by scaling: the paths keep the
 * proportions the mark is drawn at, and it sits centred instead of letterboxed against the top.
 */
export function SolanaMark({ className }: MarkProps) {
    return (
        <svg className={className} viewBox="0 -43 397.7 397.7" fill="currentColor" aria-hidden="true">
            <path d="M64.6 237.9c2.4-2.4 5.7-3.8 9.2-3.8h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7c-2.4 2.4-5.7 3.8-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1l62.7-62.7z" />
            <path d="M64.6 3.8C67.1 1.4 70.4 0 73.8 0h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7c-2.4 2.4-5.7 3.8-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1L64.6 3.8z" />
            <path d="M333.1 120.1c-2.4-2.4-5.7-3.8-9.2-3.8H6.5c-5.8 0-8.7 7-4.6 11.1l62.7 62.7c2.4 2.4 5.7 3.8 9.2 3.8h317.4c5.8 0 8.7-7 4.6-11.1l-62.7-62.6z" />
        </svg>
    );
}

/** The Z in its ring, with the ascender and descender the mark is recognised by. */
export function ZcashMark({ className }: MarkProps) {
    return (
        <svg
            className={className}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <circle cx="12" cy="12" r="9.6" />
            <path d="M12 3.2v2.6M12 18.2v2.6" />
            <path d="M8.1 7.7h7.8l-7.8 8.6h7.8" />
        </svg>
    );
}
