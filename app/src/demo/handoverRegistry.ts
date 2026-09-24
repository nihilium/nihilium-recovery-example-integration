/**
 * Which chains this build can actually carry a handover through.
 *
 * Here rather than in `integration/` because it reads `DemoEnv` — RPC and bundler URLs are the
 * app's configuration, not the SDK's. The implementations themselves are copyable; choosing between
 * them from an env file is not.
 *
 * `null` is a real answer and the honest one for Zcash: it has no settlement program, so a recovery
 * there registers a key nothing honours. Returning a stub that failed at submit time would look like
 * a wired chain having a bad day.
 */
import { createEvmHandover } from "../integration/recovery/handover/evm.js";
import { createSolanaHandover } from "../integration/recovery/handover/solana.js";
import type { ChainHandover } from "../integration/recovery/handover/types.js";
import type { AppBindings } from "./bindings.js";

export function handoverFor(bindings: AppBindings, chainId: string): ChainHandover | null {
    if (chainId === "evm-sepolia") {
        return createEvmHandover({
            chainId: bindings.env.chainId,
            rpcUrl: bindings.env.sepoliaRpcUrl,
            bundlerUrl: bindings.env.bundlerUrl,
        });
    }
    if (chainId === "solana-devnet") {
        return createSolanaHandover({ rpcUrl: bindings.env.solanaRpcUrl, cluster: "devnet" });
    }
    return null;
}
