/**
 * Nihilium's own fee, alongside the gas.
 *
 * Denominated in USD, not in a chain's token, so unlike every gas line it needs no price feed and
 * is known even when the mainnet price read fails. Charged once per vault for a protection period,
 * not once per chain: the vault is one gate over every chain it covers.
 *
 * **Not charged by this demo.** Nothing here collects it; it is priced so the estimate beside
 * "Protect all chains" shows what protection costs in full, and the breakdown says so.
 *
 * **To replace:** the amount and the term, from wherever your deployment's pricing actually lives —
 * and the collection, which this repo does not implement.
 * **Assumes:** one fee per protect operation, whatever number of chains it covers.
 */
import type { CostOperation, Payer } from "./work.js";

export interface ProtocolFee {
    label: string;
    /** What the fee buys, shown beside it: "1 year of protection". */
    term: string;
    payer: Payer;
    /** Micro-dollars, like every USD amount in this directory. */
    usdMicros: bigint;
}

export const NIHILIUM_PROTOCOL_FEE: ProtocolFee = {
    label: "Nihilium protocol fee",
    term: "1 year of protection",
    payer: "you",
    usdMicros: 1_000_000n,
};

/** Protection carries the fee. Recovering and moving funds do not. */
export function protocolFeesFor(operation: CostOperation): readonly ProtocolFee[] {
    return operation === "protect" ? [NIHILIUM_PROTOCOL_FEE] : [];
}
