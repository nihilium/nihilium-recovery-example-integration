/**
 * Every refusal, and the one case that must not refuse.
 *
 * These checks exist to fire *before* a paid ceremony, so the test that matters most is not that a
 * clean account passes — it is that each problem is detected at all, since every one of them is
 * otherwise found minutes later as a revert with an unhelpful reason.
 */
import { describe, expect, it } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { getAddress, type Address, type Hex } from "viem";
import { toEvmAddress } from "@nihilium/recovery-key-evm";
import type { VetoState } from "@nihilium/recovery-core";
import {
    MIN_RELAYER_BALANCE_WEI,
    preflightRecovery,
    isProtectedByVault,
} from "../../src/integration/recovery/settlement/evm/preflight.js";
import { toVetoState, isTerminal, type ModuleReader } from "../../src/integration/recovery/settlement/evm/reads.js";
import { fromSolidityVetoConfig } from "../../src/integration/recovery/settlement/evm/vetoConfig.js";
import { MODULE, PAUSE, ABORT, RESUME, VETO } from "./vectors.js";

const ACCOUNT = "0x7777777777777777777777777777777777777777" as Address;
const RELAYER = "0x8888888888888888888888888888888888888888" as Address;
const NAMESPACE = "eip155:11155111";

/** A real keypair, so the address the check derives is derived the same way production derives it. */
function recoveryKey(seed: number) {
    const priv = new Uint8Array(32).fill(seed);
    const pub = secp256k1.getPublicKey(priv, true);
    return {
        hex: bytesToHex(pub),
        address: getAddress(toEvmAddress({ algorithm: "secp256k1", bytes: pub })),
    };
}

const OURS = recoveryKey(1);
const SOMEONE_ELSE = recoveryKey(2);

interface FakeState {
    installed?: boolean;
    recoveryOwner?: Address;
    state?: VetoState | null;
    timelockSeconds?: number;
    relayerBalance?: bigint;
}

function fakeReader(state: FakeState = {}): ModuleReader {
    return {
        moduleAddress: MODULE,
        isInitialized: async () => state.installed ?? true,
        configOf: async () => ({
            recoveryOwner: state.recoveryOwner ?? OURS.address,
            epoch: 0n,
            nonce: 0n,
            veto: fromSolidityVetoConfig(
                { ...VETO, timelockSeconds: BigInt(state.timelockSeconds ?? 120) },
                NAMESPACE,
            ),
        }),
        attemptOf: async () => ({
            intentHash: `0x${"00".repeat(32)}` as Hex,
            state: state.state ?? null,
            accruedSeconds: 0n,
            pausedSeconds: 0n,
            checkpointTime: 0n,
        }),
        hashIntent: async () => `0x${"ab".repeat(32)}` as Hex,
        resumeDigest: async () => `0x${"cd".repeat(32)}` as Hex,
        balanceOf: async () => state.relayerBalance ?? MIN_RELAYER_BALANCE_WEI,
    };
}

const CLEAN = {
    account: ACCOUNT,
    expectedRecoveryPubKeyHex: OURS.hex,
    relayer: RELAYER,
    intentTtlSeconds: 3600,
};

describe("preflight", () => {
    it("passes an account that is installed, matching, idle and funded", async () => {
        expect(await preflightRecovery(fakeReader(), CLEAN)).toEqual([]);
    });

    it("refuses an account with no module, and reads nothing else", async () => {
        const problems = await preflightRecovery(fakeReader({ installed: false }), CLEAN);
        expect(problems.map((p) => p.code)).toEqual(["not-installed"]);
        // Only this one: `configOf` on an uninstalled account returns zeroes, and every other check
        // would then fail for a reason that is not the real one.
        expect(problems[0]!.blocking).toBe(true);
    });

    it("catches a chain protected by a different vault", async () => {
        // The shape a half-finished guardian rotation leaves behind, and the same signal a wrong
        // epoch produces — one step earlier than `assertRecoveredKeyMatches` and for free.
        const problems = await preflightRecovery(
            fakeReader({ recoveryOwner: SOMEONE_ELSE.address }),
            CLEAN,
        );
        expect(problems.map((p) => p.code)).toEqual(["owner-mismatch"]);
        expect(problems[0]!.message).toContain(SOMEONE_ELSE.address);
    });

    it.each(["INITIATED", "PAUSED", "EXECUTABLE"] as const)(
        "refuses while an attempt is %s",
        async (state) => {
            const problems = await preflightRecovery(fakeReader({ state }), CLEAN);
            expect(problems.map((p) => p.code)).toEqual(["attempt-in-flight"]);
        },
    );

    it.each(["EXECUTED", "ABORTED"] as const)("allows a fresh attempt after %s", async (state) => {
        expect(await preflightRecovery(fakeReader({ state }), CLEAN)).toEqual([]);
    });

    it("refuses an intent that would expire before the timelock matures", async () => {
        const problems = await preflightRecovery(fakeReader({ timelockSeconds: 3600 }), CLEAN);
        expect(problems.map((p) => p.code)).toEqual(["expiry-too-short"]);
    });

    it("warns about an unfunded relayer without blocking", async () => {
        const problems = await preflightRecovery(fakeReader({ relayerBalance: 1n }), CLEAN);
        expect(problems.map((p) => p.code)).toEqual(["relayer-unfunded"]);
        // A balance one transfer fixes is not a reason to refuse to start.
        expect(problems[0]!.blocking).toBe(false);
    });

    it("reports every problem at once rather than the first", async () => {
        const problems = await preflightRecovery(
            fakeReader({
                recoveryOwner: SOMEONE_ELSE.address,
                state: "PAUSED",
                timelockSeconds: 3600,
                relayerBalance: 0n,
            }),
            CLEAN,
        );
        expect(problems.map((p) => p.code).sort()).toEqual([
            "attempt-in-flight",
            "expiry-too-short",
            "owner-mismatch",
            "relayer-unfunded",
        ]);
    });
});

describe("isProtectedByVault", () => {
    it("is false with no module, true on a match, false on a mismatch", async () => {
        expect(await isProtectedByVault(fakeReader({ installed: false }), ACCOUNT, OURS.hex)).toBe(false);
        expect(await isProtectedByVault(fakeReader(), ACCOUNT, OURS.hex)).toBe(true);
        expect(await isProtectedByVault(fakeReader(), ACCOUNT, SOMEONE_ELSE.hex)).toBe(false);
    });
});

describe("veto state ordinals", () => {
    it("maps the contract's ordinals, and refuses to invent one for NONE", () => {
        expect(toVetoState(0)).toBeNull();
        expect(toVetoState(1)).toBe("INITIATED");
        expect(toVetoState(2)).toBe("PAUSED");
        expect(toVetoState(3)).toBe("EXECUTABLE");
        expect(toVetoState(4)).toBe("EXECUTED");
        expect(toVetoState(5)).toBe("ABORTED");
    });

    it("throws on an ordinal it does not know rather than guessing", () => {
        // A module that grew a state this build has not heard of is not a module to keep driving.
        expect(() => toVetoState(6)).toThrow(/does not know/);
    });

    it("treats only executed and aborted as terminal", () => {
        expect(isTerminal("EXECUTED")).toBe(true);
        expect(isTerminal("ABORTED")).toBe(true);
        expect(isTerminal("PAUSED")).toBe(false);
        expect(isTerminal(null)).toBe(false);
    });
});

describe("the veto config read back", () => {
    it("round-trips through the flat Solidity shape", () => {
        const nested = fromSolidityVetoConfig(VETO, NAMESPACE);
        expect(nested.pauseAuthority.id).toBe(PAUSE);
        expect(nested.abortAuthority.id).toBe(ABORT);
        expect(nested.resumeQuorum.members.map((m) => m.id)).toEqual([...RESUME]);
        expect(nested.resumeQuorum.threshold).toBe(2);
        expect(nested.timelockSeconds).toBe(120);
        expect(nested.pauseCeilingSeconds).toBe(3600);
    });
});
