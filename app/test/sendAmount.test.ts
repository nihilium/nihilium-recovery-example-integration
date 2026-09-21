/**
 * Amount parsing, which is where a send form quietly loses money.
 *
 * `0.1` is not representable as a double, so anything that reaches `Number` on the way to wei is
 * wrong by an amount nobody notices until it is on-chain. These go string -> bigint and never touch
 * a float, and the tests below are the ones that would fail if someone "simplified" that.
 */
import { describe, expect, it } from "vitest";
import { formatAmount, parseAmount, subtractReserve } from "../src/integration/chains/amounts.js";

describe("parseAmount", () => {
    it("reads whole and fractional values at full precision", () => {
        expect(parseAmount("1", 18)).toBe(10n ** 18n);
        expect(parseAmount("0.1", 18)).toBe(100_000_000_000_000_000n);
        // The case a float gets wrong: 0.1 + 0.2 style drift, and a value below a double's ulp.
        expect(parseAmount("0.000000000000000001", 18)).toBe(1n);
        expect(parseAmount("1234.000000000000000001", 18)).toBe(1_234_000_000_000_000_000_001n);
    });

    it("accepts the shapes a keyboard produces", () => {
        expect(parseAmount("  0.5  ", 18)).toBe(500_000_000_000_000_000n);
        expect(parseAmount("0.", 18)).toBe(0n);
        expect(parseAmount(".5", 18)).toBe(500_000_000_000_000_000n);
    });

    it("refuses more precision than the chain has", () => {
        // Silently truncating would send a different amount than the one on screen.
        expect(parseAmount("0.0000000000000000001", 18)).toBeNull();
        expect(parseAmount("1.0000000001", 9)).toBeNull();
    });

    it("refuses anything that is not a plain decimal", () => {
        for (const bad of ["", ".", "abc", "1e18", "-1", "1,5", "0x10", "1.2.3"]) {
            expect(parseAmount(bad, 18), bad).toBeNull();
        }
    });

    it("works at other decimals, because not every chain is 18", () => {
        // Solana is 9. A form hardcoding 18 would send a billionth of the intended amount.
        expect(parseAmount("1.5", 9)).toBe(1_500_000_000n);
        expect(parseAmount("2", 8)).toBe(200_000_000n);
    });
});

describe("subtractReserve", () => {
    it("never returns a negative sendable amount", () => {
        expect(subtractReserve(10n, 3n)).toBe(7n);
        // A balance below the reserve means nothing is sendable, not a negative Max button.
        expect(subtractReserve(2n, 3n)).toBe(0n);
        expect(subtractReserve(0n, 3n)).toBe(0n);
    });
});

describe("formatAmount", () => {
    it("round-trips through parseAmount", () => {
        for (const value of ["1", "0.1", "1234.5678", "0.000000000000000001"]) {
            expect(formatAmount(parseAmount(value, 18)!, 18)).toBe(value);
        }
    });

    it("trims trailing zeros but keeps significant ones", () => {
        expect(formatAmount(10n ** 18n, 18)).toBe("1");
        expect(formatAmount(1_500_000_000_000_000_000n, 18)).toBe("1.5");
        expect(formatAmount(1_000_000_000_000_000_001n, 18)).toBe("1.000000000000000001");
        expect(formatAmount(0n, 18)).toBe("0");
    });
});
