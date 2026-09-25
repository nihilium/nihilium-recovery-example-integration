/**
 * The check a recovery runs before its ceremony, and the rule for when it may start.
 *
 * A recovery that the chain will refuse still spends the vault, so the rule matters in both
 * directions: refuse too little and a user pays and waits for nothing — which is exactly what
 * happened once, against a Safe that never had the module installed — and refuse too much and a
 * vault with one unprotected chain can no longer hand over the chains that are fine.
 */
import { describe, expect, it } from "vitest";
import {
    canHandOverAny,
    checkHandovers,
    describeBlocked,
} from "../src/integration/recovery/handover/preflight.js";
import type { ChainHandover, HandoverProblem } from "../src/integration/recovery/handover/types.js";

const NOT_INSTALLED: HandoverProblem = {
    code: "not-installed",
    blocking: true,
    message: "This account has no recovery module installed.",
};

/** A handover whose only working method is `preflight`. */
function handover(preflight: () => Promise<HandoverProblem[]>): ChainHandover {
    const never = () => Promise.reject(new Error("not part of a preflight"));
    return { preflight, initiate: never, execute: never, sweep: never, abort: never };
}

const chain = (chainId: string) => ({ chainId, accountId: `${chainId}-account`, recoveryPubKeyHex: "02ab" });

async function readiness(byChain: Record<string, ChainHandover | null>) {
    return checkHandovers(
        { handoverFor: (chainId) => byChain[chainId] ?? null },
        Object.keys(byChain).map(chain),
    );
}

describe("the pre-ceremony handover check", () => {
    it("refuses a vault none of whose chains would accept a recovery", async () => {
        const rows = await readiness({
            "evm-sepolia": handover(async () => [NOT_INSTALLED]),
            "zcash-testnet": null,
        });
        expect(rows.map((row) => row.status)).toEqual(["blocked", "unsupported"]);
        expect(canHandOverAny(rows)).toBe(false);
        expect(describeBlocked(rows)).toEqual([
            "evm-sepolia: This account has no recovery module installed.",
            "zcash-testnet: no on-chain handover in this build",
        ]);
    });

    it("lets a vault through when one chain is ready, and names the one that is not", async () => {
        const rows = await readiness({
            "evm-sepolia": handover(async () => []),
            "solana-devnet": handover(async () => [NOT_INSTALLED]),
        });
        expect(rows.map((row) => row.status)).toEqual(["ready", "blocked"]);
        expect(canHandOverAny(rows)).toBe(true);
        expect(describeBlocked(rows)).toHaveLength(1);
    });

    it("reads an unreachable chain as unknown — never ready, and never a reason to refuse", async () => {
        const rows = await readiness({
            "evm-sepolia": handover(async () => {
                throw new Error("RPC timeout");
            }),
        });
        expect(rows[0]).toMatchObject({ status: "unchecked", error: "RPC timeout" });
        expect(canHandOverAny(rows)).toBe(true);
        expect(describeBlocked(rows)).toEqual([]);
    });

    it("does not treat a warning as a refusal", async () => {
        const rows = await readiness({
            "evm-sepolia": handover(async () => [{ ...NOT_INSTALLED, code: "relayer-low", blocking: false }]),
        });
        expect(rows[0]!.status).toBe("ready");
    });
});
