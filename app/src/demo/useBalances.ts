/**
 * Balances for one chain's accounts. `useState` + `useEffect`, and that is the whole state library.
 *
 * The map is stored with the chain it belongs to, so switching chains cannot flash the previous
 * chain's numbers under the new chain's addresses: an entry whose `chainId` does not match is not
 * "stale", it is *absent*, and absent renders as loading.
 */
import { useEffect, useState } from "react";
import type { Balance, ChainModule } from "../integration/chains/types.js";

export type BalanceState = Balance | "loading" | "unreadable";

interface Loaded {
    chainId: string;
    values: Record<string, BalanceState>;
}

/**
 * Takes addresses rather than accounts, because not every balance worth showing belongs to one.
 *
 * On a chain where recovery protects a program-owned vault, the balance the user cares about sits
 * at an address no key derives — so a signature keyed on `DerivedAccount` could not ask for it.
 */
export function useBalances(
    chain: ChainModule,
    addresses: string[],
): Record<string, BalanceState> {
    const [loaded, setLoaded] = useState<Loaded>({ chainId: chain.id, values: {} });

    useEffect(() => {
        let live = true;

        void Promise.all(
            addresses.map(async (address) => {
                try {
                    const balance = await chain.balanceOf(address);
                    if (live) {
                        setLoaded((prev) =>
                            prev.chainId === chain.id
                                ? { ...prev, values: { ...prev.values, [address]: balance } }
                                : { chainId: chain.id, values: { [address]: balance } },
                        );
                    }
                } catch {
                    // An unreadable balance is not a zero one, and must never render as one.
                    if (live) {
                        setLoaded((prev) => ({
                            chainId: chain.id,
                            values: { ...(prev.chainId === chain.id ? prev.values : {}), [address]: "unreadable" },
                        }));
                    }
                }
            }),
        );

        return () => {
            live = false;
        };
        // Joined, because an array literal is a new reference on every render and would re-fetch
        // every balance forever.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [chain, addresses.join(",")]);

    return loaded.chainId === chain.id ? loaded.values : {};
}
