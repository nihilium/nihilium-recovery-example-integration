/**
 * The one binding point.
 *
 * Mode, chain registry, and (from M3) the SDK instance and its stores are built here together,
 * because they have to move as a unit: a registry pointed at one RPC with an SDK pointed at another
 * is a bug that looks like configuration. Everything else in the app receives what this returns.
 *
 * Built once, in `App.tsx`'s `useMemo`. Rebuilding it mid-run would swap the SDK instance under an
 * in-flight scenario.
 */
import { createChainRegistry } from "../integration/chains/registry.js";
import type { ChainRegistry } from "../integration/chains/types.js";
import { readEnv, type DemoEnv } from "./env.js";

export interface AppBindings {
    env: DemoEnv;
    chains: ChainRegistry;
}

export function createAppBindings(): AppBindings {
    const env = readEnv();
    return {
        env,
        chains: createChainRegistry({ evmRpcUrl: env.sepoliaRpcUrl }),
    };
}
