/**
 * The chain list. A readable array, on purpose: no globbing, no auto-discovery, nothing that makes
 * "which chains does this app support?" a question you answer by running it.
 *
 * **To replace:** the chain list and `ChainRegistryOptions` — a real wallet passes its own RPC
 * endpoints and probably fewer chains. **Assumes:** every module it builds is independent.
 */
import type { HttpRelaySubmitter } from "@nihilium/recovery-core";
import { createArbitrumSepoliaChain } from "./arbitrumSepolia.js";
import { createEvmSepoliaChain } from "./evm.js";
import { createSolanaDevnetChain } from "./solana.js";
import type { ChainModule, ChainRegistry } from "./types.js";
import { createZcashTestnetChain } from "./zcash/index.js";

export interface ChainRegistryOptions {
    evmRpcUrl: string;
    /** Where UserOps go. Sending value and installing the recovery module both need one. */
    evmBundlerUrl: string;
    /** Whose module attestations the EVM account trusts — and part of its address. */
    moduleAttester: `0x${string}`;
    arbitrumSepoliaRpcUrl: string;
    solanaRpcUrl: string;
    /** The relayer every chain's settlement submits through, and the fee payer on Solana. */
    relay: HttpRelaySubmitter;
}

export function createChainRegistry(options: ChainRegistryOptions): ChainRegistry {
    const chains: ChainModule[] = [
        createEvmSepoliaChain({
            rpcUrl: options.evmRpcUrl,
            bundlerUrl: options.evmBundlerUrl,
            attester: options.moduleAttester,
            relay: options.relay,
        }),
        createArbitrumSepoliaChain({ rpcUrl: options.arbitrumSepoliaRpcUrl, relay: options.relay }),
        createSolanaDevnetChain({ rpcUrl: options.solanaRpcUrl, relay: options.relay }),
        createZcashTestnetChain(),
    ];
    const byId = new Map(chains.map((chain) => [chain.id, chain]));
    return {
        all: () => [...chains],
        get: (id) => byId.get(id),
        require(id) {
            const chain = byId.get(id);
            if (chain === undefined) throw new Error(`No chain "${id}". Known: ${[...byId.keys()].join(", ")}`);
            return chain;
        },
    };
}
