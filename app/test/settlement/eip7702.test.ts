/**
 * The 7702 account's checks, against a fake reader.
 *
 * Two of these guard steps nobody can undo. A delegation is signed by the EOA's own key, so an owner
 * who has lost it can never re-point the code. Delegating to an implementation that cannot receive
 * ETH, or over somebody else's wallet code, is therefore refused before the authorization is signed,
 * and each refusal is pinned here. The rest mirror the Sepolia preflight: every reason
 * `initiateRecovery` would revert, found before a paid ceremony.
 */
import { describe, expect, it } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { getAddress, type Address, type Hex } from "viem";
import { toEvmAddress } from "@nihilium/recovery-key-evm";
import type { VetoState } from "@nihilium/recovery-core";
import {
    isProtectedByVault,
    preflightProtect,
    preflightRecovery,
} from "../../src/integration/recovery/settlement/eip7702/preflight.js";
import {
    parseDelegation,
    type Delegation,
    type Eip7702Reader,
} from "../../src/integration/recovery/settlement/eip7702/reads.js";
import { fromSolidityVetoConfig } from "../../src/integration/recovery/settlement/evm/vetoConfig.js";
import { VETO } from "./vectors.js";

const EOA = "0x7777777777777777777777777777777777777777" as Address;
const IMPLEMENTATION = "0xE64f4F8515B872aeEf99989eDFd12759caa0eD6f" as Address; // 2.0.0
const OTHER_CODE = "0x63c4845489A4A6a2B5bFaBB2eE1cBa9A1a1F58B6" as Address;
const NAMESPACE = "eip155:421614";

function recoveryKey(seed: number) {
    const pub = secp256k1.getPublicKey(new Uint8Array(32).fill(seed), true);
    return {
        hex: bytesToHex(pub),
        address: getAddress(toEvmAddress({ algorithm: "secp256k1", bytes: pub })),
    };
}
const OURS = recoveryKey(1);
const SOMEONE_ELSE = recoveryKey(2);

interface FakeState {
    delegation: Delegation;
    acceptsValue: boolean;
    registered: boolean;
    recoveryOwner: Address;
    attempt: VetoState | null;
    timelockSeconds: bigint;
}

function reader(over: Partial<FakeState> = {}): Eip7702Reader & { digestsAsked: string[] } {
    const state: FakeState = {
        delegation: { kind: "ours" },
        acceptsValue: true,
        registered: true,
        recoveryOwner: OURS.address,
        attempt: null,
        timelockSeconds: 300n,
        ...over,
    };
    const digestsAsked: string[] = [];
    const notDelegated = () => {
        // What a real node does: an undelegated EOA has no code, so the call returns nothing.
        if (state.delegation.kind !== "ours" && state.delegation.kind !== "legacy") {
            throw new Error("returned no data (0x)");
        }
    };
    return {
        account: EOA,
        implementation: IMPLEMENTATION,
        digestsAsked,
        delegation: async () => state.delegation,
        implementationAcceptsValue: async () => state.acceptsValue,
        async isRegistered() {
            notDelegated();
            return state.registered;
        },
        async configOf() {
            notDelegated();
            return {
                currentOwner: EOA,
                recoveryOwner: state.recoveryOwner,
                epoch: 0n,
                nonce: 0n,
                configNonce: 1n,
                execNonce: 0n,
                veto: fromSolidityVetoConfig(
                    { ...VETO, timelockSeconds: state.timelockSeconds },
                    NAMESPACE,
                ),
            };
        },
        async attemptOf() {
            notDelegated();
            return {
                intentHash: `0x${"ab".repeat(32)}` as Hex,
                attemptSeq: 0n,
                state: state.attempt,
                accruedSeconds: 0n,
                pausedSeconds: 0n,
                checkpointTime: 0n,
            };
        },
        stateOf: async () => state.attempt,
        async hashIntent() {
            digestsAsked.push("intent");
            return `0x${"11".repeat(32)}` as Hex;
        },
        async hashRegister() {
            digestsAsked.push("register");
            return `0x${"22".repeat(32)}` as Hex;
        },
        async hashExecute() {
            digestsAsked.push("execute");
            return `0x${"33".repeat(32)}` as Hex;
        },
        balance: async () => 0n,
    };
}

const codes = (problems: readonly { code: string }[]) => problems.map((p) => p.code);

describe("reading an EOA's delegation", () => {
    const designator = (target: string) => `0xef0100${target.slice(2).toLowerCase()}` as Hex;

    it("reads no code as not delegated", () => {
        expect(parseDelegation(undefined, IMPLEMENTATION)).toEqual({ kind: "none" });
        expect(parseDelegation("0x", IMPLEMENTATION)).toEqual({ kind: "none" });
    });

    it("recognises a delegation to this implementation, whatever the case", () => {
        expect(parseDelegation(designator(IMPLEMENTATION), IMPLEMENTATION)).toEqual({ kind: "ours" });
    });

    it("names somebody else's code rather than treating it as ours", () => {
        expect(parseDelegation(designator(OTHER_CODE), IMPLEMENTATION)).toEqual({
            kind: "other",
            target: getAddress(OTHER_CODE),
        });
    });

    it("recognises a superseded version of ours, and names it", () => {
        const legacy = new Map([[getAddress(OTHER_CODE), "1.1.0"]]);
        expect(parseDelegation(designator(OTHER_CODE), IMPLEMENTATION, legacy)).toEqual({
            kind: "legacy",
            version: "1.1.0",
            target: getAddress(OTHER_CODE),
        });
    });

    it("knows the SDK's own superseded deployments without being told", () => {
        // v1.1.0 on Arbitrum Sepolia, from `legacyEip7702AccountAddresses`. Accounts protected before
        // 2.0.0 shipped are delegated here, and must read as ours rather than as foreign code.
        const v11 = "0x2577F7c15EBf513b28379a29F98391BD3943cA76";
        expect(parseDelegation(designator(v11), IMPLEMENTATION)).toMatchObject({ kind: "legacy", version: "1.1.0" });
    });

    it("treats real contract code as not an EOA at all", () => {
        expect(parseDelegation("0x6080604052", IMPLEMENTATION)).toEqual({ kind: "other", target: null });
    });
});

describe("before delegating", () => {
    it("lets a fresh EOA delegate to an implementation that can receive ETH", async () => {
        expect(await preflightProtect(reader({ delegation: { kind: "none" } }))).toEqual([]);
    });

    it("refuses an implementation without receive()", async () => {
        // v1.0.0 was exactly this: once delegated, the account could never be paid again.
        const problems = await preflightProtect(reader({ acceptsValue: false }));
        expect(codes(problems)).toEqual(["implementation-cannot-receive"]);
        expect(problems[0]!.blocking).toBe(true);
    });

    it("lets an account on a superseded version upgrade, rather than refusing it as foreign", async () => {
        const problems = await preflightProtect(
            reader({ delegation: { kind: "legacy", version: "1.1.0", target: OTHER_CODE } }),
        );
        expect(problems).toEqual([]);
    });

    it("refuses to replace somebody else's delegation", async () => {
        const problems = await preflightProtect(
            reader({ delegation: { kind: "other", target: OTHER_CODE } }),
        );
        expect(codes(problems)).toEqual(["delegated-elsewhere"]);
        expect(problems[0]!.message).toContain(OTHER_CODE);
    });
});

describe("before a recovery", () => {
    const params = { expectedRecoveryPubKeyHex: OURS.hex, intentTtlSeconds: 3600 };

    it("passes a registered account that holds this vault's key", async () => {
        expect(await preflightRecovery(reader(), params)).toEqual([]);
    });

    it("stops at an undelegated account, without reading storage that is not there", async () => {
        expect(codes(await preflightRecovery(reader({ delegation: { kind: "none" } }), params))).toEqual([
            "not-delegated",
        ]);
    });

    it("recovers an account still on a superseded version", async () => {
        // It still honours its registration. Refusing it would strand every account whose owner
        // lost their key before upgrading, which is exactly who recovery is for.
        const legacy = reader({ delegation: { kind: "legacy", version: "1.1.0", target: OTHER_CODE } });
        expect(await preflightRecovery(legacy, params)).toEqual([]);
    });

    it("stops at a delegated account with no key registered", async () => {
        expect(codes(await preflightRecovery(reader({ registered: false }), params))).toEqual([
            "not-registered",
        ]);
    });

    it("reports every problem at once", async () => {
        const problems = await preflightRecovery(
            reader({
                recoveryOwner: SOMEONE_ELSE.address,
                attempt: "INITIATED",
                timelockSeconds: 3600n,
            }),
            params,
        );
        expect(codes(problems)).toEqual(["owner-mismatch", "attempt-in-flight", "expiry-too-short"]);
    });

    it("lets a new attempt start once the last one is terminal", async () => {
        expect(await preflightRecovery(reader({ attempt: "ABORTED" }), params)).toEqual([]);
    });

    it("never computes a digest to reach its answer", async () => {
        const r = reader();
        await preflightRecovery(r, params);
        await preflightProtect(r);
        expect(r.digestsAsked).toEqual([]);
    });
});

describe("the protection badge", () => {
    it("is protected only by this vault's key, on this implementation", async () => {
        expect(await isProtectedByVault(reader(), OURS.hex)).toBe(true);
        expect(await isProtectedByVault(reader({ recoveryOwner: SOMEONE_ELSE.address }), OURS.hex)).toBe(
            false,
        );
        expect(await isProtectedByVault(reader({ registered: false }), OURS.hex)).toBe(false);
        expect(
            await isProtectedByVault(reader({ delegation: { kind: "other", target: OTHER_CODE } }), OURS.hex),
        ).toBe(false);
    });
});
