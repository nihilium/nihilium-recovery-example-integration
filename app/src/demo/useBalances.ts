/**
 * Balances for one chain's accounts. `useState` + `useEffect`, and that is the whole state library.
 *
 * The map is stored with the chain it belongs to, so switching chains cannot flash the previous
 * chain's numbers under the new chain's addresses: an entry whose `chainId` does not match is not
 * "stale", it is *absent*, and absent renders as loading.
 */
import { useEffect, useState } from "react";
import type { Balance, ChainModule, DerivedAccount } from "../integration/chains/types.js";

export type BalanceState = Balance | "loading" | "unreadable";

interface Loaded {
    chainId: string;
    values: Record<string, BalanceState>;
}

export function useBalances(
    chain: ChainModule,
    accounts: DerivedAccount[],
): Record<string, BalanceState> {
    const [loaded, setLoaded] = useState<Loaded>({ chainId: chain.id, values: {} });

    useEffect(() => {
        let live = true;

        void Promise.all(
            accounts.map(async (account) => {
                try {
                    const balance = await chain.balanceOf(account.address);
                    if (live) {
                        setLoaded((prev) =>
                            prev.chainId === chain.id
                                ? { ...prev, values: { ...prev.values, [account.address]: balance } }
                                : { chainId: chain.id, values: { [account.address]: balance } },
                        );
                    }
                } catch {
                    // An unreadable balance is not a zero one, and must never render as one.
                    if (live) {
                        setLoaded((prev) => ({
                            chainId: chain.id,
                            values: { ...(prev.chainId === chain.id ? prev.values : {}), [account.address]: "unreadable" },
                        }));
                    }
                }
            }),
        );

        return () => {
            live = false;
        };
    }, [chain, accounts]);

    return loaded.chainId === chain.id ? loaded.values : {};
}
