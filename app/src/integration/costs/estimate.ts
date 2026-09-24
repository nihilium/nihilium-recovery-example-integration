/**
 * Chain work plus mainnet prices, added up.
 *
 * Pure arithmetic over bigints, so it is the part that can be tested without a network. The two
 * halves it joins are deliberately from different places — units measured on Sepolia and devnet
 * (`work.ts`), priced at Ethereum mainnet rates (`prices.ts`) — because a fee quoted from the
 * testnets this demo runs on would be a number near zero.
 *
 * **Missing prices produce `null`, never `0`.** This is the screen that says what an operation
 * costs; a failed price read rendering as a free operation is the one wrong answer that reads as
 * good news, and it is the same rule `useBalances` follows for an unreadable balance. Native amounts
 * survive a price failure, because they never needed a price.
 *
 * **Rent is not a fee.** Solana's `create_vault` deposits rent-exemption for the account it
 * allocates, and that deposit comes back when the account closes. It is totalled separately so the
 * headline is money actually spent, and the breakdown says "refundable" where it appears.
 *
 * **To replace:** nothing, if your chains are these two. Add a branch per new chain's unit — the
 * shape is one multiply and one rescale.
 * **Assumes:** `prices` and `work` describe the same instant. They are read together and neither is
 * cached beyond a session; a stale price is reported by age rather than refused, because Chainlink's
 * SOL/USD feed legitimately answers on a ~24h heartbeat.
 */
import { formatAmount } from "../chains/amounts.js";
import { USD_DECIMALS, type MainnetPrices } from "./prices.js";
import type { Basis, CostOperation, Payer, WorkStep } from "./work.js";
import type { ProtocolFee } from "./protocol.js";

const WEI_DECIMALS = 18;
const LAMPORT_DECIMALS = 9;

export interface ChainWorkInput {
    chainId: string;
    chainLabel: string;
    /** `null` where this chain performs no transaction for this operation. */
    steps: readonly WorkStep[] | null;
    /** Why this chain's state could not be read. Reported; never treated as "nothing to do". */
    unreadable?: string | null;
}

export interface StepCost {
    label: string;
    payer: Payer;
    basis: Basis;
    note: string;
    /** `null` when there is no price to apply. */
    feeUsdMicros: bigint | null;
    depositUsdMicros: bigint | null;
    /** The chain's own units — "0.000268 ETH", "0.015 SOL" — which need no price. */
    feeNative: string;
    depositNative: string | null;
}

export interface ChainCost {
    chainId: string;
    chainLabel: string;
    steps: readonly StepCost[];
    /** `null` when unpriced, or when this chain transacts at all. Zero only if it truly costs zero. */
    feeUsdMicros: bigint | null;
    depositUsdMicros: bigint | null;
    /** False where this build sends nothing on this chain — a row that still renders. */
    transacts: boolean;
    unreadable: string | null;
}

export interface PayerShare {
    payer: Payer;
    usdMicros: bigint;
}

export interface CostEstimate {
    operation: CostOperation;
    rows: readonly ChainCost[];
    /** `null` when prices were unavailable. Never a zero standing in for "unknown". */
    totalUsdMicros: bigint | null;
    /** Refundable deposits, kept out of the total above. */
    depositUsdMicros: bigint | null;
    /** Non-zero shares only, largest first, so "you pay nothing of this" is visible by absence. */
    byPayer: readonly PayerShare[];
    /** The weakest basis of everything added up. One assumption makes the whole figure assumed. */
    basis: Basis;
    /** Unix seconds of the oldest price input, so the UI can say how old the figure is. */
    asOfSeconds: number | null;
    /**
     * Fixed USD fees on top of the gas — Nihilium's protocol fee on protect. Known without a price
     * feed, so present (and in `byPayer`) even when `totalUsdMicros` is null.
     */
    protocolFees: readonly ProtocolFee[];
    protocolUsdMicros: bigint;
}

export function estimateCost(params: {
    operation: CostOperation;
    chains: readonly ChainWorkInput[];
    prices: MainnetPrices | null;
    /** Fixed USD fees for this operation. See `protocol.ts`. */
    protocolFees?: readonly ProtocolFee[];
}): CostEstimate {
    const { prices } = params;
    const protocolFees = params.protocolFees ?? [];
    const protocolUsdMicros = protocolFees.reduce((total, fee) => total + fee.usdMicros, 0n);
    const rows = params.chains.map((chain) => chainCost(chain, prices));

    const priced = prices !== null;
    const totals = rows.flatMap((row) => row.steps);
    const byPayer = new Map<Payer, bigint>();
    for (const step of totals) {
        if (step.feeUsdMicros === null) continue;
        byPayer.set(step.payer, (byPayer.get(step.payer) ?? 0n) + step.feeUsdMicros);
    }
    for (const fee of protocolFees) {
        byPayer.set(fee.payer, (byPayer.get(fee.payer) ?? 0n) + fee.usdMicros);
    }

    return {
        operation: params.operation,
        rows,
        // Gas plus the protocol fee. Still null without prices: a total that silently dropped the gas
        // would be the protocol fee passing itself off as the whole cost.
        totalUsdMicros: priced ? sum(totals.map((s) => s.feeUsdMicros)) + protocolUsdMicros : null,
        depositUsdMicros: priced ? sum(totals.map((s) => s.depositUsdMicros)) : null,
        byPayer: [...byPayer.entries()]
            .filter(([, usdMicros]) => usdMicros > 0n)
            .map(([payer, usdMicros]) => ({ payer, usdMicros }))
            .sort((a, b) => (b.usdMicros > a.usdMicros ? 1 : -1)),
        // One assumption anywhere makes the whole figure an assumption. Taking the majority basis, or
        // the basis of the largest row, would let a measured headline rest on a guessed component.
        basis: totals.some((step) => step.basis === "assumed") ? "assumed" : "measured",
        asOfSeconds: prices?.asOfSeconds ?? null,
        protocolFees,
        protocolUsdMicros,
    };
}

function chainCost(chain: ChainWorkInput, prices: MainnetPrices | null): ChainCost {
    if (chain.steps === null || chain.steps.length === 0) {
        return {
            chainId: chain.chainId,
            chainLabel: chain.chainLabel,
            steps: [],
            feeUsdMicros: prices === null ? null : 0n,
            depositUsdMicros: prices === null ? null : 0n,
            transacts: false,
            unreadable: chain.unreadable ?? null,
        };
    }

    const steps = chain.steps.map((step) => stepCost(step, prices));
    return {
        chainId: chain.chainId,
        chainLabel: chain.chainLabel,
        steps,
        feeUsdMicros: prices === null ? null : sum(steps.map((s) => s.feeUsdMicros)),
        depositUsdMicros: prices === null ? null : sum(steps.map((s) => s.depositUsdMicros)),
        transacts: true,
        unreadable: chain.unreadable ?? null,
    };
}

function stepCost(step: WorkStep, prices: MainnetPrices | null): StepCost {
    const base = {
        label: step.label,
        payer: step.payer,
        basis: step.basis,
        note: step.note,
    };

    if (step.evmGas !== undefined) {
        const wei = prices === null ? null : step.evmGas * prices.gasPriceWei;
        return {
            ...base,
            feeUsdMicros: wei === null ? null : usdOf(wei, WEI_DECIMALS, prices!.ethUsdMicros),
            depositUsdMicros: null,
            // The gas units themselves when there is no price: a reader can still see that one step
            // is twenty times another, which is most of what the breakdown is for.
            feeNative: wei === null ? `${step.evmGas} gas` : `${formatAmount(wei, WEI_DECIMALS)} ETH`,
            depositNative: null,
        };
    }

    const lamports = step.lamports ?? 0n;
    const rent = step.rentLamports ?? 0n;
    return {
        ...base,
        feeUsdMicros: prices === null ? null : usdOf(lamports, LAMPORT_DECIMALS, prices.solUsdMicros),
        depositUsdMicros:
            prices === null || rent === 0n
                ? null
                : usdOf(rent, LAMPORT_DECIMALS, prices.solUsdMicros),
        feeNative: `${formatAmount(lamports, LAMPORT_DECIMALS)} SOL`,
        depositNative: rent === 0n ? null : `${formatAmount(rent, LAMPORT_DECIMALS)} SOL`,
    };
}

/**
 * Base units times a price, to micro-dollars.
 *
 * Multiply before divide, always: `wei / 10^18` is zero for every fee this app ever quotes, so the
 * order here is the difference between a number and nothing.
 */
function usdOf(amount: bigint, decimals: number, usdMicrosPerUnit: bigint): bigint {
    return (amount * usdMicrosPerUnit) / 10n ** BigInt(decimals);
}

function sum(values: readonly (bigint | null)[]): bigint {
    return values.reduce<bigint>((total, value) => total + (value ?? 0n), 0n);
}

export { USD_DECIMALS };
