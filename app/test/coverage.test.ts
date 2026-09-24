/**
 * Which chains one press of "Protect all chains with funds" would touch.
 *
 * The cases that matter are the skips. A chain left unprotected because a balance failed to read, or
 * because a stale registration looked close enough to a good one, is a chain whose funds are behind
 * the wrong guardians — and nothing on screen would say so.
 */
import { describe, expect, it } from "vitest";
import { chainsToProtect, staleChains, type CoverageRow } from "../src/integration/recovery/settlement/coverage.js";

function row(over: Partial<CoverageRow> = {}): CoverageRow {
    return {
        chainId: "evm-sepolia",
        chainLabel: "EVM · Sepolia",
        settles: true,
        hasVault: true,
        vaultSpent: false,
        balanceRaw: 1_000n,
        balanceError: null,
        balanceDecimals: 18,
        balanceSymbol: "ETH",
        onchain: { installed: false, matchesVault: false },
        onchainError: null,
        ...over,
    };
}

describe("chains that get protected", () => {
    it("takes a funded chain the gate has not reached", () => {
        const { targets } = chainsToProtect([row()]);
        expect(targets).toHaveLength(1);
        expect(targets[0]!.action).toBe("protect");
    });

    it("takes a stale chain, as an update", () => {
        // It points at the gate you replaced, so the *old* guardians can still recover it.
        const { targets } = chainsToProtect([
            row({ onchain: { installed: true, matchesVault: false } }),
        ]);
        expect(targets[0]!.action).toBe("update");
    });

    it("takes a chain whose balance could not be read, and says the balance is unknown", () => {
        // An unreadable balance is not a zero one. Skipping it would be claiming there is nothing
        // there — which is the thing the read just failed to establish.
        const { targets, skipped } = chainsToProtect([
            row({ balanceRaw: null, balanceError: "RPC timed out" }),
        ]);
        expect(skipped).toEqual([]);
        expect(targets[0]!.balanceUnknown).toBe(true);
    });
});

describe("chains that get skipped, and why", () => {
    it("skips a chain this build cannot settle", () => {
        const { skipped } = chainsToProtect([row({ chainId: "zcash-testnet", settles: false })]);
        expect(skipped[0]!.reason).toBe("no settlement is wired for this chain in this build");
    });

    it("skips an empty chain", () => {
        const { targets, skipped } = chainsToProtect([row({ balanceRaw: 0n })]);
        expect(targets).toEqual([]);
        expect(skipped[0]!.reason).toBe("no funds");
    });

    it("says so when an empty chain is also stale", () => {
        // Nothing to lose today, but the registration is still the old gate's — worth naming rather
        // than filing under "no funds" and leaving.
        const { skipped } = chainsToProtect([
            row({ balanceRaw: 0n, onchain: { installed: true, matchesVault: false } }),
        ]);
        expect(skipped[0]!.reason).toContain("still on the old guardians");
    });

    it("skips a chain that already holds this vault's key", () => {
        const { skipped } = chainsToProtect([
            row({ onchain: { installed: true, matchesVault: true } }),
        ]);
        expect(skipped[0]!.reason).toBe("already protected by this gate");
    });

    it("distinguishes a chain that failed to read from one that was never asked", () => {
        // The bug this pins: a Solana chain the gate had not reached yet returned no state at all,
        // was reported as unreadable, and was skipped — while the wallet card beside it showed a
        // balance. The two cases skip for different reasons and must say so.
        const [failed] = chainsToProtect([
            row({ onchain: null, onchainError: "boom" }),
        ]).skipped;
        const [unasked] = chainsToProtect([row({ onchain: null, onchainError: null })]).skipped;
        expect(failed!.reason).toContain("could not be read");
        expect(unasked!.reason).toBe("not read");
        expect(unasked!.reason).not.toContain("could not be read");
    });

    it("skips an unreadable chain, and names the read failure", () => {
        // The opposite call to an unreadable balance, and deliberately: choosing between installing
        // and replacing needs to know what is installed, and guessing wrong reverts.
        const { targets, skipped } = chainsToProtect([
            row({ onchain: null, onchainError: "429 Too Many Requests" }),
        ]);
        expect(targets).toEqual([]);
        expect(skipped[0]!.reason).toContain("429 Too Many Requests");
        expect(skipped[0]!.reason).toContain("could not be read");
    });

    it("skips a spent vault, which needs a new gate rather than a registration", () => {
        const { skipped } = chainsToProtect([row({ vaultSpent: true })]);
        expect(skipped[0]!.reason).toContain("spent");
    });

    it("skips a wallet with no gate at all", () => {
        const { skipped } = chainsToProtect([row({ hasVault: false })]);
        expect(skipped[0]!.reason).toContain("set up recovery first");
    });
});

describe("a whole wallet at once", () => {
    it("sorts every chain into exactly one list", () => {
        const rows = [
            row({ chainId: "evm-sepolia" }),
            row({ chainId: "solana-devnet", onchain: { installed: true, matchesVault: true } }),
            row({ chainId: "zcash-testnet", settles: false }),
        ];
        const { targets, skipped } = chainsToProtect(rows);
        expect(targets.length + skipped.length).toBe(rows.length);
        expect(targets.map((t) => t.chainId)).toEqual(["evm-sepolia"]);
    });
});

describe("staleChains", () => {
    it("finds the chains still honouring a replaced gate, funded or not", () => {
        const stale = staleChains([
            row({ chainId: "a", onchain: { installed: true, matchesVault: false } }),
            row({ chainId: "b", balanceRaw: 0n, onchain: { installed: true, matchesVault: false } }),
            row({ chainId: "c", onchain: { installed: true, matchesVault: true } }),
            row({ chainId: "d", onchain: null }),
        ]);
        expect(stale.map((r) => r.chainId)).toEqual(["a", "b"]);
    });
});
