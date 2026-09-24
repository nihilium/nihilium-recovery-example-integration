/**
 * The sweep's nonce is its routing, and viem's wrapper must not be able to reroute it.
 *
 * Safe7579 picks the validator for a UserOp from the nonce key. viem's `toSmartAccount` computes a
 * key itself — `parameters?.key ?? Date.now()` — and passes it into the implementation's `getNonce`,
 * so an implementation that honours the key it is handed always receives a timestamp. That is how a
 * correctly signed sweep went out on a timestamp key, was checked against the Safe's lost original
 * owner, and failed with `AA24 signature error`.
 *
 * Driven through the real `toSmartAccount`, because the bug lives in the interaction, not in either
 * half on its own.
 */
import { describe, expect, it } from "vitest";
import type { Address, PublicClient } from "viem";
import { entryPoint07Abi, entryPoint07Address, toSmartAccount } from "viem/account-abstraction";
import {
    routedNonce,
    validatorNonceKey,
} from "../../src/integration/recovery/settlement/evm/recoveredOwner.js";
import { OWNABLE_VALIDATOR_ADDRESS } from "../../src/integration/recovery/settlement/evm/erc7579.js";

const SAFE = "0x9A8FdFEaCeaa3A68F6795eCCd1f79A70a3F7D328" as Address;

function recordingClient() {
    const keys: bigint[] = [];
    const client = {
        chain: { id: 11155111 },
        async readContract(args: { functionName: string; args: readonly unknown[] }) {
            if (args.functionName === "getNonce") keys.push(args.args[1] as bigint);
            return 0n;
        },
    } as unknown as PublicClient;
    return { client, keys };
}

async function accountWith(client: PublicClient) {
    const key = validatorNonceKey(OWNABLE_VALIDATOR_ADDRESS);
    // Only what `toSmartAccount` touches for a nonce; the rest is never called here.
    const account = await toSmartAccount({
        client,
        entryPoint: { abi: entryPoint07Abi, address: entryPoint07Address, version: "0.7" },
        getAddress: async () => SAFE,
        getNonce: routedNonce(client, SAFE, key),
    } as unknown as Parameters<typeof toSmartAccount>[0]);
    return { account, key };
}

describe("routedNonce", () => {
    it("reads the validator's key even though viem hands it a timestamp", async () => {
        const { client, keys } = recordingClient();
        const { account, key } = await accountWith(client);

        await account.getNonce();

        expect(keys).toEqual([key]);
        // What viem would have used: a millisecond timestamp, nowhere near an address-shaped key.
        expect(keys[0]! > BigInt(Date.now())).toBe(true);
    });

    it("ignores an explicit key too — any other key routes to the wrong validator", async () => {
        const { client, keys } = recordingClient();
        const { account, key } = await accountWith(client);

        await account.getNonce({ key: 12345n });

        expect(keys).toEqual([key]);
    });

    it("puts the validator's address in the key's top bits, which is how Safe7579 routes", () => {
        const key = validatorNonceKey(OWNABLE_VALIDATOR_ADDRESS);
        expect(`0x${(key >> 32n).toString(16).padStart(40, "0")}`).toBe(
            OWNABLE_VALIDATOR_ADDRESS.toLowerCase(),
        );
    });
});
