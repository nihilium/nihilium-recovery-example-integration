/**
 * The Arbitrum relayer's routes, with the chain stubbed out.
 *
 * What this pins is the boundary: a malformed request is refused with a 400 before any transaction
 * is built, and a well-formed one reaches the contract untouched and **at the EOA's own address**.
 * The contract is the account, so a call aimed anywhere else lands on an implementation with no
 * state and a different EIP-712 domain.
 */
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { PublicClient, WalletClient } from "viem";
import { createEip7702RelayerRouter } from "../src/roles/relayer/eip7702.js";

const EOA = "0x7777777777777777777777777777777777777777";
const NEW_OWNER = "0x8888888888888888888888888888888888888888";
const IMPLEMENTATION = "0x2577F7c15EBf513b28379a29F98391BD3943cA76";
const relayer = privateKeyToAccount(`0x${"42".repeat(32)}`);

const writes: { address: string; functionName: string; args: unknown[] }[] = [];

const publicClient = {
    async readContract({ functionName }: { functionName: string }) {
        return functionName === "attemptOf" ? [`0x${"00".repeat(32)}`, 0n, {}] : 0;
    },
    async waitForTransactionReceipt() {
        return { status: "success" };
    },
} as unknown as PublicClient;

const walletClient = {
    chain: undefined,
    async writeContract(call: { address: string; functionName: string; args: unknown[] }) {
        writes.push(call);
        return `0x${"cd".repeat(32)}`;
    },
} as unknown as WalletClient;

let base = "";
let close: () => void = () => {};

beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use(
        "/arbitrum",
        createEip7702RelayerRouter({
            publicClient,
            walletClient,
            relayer,
            implementation: IMPLEMENTATION,
            vetoConfig: {
                pauseAuthority: NEW_OWNER,
                resumeMembers: [NEW_OWNER],
                resumeThreshold: 1,
                timelockSeconds: 300,
                pauseCeilingSeconds: 900,
            },
            log: () => {},
        }),
    );
    await new Promise<void>((resolve) => {
        const server = app.listen(0, () => {
            base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/arbitrum`;
            close = () => server.close();
            resolve();
        });
    });
});

afterAll(() => close());

const post = (path: string, body: unknown) =>
    fetch(`${base}/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });

const INTENT = { account: EOA, epoch: "0", nonce: "0", newOwner: NEW_OWNER, expiry: 2_000_000_000 };
const SIGNATURE = `0x${"ab".repeat(65)}`;

describe("the Arbitrum relayer", () => {
    it("publishes the implementation and the operator's veto keys, never an abort key", async () => {
        const config = (await (await fetch(`${base}/config`)).json()) as Record<string, unknown>;
        expect(config["implementation"]).toBe(IMPLEMENTATION);
        expect(config["relayer"]).toBe(relayer.address);
        expect(config).not.toHaveProperty("abortAuthority");
    });

    it("refuses malformed requests with a 400 and sends nothing", async () => {
        const before = writes.length;
        expect((await post("initiate", { intent: { ...INTENT, account: "nope" }, signature: SIGNATURE })).status).toBe(400);
        expect((await post("initiate", { intent: INTENT })).status).toBe(400);
        expect((await post("execute", {})).status).toBe(400);
        expect((await post("execute", { intent: { ...INTENT, epoch: "-1" } })).status).toBe(400);
        expect((await post("execute-calls", { account: EOA, calls: [], expiry: 1, signature: SIGNATURE })).status).toBe(400);
        expect(
            (await post("execute-calls", {
                account: EOA,
                calls: [{ target: NEW_OWNER, value: "1", data: "not hex" }],
                expiry: 1,
                signature: SIGNATURE,
            })).status,
        ).toBe(400);
        expect(writes.length).toBe(before);
    });

    it("sends initiateRecovery to the EOA itself, with the intent untouched", async () => {
        const response = await post("initiate", { intent: INTENT, signature: SIGNATURE });
        expect(response.status).toBe(200);
        const call = writes.at(-1)!;
        expect(call.address.toLowerCase()).toBe(EOA);
        expect(call.functionName).toBe("initiateRecovery");
        expect(call.args).toEqual([
            { epoch: 0n, nonce: 0n, newOwner: NEW_OWNER, expiry: 2_000_000_000 },
            SIGNATURE,
        ]);
    });

    it("sends the owner's calls with their value as wei, taken from the account", async () => {
        const response = await post("execute-calls", {
            account: EOA,
            calls: [{ target: NEW_OWNER, value: "12345", data: "0x" }],
            expiry: 2_000_000_000,
            signature: SIGNATURE,
        });
        expect(response.status).toBe(200);
        const call = writes.at(-1)!;
        expect(call.functionName).toBe("execute");
        expect(call.args[0]).toEqual([{ target: NEW_OWNER, value: 12345n, data: "0x" }]);
        // The relayer attaches no value of its own: the sweep spends the account's balance.
        expect(call).not.toHaveProperty("value");
    });
});
