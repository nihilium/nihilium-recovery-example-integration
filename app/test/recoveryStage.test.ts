/**
 * The state that used to be one word doing two jobs.
 *
 * `spent` means the vault was opened — every record decrypted, never reusable. It was also being
 * rendered as "Recovery completed", which is a different claim and a false one: opening the vault
 * happens on Nihilium, and at that moment nothing has reached the module and the account is still
 * controlled by whoever controlled it before.
 *
 * Every pair is enumerated here because the dangerous cell is easy to write by accident: a spent
 * vault with no on-chain attempt must read as *unfinished*, and anything that flips it to a
 * completion is a user who stops, believing an account changed hands that did not.
 */
import { describe, expect, it } from "vitest";
import type { VetoState } from "@nihilium/recovery-core";
import {
    isTerminalStage,
    stageOf,
    STAGE_LABELS,
    type RecoveryStage,
} from "../src/ui/recoveryHealth.js";
import type { VaultRecord } from "../src/integration/recovery/vaultRecords.js";

const open = { spent: null } as VaultRecord;
const spent = { spent: { at: 1, reason: "every record was decrypted" } } as VaultRecord;

describe("stageOf", () => {
    it("has nothing to say without a vault", () => {
        expect(stageOf({ vault: null, attempt: null, opening: false })).toBeNull();
        // Even mid-ceremony: there is no vault to be at a stage.
        expect(stageOf({ vault: null, attempt: null, opening: true })).toBeNull();
    });

    it("reports the ceremony while this browser is running it", () => {
        expect(stageOf({ vault: open, attempt: null, opening: true })).toBe("opening");
    });

    it("is idle with an unspent vault and no attempt", () => {
        expect(stageOf({ vault: open, attempt: null, opening: false })).toBe("none");
    });

    it("calls a spent vault with no on-chain attempt `vault-open`, not done", () => {
        // The cell this whole file exists for.
        const stage = stageOf({ vault: spent, attempt: null, opening: false });
        expect(stage).toBe("vault-open");
        expect(isTerminalStage(stage!)).toBe(false);
        expect(STAGE_LABELS[stage!]).toBe("Key recovered · not on-chain");
    });

    it("treats an unread chain the same as no attempt, never as progress", () => {
        // `undefined` is "not asked yet". Reading it as an attempt would invent on-chain state.
        expect(stageOf({ vault: spent, attempt: undefined, opening: false })).toBe("vault-open");
        expect(stageOf({ vault: open, attempt: undefined, opening: false })).toBe("none");
    });

    it.each([
        ["INITIATED", "initiated"],
        ["PAUSED", "paused"],
        ["EXECUTABLE", "executable"],
        ["EXECUTED", "executed"],
        ["ABORTED", "aborted"],
    ] as [VetoState, RecoveryStage][])("maps the chain's %s to %s", (attempt, expected) => {
        expect(stageOf({ vault: spent, attempt, opening: false })).toBe(expected);
        // The chain wins whether or not this browser opened the vault: it is the only party that can
        // report an attempt somebody else submitted.
        expect(stageOf({ vault: open, attempt, opening: false })).toBe(expected);
    });

    it("only calls executed and aborted terminal", () => {
        expect(isTerminalStage("executed")).toBe(true);
        expect(isTerminalStage("aborted")).toBe(true);
        for (const stage of ["none", "opening", "vault-open", "initiated", "paused", "executable"] as const) {
            expect(isTerminalStage(stage), stage).toBe(false);
        }
    });
});

describe("the labels", () => {
    it("never calls an off-chain recovery finished", () => {
        // "Recovery completed" over a `vault-open` was the original bug. Nothing below `executed`
        // may claim completion in any of its spellings.
        const finished = /\b(complete|completed|done|finished|recovered\b(?!\s·))/i;
        for (const [stage, label] of Object.entries(STAGE_LABELS)) {
            if (stage === "executed") continue;
            expect(finished.test(label), `${stage}: "${label}"`).toBe(false);
        }
    });

    it("gives every stage a label", () => {
        const stages: RecoveryStage[] = [
            "none",
            "opening",
            "vault-open",
            "initiated",
            "paused",
            "executable",
            "executed",
            "aborted",
        ];
        for (const stage of stages) expect(STAGE_LABELS[stage]).toBeTruthy();
    });
});
