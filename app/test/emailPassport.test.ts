/**
 * The email-and-passport method, without a ceremony.
 *
 * The fused adapter's own suite covers the cryptography; what lives in this repo is the translation
 * around it — what a user may type, what the stored gate says, that adding a chain buys nothing, and
 * the scan loop that turns `onPassportRequest` into a prompt a person can act on and retry. Those are
 * exercised here against a stub adapter and a fake prover, so nothing is paid and nothing is scanned.
 */
import { describe, expect, it, vi } from "vitest";
import type { Condition, ConditionAdapter, ConditionProof } from "@nihilium/recovery-core";
import type { PassportVerifierParameters } from "@nihilium/recovery-condition-zkpassport";
import { createEmailPassportMethod } from "../src/integration/conditions/emailPassport.js";
import { createEmailPassportSubjectKind } from "../src/integration/conditions/subjects/emailPassport.js";
import type {
    PassportProveEvents,
    PassportProver,
    PassportRequest,
} from "../src/integration/conditions/passport/zkPassportProver.js";
import type { Subject, SubjectPrompt } from "../src/integration/conditions/types.js";

const PROOF: PassportVerifierParameters = {
    proofVerificationData: { vkeyHash: "0x01", proof: "0x02", publicInputs: [] },
};

const REQUEST: PassportRequest = {
    birthdate: "1990-05-04",
    firstname: "Ada",
    lastname: "Lovelace",
    customData: "0xabc",
};

/** A prover whose every call waits for the test to settle it. */
function fakeProver() {
    const calls: {
        events: PassportProveEvents;
        signal: AbortSignal | undefined;
        resolve(proof: PassportVerifierParameters): void;
        reject(error: Error): void;
    }[] = [];
    const prover: PassportProver = {
        prove: (_request, events, signal) =>
            new Promise((resolve, reject) => {
                calls.push({ events, signal, resolve, reject });
                events.onLink(`zkpassport://request/${calls.length}`);
                events.onStatus("waiting");
            }),
    };
    return { prover, calls };
}

/** Records what the method hands it; never runs a ceremony. */
function stubAdapter() {
    const built: unknown[] = [];
    const proofs: Record<string, unknown>[] = [];
    const adapter = {
        conditionType: "zkemail+zkpassport",
        resolver: {},
        buildCondition: vi.fn(async (params: unknown) => {
            built.push(params);
            return { summary: "Recovery email at example.com and a passport" } as unknown as Condition;
        }),
        buildProof: vi.fn(async (params: Record<string, unknown>) => {
            proofs.push(params);
            return {} as ConditionProof;
        }),
    } as unknown as ConditionAdapter;
    return { adapter, built, proofs };
}

function setup() {
    const { prover, calls } = fakeProver();
    const stub = stubAdapter();
    const kind = createEmailPassportSubjectKind({ adapterFor: () => stub.adapter, prover });
    const method = createEmailPassportMethod({ kind, mode: "live", paid: true });
    return { kind, method, calls, ...stub };
}

function parsed(values: Record<string, string>): Subject {
    const { kind } = setup();
    const result = kind.parse({ kindId: kind.id, values });
    if (!result.ok) throw new Error(result.issues.map((issue) => issue.message).join(" "));
    return result.subject;
}

const VALID = { email: "Ada@Example.com ", firstname: " Ada ", lastname: "Lovelace", birthdate: "1990-05-04" };

describe("the email-and-passport subject", () => {
    it("normalizes what it keeps", () => {
        const subject = parsed(VALID);
        expect(subject.id).toBe("ada@example.com");
        expect(subject.values).toEqual({
            email: "ada@example.com",
            firstname: "Ada",
            lastname: "Lovelace",
            birthdate: "1990-05-04",
        });
        expect(subject.placementDomain).toBe("example.com");
    });

    it("keeps the name and the date of birth out of the label that gets logged", () => {
        const subject = parsed(VALID);
        expect(subject.publicLabel).toBe("an address at example.com and a passport");
        expect(subject.publicLabel).not.toMatch(/Ada|Lovelace|1990/);
    });

    it("refuses a gate that could never be opened", () => {
        const { kind } = setup();
        const issuesFor = (values: Record<string, string>) => {
            const result = kind.parse({ kindId: kind.id, values });
            return result.ok ? [] : result.issues.map((issue) => issue.field);
        };
        // ZKPassport reads 1970-01-01 as "no bound": sealing it would let any passport through.
        expect(issuesFor({ ...VALID, birthdate: "1970-01-01" })).toEqual(["birthdate"]);
        // One name missing and the commitment silently drops the name; no scan would ever match.
        expect(issuesFor({ ...VALID, lastname: "  " })).toEqual(["lastname"]);
        expect(issuesFor({ ...VALID, email: "not-an-address" })).toEqual(["email"]);
    });
});

describe("the email-and-passport method", () => {
    it("seals exactly one identity, and records it as slot 1", async () => {
        const { method, built } = setup();
        const subject = parsed(VALID);

        expect(method.checkGate({ subjects: [subject, subject], threshold: 1 })).not.toEqual([]);

        const setupResult = await method.createSetup({ subjects: [subject], threshold: 1 });
        expect(built).toEqual([
            { email: "ada@example.com", firstname: "Ada", lastname: "Lovelace", birthdate: "1990-05-04" },
        ]);
        expect(setupResult.gate).toMatchObject({
            methodId: "email-zkpassport",
            threshold: 1,
            subjectCount: 1,
            mode: "live",
        });
        expect(setupResult.gate.subjects.map((stored) => stored.index)).toEqual([1]);
        expect(setupResult.gate.setId).not.toBe("");
    });

    it("adds a chain without running anything", async () => {
        const { method, adapter } = setup();
        const { gate } = await method.createSetup({ subjects: [parsed(VALID)], threshold: 1 });
        vi.mocked(adapter.buildCondition).mockClear();

        expect(method.appendAdapter({ ...gate, summary: "" })).toBe(adapter);
        expect(adapter.buildCondition).not.toHaveBeenCalled();
        expect(adapter.buildProof).not.toHaveBeenCalled();
    });

    it("refuses a vault sealed in the other mode before contacting anyone", async () => {
        const { method, adapter } = setup();
        const { gate } = await method.createSetup({ subjects: [parsed(VALID)], threshold: 1 });
        await expect(
            method.createRecovery({ gate: { ...gate, mode: "simulated", summary: "" }, selected: [1] }),
        ).rejects.toThrow(/simulated mode/);
        expect(adapter.buildProof).not.toHaveBeenCalled();
    });
});

describe("the passport scan during a recovery", () => {
    async function recovering() {
        const context = setup();
        const { gate } = await context.method.createSetup({ subjects: [parsed(VALID)], threshold: 1 });
        const prompts: (SubjectPrompt | null)[] = [];
        const phases: string[] = [];
        await context.method.createRecovery({
            gate: { ...gate, summary: "" },
            selected: [1],
            onSubjectPrompt: (index, prompt) => {
                expect(index).toBe(1);
                prompts.push(prompt);
            },
            onSubjectPhase: (_index, phase) => phases.push(phase.kind),
        });
        const params = context.proofs[0]!;
        return { ...context, params, prompts, phases };
    }

    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
    const last = (prompts: (SubjectPrompt | null)[]) => prompts[prompts.length - 1];

    it("hands the adapter the address and reports its waits as waits on a person", async () => {
        const { params, phases } = await recovering();
        expect(params["email"]).toBe("ada@example.com");
        (params["onPhase"] as (phase: string) => void)("awaiting_passport_proof");
        expect(phases).toContain("awaiting-human");
    });

    it("shows a link, survives a mismatch with a retry, and clears once a proof is accepted", async () => {
        const { params, prompts, calls } = await recovering();
        const submit = vi
            .fn<(proof: PassportVerifierParameters) => Promise<void>>()
            .mockRejectedValueOnce(new Error("Passport data does not match this vault."))
            .mockResolvedValueOnce(undefined);

        (params["onPassportRequest"] as (r: PassportRequest, s: typeof submit) => void)(REQUEST, submit);
        await flush();

        expect(last(prompts)?.link?.url).toBe("zkpassport://request/1");
        expect(last(prompts)?.retry).toBeTypeOf("function");

        calls[0]!.resolve(PROOF);
        await flush();
        expect(submit).toHaveBeenCalledWith(PROOF);
        // A mismatch is not the end: the adapter keeps waiting, so the prompt stays with the reason.
        expect(last(prompts)?.error).toMatch(/does not match/);

        last(prompts)!.retry!();
        await flush();
        expect(calls).toHaveLength(2);
        expect(last(prompts)?.link?.url).toBe("zkpassport://request/2");

        calls[1]!.resolve(PROOF);
        await flush();
        expect(submit).toHaveBeenCalledTimes(2);
        expect(last(prompts)).toBeNull();
    });

    it("cancels the request a retry replaces, and ignores anything it says afterwards", async () => {
        const { params, prompts, calls } = await recovering();
        const submit = vi.fn(async (_proof: PassportVerifierParameters) => {});
        (params["onPassportRequest"] as (r: PassportRequest, s: typeof submit) => void)(REQUEST, submit);
        await flush();

        last(prompts)!.retry!();
        await flush();
        expect(calls[0]!.signal?.aborted).toBe(true);

        // The superseded request settling late must not submit, nor overwrite the live prompt.
        calls[0]!.resolve(PROOF);
        await flush();
        expect(submit).not.toHaveBeenCalled();
        expect(last(prompts)?.link?.url).toBe("zkpassport://request/2");
    });
});
