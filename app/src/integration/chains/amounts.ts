/**
 * Decimal strings to base units and back, without ever touching a float.
 *
 * `0.1` is not representable as a double, and neither is any amount a user is likely to type. A
 * single `Number()` on the way to wei is wrong by an amount nobody notices until it is on-chain and
 * irreversible, so everything here goes `string -> bigint` and stays there. `Balance.raw` is a
 * `bigint` for the same reason.
 *
 * Decimals are a parameter rather than a constant: 18 on Ethereum, 9 on Solana, 8 on Zcash. A
 * formatter that assumed 18 would show a Solana balance as a billionth of itself.
 *
 * **To replace:** nothing; this is arithmetic. Use your chain library's helpers if it has them, but
 * check they are bigint-based — several popular ones are not.
 * **Assumes:** `decimals` is the chain's own, taken from the same `Balance` the amount came from.
 */

/** `null` for anything that is not a plain decimal, rather than a silently truncated value. */
export function parseAmount(input: string, decimals: number): bigint | null {
    const trimmed = input.trim();
    if (!/^\d*\.?\d*$/.test(trimmed) || trimmed === "" || trimmed === ".") return null;
    const [whole = "0", fraction = ""] = trimmed.split(".");
    // Refused, never rounded: sending a different amount than the one on screen is the one outcome
    // worth failing loudly over.
    if (fraction.length > decimals) return null;
    return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
}

export function formatAmount(raw: bigint, decimals: number): string {
    const whole = raw / 10n ** BigInt(decimals);
    const fraction = (raw % 10n ** BigInt(decimals)).toString().padStart(decimals, "0");
    const trimmed = fraction.replace(/0+$/, "");
    return trimmed === "" ? `${whole}` : `${whole}.${trimmed}`;
}

/** Never below zero: a reserve larger than the balance means nothing is sendable, not a negative. */
export function subtractReserve(balance: bigint, reserve: bigint): bigint {
    const left = balance - reserve;
    return left > 0n ? left : 0n;
}
