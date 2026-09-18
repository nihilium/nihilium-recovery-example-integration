/**
 * The chain list. A readable array, on purpose: no globbing, no auto-discovery, nothing that makes
 * "which chains does this app support?" a question you answer by running it.
 *
 * Adding a chain is one module next door plus one line here.
 *
 * **To replace:** the chain list and `ChainRegistryOptions` — a real wallet passes its own RPC
 * endpoints and probably fewer chains. **Assumes:** every module it builds is independent; none of
 * them may reach for another through this registry.
 */
import { createEvmSepoliaChain } from "./evm.js";
import { createSolanaDevnetChain } from "./solana.js";
import type { ChainModule, ChainRegistry } from "./types.js";
import { createZcashTestnetChain } from "./zcash/index.js";

export interface ChainRegistryOptions {
    /** The only external dependency any chain here has. Passed in, never read from the environment. */
    evmRpcUrl: string;
}

export function createChainRegistry(options: ChainRegistryOptions): ChainRegistry {
    const chains: ChainModule[] = [
        createEvmSepoliaChain({ rpcUrl: options.evmRpcUrl }),
        createSolanaDevnetChain(),
        createZcashTestnetChain(),
    ];

    const byId = new Map(chains.map((chain) => [chain.id, chain]));

    return {
        all: () => [...chains],
        get: (id) => byId.get(id),
        require(id) {
            const chain = byId.get(id);
            if (chain === undefined) {
                throw new Error(`No chain "${id}". Known: ${[...byId.keys()].join(", ")}`);
            }
            return chain;
        },
    };
}
