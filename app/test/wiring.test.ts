/**
 * The chain modules agree with the SDK adapters they wrap: same namespace, same address encoding, a
 * full capability matrix. Hermetic — nothing here touches an RPC.
 */
import { describe, expect, it } from "vitest";
import { HttpRelaySubmitter } from "@nihilium/recovery-core";
import { createChainRegistry } from "../src/integration/chains/registry.js";

const registry = createChainRegistry({
    evmRpcUrl: "http://127.0.0.1:1",
    evmBundlerUrl: "http://127.0.0.1:1",
    moduleAttester: "0x4490f5D9f1cf47b2FBa68158c130aAE8107274a9",
    arbitrumSepoliaRpcUrl: "http://127.0.0.1:1",
    solanaRpcUrl: "http://127.0.0.1:1",
    relay: new HttpRelaySubmitter({ baseUrl: "http://127.0.0.1:1/api/relay" }),
});

describe("the chain modules and their settlement adapters", () => {
    const settled = registry.all().filter((chain) => chain.settlement !== null);

    it("wire a settlement on every chain this demo protects", () => {
        expect(settled.map((chain) => chain.id)).toEqual(["evm-sepolia", "arbitrum-sepolia", "solana-devnet"]);
        expect(registry.get("zcash-testnet")?.settlement).toBeNull();
    });

    it.each(settled.map((chain) => [chain.id, chain] as const))("%s agrees with its adapter on namespace, tier and addresses", (_id, chain) => {
        const adapter = chain.settlement!;
        expect(adapter.namespace).toBe(chain.namespace);
        expect(adapter.tier).toBe(chain.tier);
        const matrix = adapter.capabilities();
        expect(Object.keys(matrix).sort()).toEqual(["abort", "confinement", "pause", "resume"]);
        const key = chain.keyAdapter.algorithm === "secp256k1"
            ? { algorithm: "secp256k1" as const, bytes: Uint8Array.from([2, ...new Array(32).fill(1)]) }
            : { algorithm: "ed25519" as const, bytes: new Uint8Array(32).fill(7) };
        expect(chain.addressOf(key)).toBe(adapter.addressOf(key));
    });

    it("names the constructions the SDK ships", () => {
        expect(settled.map((chain) => chain.settlement!.kind)).toEqual(["erc7579-recovery-module", "eip7702-recovery-account", "solana-recovery-vault"]);
        expect(registry.get("arbitrum-sepolia")!.settlement!.registration).toBe("owner-and-recovery-key-sign");
        expect(registry.get("evm-sepolia")!.settlement!.registration).toBe("owner-executes");
    });
});
