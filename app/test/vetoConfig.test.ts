/**
 * The veto config, validated — and the §7 rule that changed under us.
 *
 * The SDK used to refuse a seed-derived abort key: in true seed loss it would be gone exactly when
 * it was needed. That rule is gone. A backstop is defined by sitting **outside Nihilium's control**,
 * not by where it was derived, and the account's own active key is now the natural default — the
 * common case for abort is someone opening a recovery while the owner still has access.
 *
 * This repo had been withholding `seedDerived` from the validator to dodge the old check. It
 * declares its context now, so the check that *did* survive can actually run: a seal-gated abort key
 * is still refused, and still must be.
 *
 * `@nihilium/recovery-veto` is wired to nothing in the SDK. If this app does not call it, nothing
 * does — the module will install a config whose pause authority also sits in the resume quorum
 * without a word.
 */
import { describe, expect, it } from "vitest";
import { assertSolanaVetoUsable } from "../src/integration/recovery/settlement/solana/vault.js";
import { validateVetoConfig } from "@nihilium/recovery-veto";
import type { Authority, VetoConfig } from "@nihilium/recovery-core";
import {
    assertResumeQuorumPortable,
    demoVetoConfig,
    fromSolidityVetoConfig,
    MAX_RESUME_MEMBERS_SOLANA,
    toSolidityVetoConfig,
    validateDemoVetoConfig,
} from "../src/integration/recovery/settlement/evm/vetoConfig.js";

const NAMESPACE = "eip155:11155111";
const WALLET = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const PAUSE = "0x40FBBE484b8Ee6139Af08446950B088e10b2306A";
const RESUME = [
    "0x9C6648248566F60D9c212339BD03Be81E2639443",
    "0xa82a22CCe5c44c8aC95ab8ac78FCE8dD524678B5",
    "0x1e604d77963Bd8A21CF1d4CB7117bf9a1316FD32",
];

function config(over: Partial<Parameters<typeof demoVetoConfig>[0]> = {}): VetoConfig {
    return demoVetoConfig({
        namespace: NAMESPACE,
        pauseAuthority: PAUSE,
        abortAuthority: WALLET,
        resumeMembers: RESUME,
        resumeThreshold: 2,
        timelockSeconds: 300,
        pauseCeilingSeconds: 900,
        ...over,
    });
}

describe("validateDemoVetoConfig", () => {
    it("accepts the wallet's own key as the abort authority", () => {
        // The shape this demo ships, and the SDK's stated default. Seed-derived, and fine.
        expect(() => validateDemoVetoConfig(config())).not.toThrow();
    });

    it("still refuses a pause authority that also holds abort", () => {
        // The rule that did not change: the watcher must not hold the user's last resort.
        expect(() => validateDemoVetoConfig(config({ abortAuthority: PAUSE }))).toThrow(
            /pause and abort/i,
        );
    });

    it("still refuses a resume member that also holds abort", () => {
        expect(() => validateDemoVetoConfig(config({ abortAuthority: RESUME[0]! }))).toThrow(
            /resume quorum/i,
        );
    });

    it("refuses a threshold larger than the quorum", () => {
        expect(() => validateDemoVetoConfig(config({ resumeThreshold: 4 }))).toThrow();
    });

    it("still refuses a seal-gated abort key — the rule that survived", () => {
        // The one hard rule left. A seal-gated abort key inherits Nihilium's liveness, so it cannot
        // back up Nihilium's failure, which is the single thing it exists for. Called directly
        // because the demo's own config declares `sealGated: []` and can never hit this.
        const gated = config();
        expect(() =>
            validateVetoConfig(gated, { sealGated: [gated.abortAuthority], conditionSurface: [] }),
        ).toThrow(/seal-gated/i);
    });

    it("no longer refuses an abort key merely for being seed-derived", () => {
        // The reversal. Declaring it seed-derived used to throw; provenance is not what makes a key
        // a backstop, sitting outside Nihilium's control is.
        const seeded = config();
        expect(() =>
            validateVetoConfig(seeded, { seedDerived: [seeded.abortAuthority], sealGated: [] }),
        ).not.toThrow();
    });

    it("refuses a non-positive timelock or ceiling", () => {
        // A zero timelock makes every recovery immediately executable — no window for any veto.
        expect(() => validateDemoVetoConfig(config({ timelockSeconds: 0 }))).toThrow(/timelock/i);
        expect(() => validateDemoVetoConfig(config({ pauseCeilingSeconds: 0 }))).toThrow(/ceiling/i);
    });
});

describe("the Solana resume ceiling", () => {
    it("allows a quorum up to the cap", () => {
        const members = Array.from(
            { length: MAX_RESUME_MEMBERS_SOLANA },
            (_, i) => `0x${String(i + 1).repeat(40).slice(0, 40)}`,
        );
        expect(() =>
            assertResumeQuorumPortable(config({ resumeMembers: members, resumeThreshold: 2 })),
        ).not.toThrow();
    });

    it("refuses one past it, naming why", () => {
        // 9 members would seal and install on EVM and be unregistrable the moment Solana joined:
        // k detached signatures have to fit one 1232-byte transaction.
        const members = Array.from(
            { length: MAX_RESUME_MEMBERS_SOLANA + 1 },
            (_, i) => `0x${String(i + 1).repeat(40).slice(0, 40)}`,
        );
        expect(() =>
            assertResumeQuorumPortable(config({ resumeMembers: members, resumeThreshold: 2 })),
        ).toThrow(/Solana/);
    });
});

describe("the flat/nested mapping", () => {
    it("round-trips without losing a field", () => {
        const nested = config();
        const back = fromSolidityVetoConfig(toSolidityVetoConfig(nested), NAMESPACE);
        expect(back.abortAuthority.id).toBe(WALLET);
        expect(back.pauseAuthority.id).toBe(PAUSE);
        expect(back.resumeQuorum.members.map((m: Authority) => m.id)).toEqual(RESUME);
        expect(back.resumeQuorum.threshold).toBe(2);
        expect(back.timelockSeconds).toBe(300);
        expect(back.pauseCeilingSeconds).toBe(900);
    });

    it("refuses an authority that is not an EVM address", () => {
        // A Solana authority encoded into an eip155 module would be silently wrong calldata.
        expect(() =>
            toSolidityVetoConfig(config({ abortAuthority: "So11111111111111111111111111111111111111112" })),
        ).toThrow(/not an EVM address/);
    });
});

describe("the Solana veto rules, checked before a transaction exists", () => {
    /**
     * Each of these is enforced by the program. Without this guard they arrive as
     * `{"InstructionError":[1,{"Custom":6027}]}` from a simulation — a number naming nothing, for
     * the demo's single most important claim: three veto roles on one key looks correctly
     * configured and is worth nothing.
     */
    const PAUSE = "FV4WECEf4WcceqpCykUaWiNL4nPgVnUvMPv5e22cSBFd";
    const ABORT = "AqynRZwvVqUPRwRJXvm6odUb3t93fDjnWe3p6BeuUFxD";
    const MEMBERS = [
        "6XBsxo8SSJh2V9fWzzrtWoU2QzAawJY4dE5FZBLs5c7w",
        "J1UrAwJSY3ZnXzprJHXgq1JQWZYewoCKETb16hJVupAG",
        "8BttMjz28uKL4KpvxVWEk4VmYAAG95mBE57bMnCKefCY",
    ];
    const OK = {
        pauseAuthority: PAUSE,
        abortAuthority: ABORT,
        resumeMembers: MEMBERS,
        resumeThreshold: 2,
        timelockSeconds: 300,
        pauseCeilingSeconds: 900,
    };

    it("accepts three genuinely separate parties", () => {
        expect(() => assertSolanaVetoUsable(OK)).not.toThrow();
    });

    it("refuses one key holding pause and abort", () => {
        expect(() => assertSolanaVetoUsable({ ...OK, abortAuthority: PAUSE })).toThrow(
            /PauseAndAbortHeldByOneParty/,
        );
    });

    it("refuses a pause authority sitting in the quorum that lifts it", () => {
        expect(() =>
            assertSolanaVetoUsable({ ...OK, resumeMembers: [...MEMBERS, PAUSE] }),
        ).toThrow(/PauseAndResumeHeldByOneParty/);
    });

    it("refuses an abort authority sitting in the resume quorum", () => {
        expect(() =>
            assertSolanaVetoUsable({ ...OK, resumeMembers: [...MEMBERS, ABORT] }),
        ).toThrow(/ResumeAndAbortHeldByOneParty/);
    });

    it("refuses a threshold nobody could reach", () => {
        expect(() => assertSolanaVetoUsable({ ...OK, resumeThreshold: 4 })).toThrow(
            /ResumeThresholdExceedsMembership/,
        );
    });

    it("refuses a pause ceiling of zero, which is an abort wearing a pause's name", () => {
        expect(() => assertSolanaVetoUsable({ ...OK, pauseCeilingSeconds: 0 })).toThrow(
            /PauseCeilingIsZero/,
        );
    });

    it("refuses a quorum larger than one transaction can carry", () => {
        const nine = Array.from({ length: 9 }, (_, i) => `${"1".repeat(43)}${i}`);
        expect(() => assertSolanaVetoUsable({ ...OK, resumeMembers: nine })).toThrow(
            /TooManyResumeMembers/,
        );
    });
});
