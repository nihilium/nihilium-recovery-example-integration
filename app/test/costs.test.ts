/**
 * The arithmetic behind the number next to a button that spends money.
 *
 * Two classes of failure are worth the most here, and neither is about precision. The first is a
 * missing price rendering as a free operation; the second is a real cost rounding to `$0.00`. Both
 * look like good news, which is what makes them worse than being wrong in the other direction.
 */
import { describe, expect, it } from "vitest";
import { estimateCost, type ChainWorkInput } from "../src/integration/costs/estimate.js";
import { formatAge, formatUsd } from "../src/integration/costs/format.js";
import { rescale } from "../src/integration/costs/prices.js";
import { workFor, type WorkStep } from "../src/integration/costs/work.js";
import { NIHILIUM_PROTOCOL_FEE, protocolFeesFor } from "../src/integration/costs/protocol.js";
import type { MainnetPrices } from "../src/integration/costs/prices.js";

/** Round numbers, so every expectation below can be checked by hand. */
const PRICES: MainnetPrices = {
    gasPriceWei: 10_000_000_000n, // 10 gwei
    ethUsdMicros: 2_000_000_000n, // $2,000.00
    solUsdMicros: 100_000_000n, //   $100.00
    asOfSeconds: 1_700_000_000,
};

const CTX = { accountDeployed: true, replacing: true, vaultExists: true };

function evmStep(gas: bigint, over: Partial<WorkStep> = {}): WorkStep {
    return { label: "step", payer: "the relayer", basis: "measured", note: "x", evmGas: gas, ...over };
}

function solStep(lamports: bigint, over: Partial<WorkStep> = {}): WorkStep {
    return { label: "step", payer: "the relayer", basis: "measured", note: "x", lamports, ...over };
}

function chain(chainId: string, steps: WorkStep[] | null): ChainWorkInput {
    return { chainId, chainLabel: chainId, steps };
}

describe("converting chain units to dollars", () => {
    it("prices EVM gas at gas x gasPrice x ETH", () => {
        // 100,000 gas x 10 gwei = 0.001 ETH; at $2,000 that is exactly $2.00.
        const estimate = estimateCost({
            operation: "protect",
            chains: [chain("evm-sepolia", [evmStep(100_000n)])],
            prices: PRICES,
        });
        expect(estimate.totalUsdMicros).toBe(2_000_000n);
        expect(formatUsd(estimate.totalUsdMicros!)).toBe("$2.00");
    });

    it("prices Solana lamports against SOL", () => {
        // 15,000 lamports = 0.000015 SOL; at $100 that is $0.0015 — under a cent, and real.
        const estimate = estimateCost({
            operation: "protect",
            chains: [chain("solana-devnet", [solStep(15_000n)])],
            prices: PRICES,
        });
        expect(estimate.totalUsdMicros).toBe(1_500n);
        expect(formatUsd(estimate.totalUsdMicros!)).toBe("<$0.01");
    });

    it("multiplies before it divides, so a fee never truncates to nothing", () => {
        // The failure this pins: `wei / 10^18` is 0 for every fee this app quotes.
        const estimate = estimateCost({
            operation: "recover",
            chains: [chain("evm-sepolia", [evmStep(21_000n)])],
            prices: PRICES,
        });
        expect(estimate.totalUsdMicros).toBeGreaterThan(0n);
    });
});

describe("a missing price", () => {
    const unpriced = estimateCost({
        operation: "protect",
        chains: [chain("evm-sepolia", [evmStep(268_038n)]), chain("solana-devnet", [solStep(15_000n)])],
        prices: null,
    });

    it("yields a null total, never a zero one", () => {
        expect(unpriced.totalUsdMicros).toBeNull();
        expect(unpriced.depositUsdMicros).toBeNull();
        expect(unpriced.rows.every((row) => row.feeUsdMicros === null)).toBe(true);
    });

    it("still reports the chains' own units, which never needed a price", () => {
        expect(unpriced.rows[0]!.steps[0]!.feeNative).toBe("268038 gas");
        expect(unpriced.rows[1]!.steps[0]!.feeNative).toBe("0.000015 SOL");
    });

    it("attributes nothing to any payer, rather than attributing zero", () => {
        expect(unpriced.byPayer).toEqual([]);
    });
});

describe("what the headline counts", () => {
    it("splits by payer, and the shares sum to the total", () => {
        const estimate = estimateCost({
            operation: "recover",
            chains: [
                chain("evm-sepolia", [
                    evmStep(100_000n, { payer: "the relayer" }),
                    evmStep(50_000n, { payer: "the account" }),
                ]),
            ],
            prices: PRICES,
        });
        const shares = estimate.byPayer.reduce((total, share) => total + share.usdMicros, 0n);
        expect(shares).toBe(estimate.totalUsdMicros);
        expect(estimate.byPayer.map((s) => s.payer)).toEqual(["the relayer", "the account"]);
    });

    it("keeps refundable rent out of the fee total", () => {
        const estimate = estimateCost({
            operation: "protect",
            chains: [chain("solana-devnet", [solStep(10_000n, { rentLamports: 3_459_480n })])],
            prices: PRICES,
        });
        expect(estimate.totalUsdMicros).toBe(1_000n); // the fee alone
        expect(estimate.depositUsdMicros).toBe(345_948n); // the deposit, apart
    });

    it("is assumed as soon as any one step is assumed", () => {
        const estimate = estimateCost({
            operation: "recover",
            chains: [
                chain("evm-sepolia", [
                    evmStep(100_000n, { basis: "measured" }),
                    evmStep(50_000n, { basis: "assumed" }),
                ]),
            ],
            prices: PRICES,
        });
        expect(estimate.basis).toBe("assumed");
    });
});

describe("a chain that sends nothing", () => {
    // Zcash. A chain quietly missing from a breakdown is a breakdown that is wrong without looking
    // wrong, so it renders as a row saying there is no transaction.
    it("produces a row, not an absence", () => {
        const estimate = estimateCost({
            operation: "protect",
            chains: [chain("evm-sepolia", [evmStep(100_000n)]), chain("zcash-testnet", null)],
            prices: PRICES,
        });
        expect(estimate.rows).toHaveLength(2);
        expect(estimate.rows[1]!.transacts).toBe(false);
        expect(estimate.rows[1]!.steps).toEqual([]);
    });
});

describe("formatUsd", () => {
    it("reserves $0.00 for exactly zero", () => {
        expect(formatUsd(0n)).toBe("$0.00");
    });

    it("never rounds a real cost down to free", () => {
        expect(formatUsd(1n)).toBe("<$0.01");
        expect(formatUsd(4_999n)).toBe("<$0.01");
    });

    it("rounds half up at the cent", () => {
        expect(formatUsd(5_000n)).toBe("$0.01");
        expect(formatUsd(1_234_567n)).toBe("$1.23");
        expect(formatUsd(1_235_000n)).toBe("$1.24");
        expect(formatUsd(2_677_738_300n)).toBe("$2677.74");
    });
});

describe("formatAge", () => {
    it("reaches every unit, singular included", () => {
        expect(formatAge(30)).toBe("under a minute");
        expect(formatAge(60)).toBe("1 minute");
        expect(formatAge(600)).toBe("10 minutes");
        expect(formatAge(3_600)).toBe("1 hour");
        // The real SOL/USD case: a ~24h heartbeat means six hours old is normal, and must show.
        expect(formatAge(22_239)).toBe("6 hours");
        expect(formatAge(86_400)).toBe("1 day");
    });
});

describe("rescale", () => {
    it("moves between fixed-point scales in both directions", () => {
        expect(rescale(267_773_830_000n, 8, 6)).toBe(2_677_738_300n);
        expect(rescale(5n, 2, 6)).toBe(50_000n);
        expect(rescale(7n, 6, 6)).toBe(7n);
    });
});

describe("the work table", () => {
    it("has no work for a chain this build does not settle", () => {
        expect(workFor("protect", "zcash-testnet", CTX)).toBeNull();
    });

    it("charges the Safe deployment only on an account that does not exist yet", () => {
        const deployed = workFor("protect", "evm-sepolia", CTX)!;
        const fresh = workFor("protect", "evm-sepolia", { ...CTX, accountDeployed: false })!;
        expect(fresh.length).toBe(deployed.length + 1);
        expect(gasOf(fresh)).toBeGreaterThan(gasOf(deployed));
    });

    it("charges create_vault and its rent only where the vault is missing", () => {
        const existing = workFor("protect", "solana-devnet", CTX)!;
        const fresh = workFor("protect", "solana-devnet", { ...CTX, vaultExists: false })!;
        expect(existing.some((s) => s.rentLamports !== undefined)).toBe(false);
        expect(fresh.some((s) => s.rentLamports !== undefined)).toBe(true);
    });

    it("cites a transaction for every step it calls measured", () => {
        const all = (["protect", "recover", "move-funds"] as const).flatMap((op) => [
            ...(workFor(op, "evm-sepolia", { ...CTX, accountDeployed: false, vaultExists: false }) ?? []),
            ...(workFor(op, "solana-devnet", { ...CTX, accountDeployed: false, vaultExists: false }) ?? []),
        ]);
        for (const step of all.filter((s) => s.basis === "measured")) {
            // Not a formality: `measured` is the only claim in this directory that cannot be
            // re-derived from the code, so it has to point at something outside it.
            expect(step.note).toMatch(/tx 0x|devnet/);
        }
        expect(all.filter((s) => s.basis === "measured").length).toBeGreaterThan(0);
    });
});

function gasOf(steps: readonly WorkStep[]): bigint {
    return steps.reduce((total, step) => total + (step.evmGas ?? 0n), 0n);
}

describe("the protocol fee", () => {
    const fees = protocolFeesFor("protect");

    it("is charged on protect only", () => {
        expect(fees).toEqual([NIHILIUM_PROTOCOL_FEE]);
        expect(protocolFeesFor("recover")).toEqual([]);
        expect(protocolFeesFor("move-funds")).toEqual([]);
    });

    it("is $1 for a year, once per vault however many chains it covers", () => {
        const estimate = estimateCost({
            operation: "protect",
            chains: [chain("evm-sepolia", [evmStep(100_000n)]), chain("solana-devnet", [solStep(15_000n)])],
            prices: PRICES,
            protocolFees: fees,
        });
        expect(estimate.protocolUsdMicros).toBe(1_000_000n);
        // $2.00 of gas, $0.0015 of Solana fee, $1.00 of protocol fee.
        expect(estimate.totalUsdMicros).toBe(2_000_000n + 1_500n + 1_000_000n);
        expect(NIHILIUM_PROTOCOL_FEE.term).toBe("1 year of protection");
    });

    it("is paid by you, and counted in your share", () => {
        const estimate = estimateCost({
            operation: "protect",
            chains: [chain("evm-sepolia", [evmStep(100_000n, { payer: "the account" })])],
            prices: PRICES,
            protocolFees: fees,
        });
        expect(estimate.byPayer.find((share) => share.payer === "you")?.usdMicros).toBe(1_000_000n);
    });

    it("is still stated when the gas cannot be priced", () => {
        const estimate = estimateCost({
            operation: "protect",
            chains: [chain("evm-sepolia", [evmStep(100_000n)])],
            prices: null,
            protocolFees: fees,
        });
        // The total stays unknown — the gas is — but the fee is not.
        expect(estimate.totalUsdMicros).toBeNull();
        expect(estimate.protocolUsdMicros).toBe(1_000_000n);
    });
});
