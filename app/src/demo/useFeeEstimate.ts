/**
 * Mainnet prices, read once, and the estimates built from them.
 *
 * Cached at module scope rather than per component: three surfaces show a fee, and a price read per
 * mount would be eight RPC calls every time a dialog opens. The TTL is short enough that a figure on
 * screen is never surprising and long enough that reopening a dialog is free.
 *
 * A failed read is kept as a value, not thrown. The app is entirely usable without a price — it
 * shows fees in ETH and SOL instead — so a dead mainnet RPC must not take a dialog with it.
 */
import { useCallback, useEffect, useState } from "react";
import { createPublicClient, http, type PublicClient } from "viem";
import { arbitrum, mainnet } from "viem/chains";
import { estimateCost, type CostEstimate } from "../integration/costs/estimate.js";
import { readMainnetPrices, type MainnetPrices } from "../integration/costs/prices.js";
import { workFor, type CostOperation, type WorkContext } from "../integration/costs/work.js";
import { protocolFeesFor } from "../integration/costs/protocol.js";
import type { AppBindings } from "./bindings.js";

/** Long enough that reopening a dialog costs nothing, short enough that gas moves are visible. */
const TTL_MS = 120_000;

let cached: { prices: MainnetPrices; at: number } | null = null;
let inFlight: Promise<MainnetPrices> | null = null;

async function loadPrices(rpc: { ethereum: string; arbitrum: string }): Promise<MainnetPrices> {
    if (cached !== null && Date.now() - cached.at < TTL_MS) return cached.prices;
    // Shared, so two dialogs opening together make one round of calls rather than two.
    inFlight ??= (async () => {
        const ethereum = createPublicClient({ chain: mainnet, transport: http(rpc.ethereum) }) as PublicClient;
        const arbitrumClient = createPublicClient({
            chain: arbitrum,
            transport: http(rpc.arbitrum),
        }) as PublicClient;
        try {
            const prices = await readMainnetPrices({ ethereum, arbitrum: arbitrumClient });
            cached = { prices, at: Date.now() };
            return prices;
        } finally {
            inFlight = null;
        }
    })();
    return inFlight;
}

export interface FeeEstimator {
    /** `null` while loading and after a failure. Never a stand-in zero. */
    prices: MainnetPrices | null;
    error: string | null;
    loading: boolean;
    /**
     * Unix seconds at which these prices were read, for rendering their age.
     *
     * Recorded rather than measured against `Date.now()` at render time: a component calling the
     * clock while rendering is impure, and with a two-minute cache the difference is smaller than
     * the units the age is ever shown in.
     */
    readAtSeconds: number;
    /**
     * Every chain in the registry by default, so a chain that sends nothing still appears as a
     * row. `chainIds` narrows it to the chains an operation actually touches — a handover over one
     * chain must not be quoted for two.
     *
     * `ctx` may be a function of the chain, because the flags that drive it are per chain and not
     * per operation: whether the Safe is deployed says nothing about whether the Solana vault PDA
     * exists, and quoting one chain's answer for both is a threefold error on the first protect.
     */
    estimate(
        operation: CostOperation,
        ctx: WorkContext | ((chainId: string) => WorkContext),
        chainIds?: readonly string[],
    ): CostEstimate;
    refresh(): void;
}

export function useFeeEstimate(bindings: AppBindings): FeeEstimator {
    const [prices, setPrices] = useState<MainnetPrices | null>(cached?.prices ?? null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(cached === null);
    const [readAt, setReadAt] = useState(() => Math.floor(Date.now() / 1000));
    const [nonce, setNonce] = useState(0);

    const ethereumRpc = bindings.env.mainnetRpcUrl;
    const arbitrumRpc = bindings.env.arbitrumRpcUrl;

    useEffect(() => {
        let live = true;
        void loadPrices({ ethereum: ethereumRpc, arbitrum: arbitrumRpc })
            .then((value) => {
                if (!live) return;
                setPrices(value);
                setError(null);
                setReadAt(Math.floor(Date.now() / 1000));
            })
            .catch((cause: unknown) => {
                if (!live) return;
                // Named, not swallowed: "USD unavailable" with no reason is a dead end, and the
                // reason is usually a blocked RPC the reader can change.
                setError(cause instanceof Error ? cause.message : String(cause));
                setPrices(null);
            })
            .finally(() => {
                if (live) setLoading(false);
            });
        return () => {
            live = false;
        };
    }, [ethereumRpc, arbitrumRpc, nonce]);

    const chains = bindings.chains.all();

    const estimate = useCallback(
        (
            operation: CostOperation,
            ctx: WorkContext | ((chainId: string) => WorkContext),
            chainIds?: readonly string[],
        ): CostEstimate =>
            estimateCost({
                operation,
                chains: chains
                    .filter((chain) => chainIds === undefined || chainIds.includes(chain.id))
                    .map((chain) => ({
                        chainId: chain.id,
                        chainLabel: chain.label,
                        steps: workFor(
                            operation,
                            chain.id,
                            typeof ctx === "function" ? ctx(chain.id) : ctx,
                        ),
                    })),
                prices,
                protocolFees: protocolFeesFor(operation),
            }),
        [chains, prices],
    );

    return {
        prices,
        error,
        loading,
        readAtSeconds: readAt,
        estimate,
        refresh: () => {
            cached = null;
            // Set here rather than in the effect: this is the event that causes the load, and a
            // synchronous `setState` inside an effect is a second render for nothing.
            setLoading(true);
            setNonce((n) => n + 1);
        },
    };
}
