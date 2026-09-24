/**
 * USD, from micro-dollars, without ever touching a float.
 *
 * The same argument as `chains/amounts.ts`: a `Number()` on the way in is wrong by an amount nobody
 * notices, and this number sits next to a button that spends money. Everything upstream is a bigint;
 * this is the only place it becomes text.
 *
 * **To replace:** the currency and the locale. This formats US cents with a leading `$` and no
 * grouping, matching the rest of the app — `formatAmount` has no thousands separators either.
 * **Assumes:** micro-dollars, six decimals, as produced by `estimate.ts`. A value at a different
 * scale formats silently wrong, which is why the unit is in every field name that carries one.
 */

/**
 * Rounds half-up to cents, with one exception that matters.
 *
 * A fee under half a cent renders `<$0.01`, never `$0.00`. Rounding a real cost to zero is the same
 * class of mistake as rendering an unreadable balance as an empty one: it reports "this is free",
 * which is the one answer a reader would act on without checking. `$0.00` is reserved for exactly
 * zero — which on these chains is a real outcome, since a relayer-paid step can round to nothing.
 */
export function formatUsd(micros: bigint): string {
    if (micros === 0n) return "$0.00";

    const negative = micros < 0n;
    const value = negative ? -micros : micros;
    // Half-up at cent resolution: 1_000_000 micros is a dollar, so a cent is 10_000.
    const cents = (value + 5_000n) / 10_000n;
    if (cents === 0n) return negative ? ">-$0.01" : "<$0.01";

    const whole = cents / 100n;
    const fraction = (cents % 100n).toString().padStart(2, "0");
    return `${negative ? "-" : ""}$${whole}.${fraction}`;
}

/** "4 minutes", "6 hours" — the age of a price, in the register `approximate()` already uses. */
export function formatAge(seconds: number): string {
    if (seconds < 60) return "under a minute";
    if (seconds < 3600) {
        const minutes = Math.floor(seconds / 60);
        return `${minutes} minute${minutes === 1 ? "" : "s"}`;
    }
    if (seconds < 86_400) {
        const hours = Math.floor(seconds / 3600);
        return `${hours} hour${hours === 1 ? "" : "s"}`;
    }
    const days = Math.floor(seconds / 86_400);
    return `${days} day${days === 1 ? "" : "s"}`;
}
