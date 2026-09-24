/**
 * The k-of-n plumbing every quorum method shares: subjects in, a `QuorumConditionAdapter` and a
 * proof out.
 *
 * Nothing here is email-shaped. A method supplies its subject kinds; this file positions them,
 * builds the quorum, and translates between the app's 1-based slots and the SDK's Shamir indices —
 * which are the same number, and are kept that way deliberately.
 *
 * **To replace:** nothing, for any k-of-n gate. A method with a single indivisible identity (one
 * passport, no quorum) would call its adapter directly instead.
 * **Assumes:** `subjects[i]` is Shamir member `i + 1`, permanently. The seal records domains only,
 * so the ordered list the caller persists is the only way back from a chosen guardian to its share.
 */
import { QuorumConditionAdapter } from "@nihilium/recovery-condition-quorum";
import type { Condition, ConditionAdapter, ConditionProof } from "@nihilium/recovery-core";
import type {
    StoredSubject,
    Subject,
    SubjectHooks,
    SubjectKind,
    SubjectPhase,
    SubjectSealed,
} from "./types.js";

export interface QuorumPlumbingOptions {
    /** Resolves a subject's kind. A single-kind method returns the same one every time. */
    kindFor(subject: { kindId: string }): SubjectKind;
}

export function toStoredSubjects(subjects: readonly Subject[]): StoredSubject[] {
    return subjects.map((subject, position) => ({
        // 1-based, written rather than derived later: the index is load-bearing, and a value you can
        // compare against its position is a bug you can catch.
        index: position + 1,
        kindId: subject.kindId,
        id: subject.id,
        values: subject.values,
        label: subject.label,
        publicLabel: subject.publicLabel,
        ...(subject.placementDomain === undefined ? {} : { placementDomain: subject.placementDomain }),
    }));
}

export interface BuiltQuorum {
    adapter: QuorumConditionAdapter;
    condition: Condition;
    /** The quorum's own set id, from its descriptor. Needed to resume a paid, interrupted run. */
    setId: string;
}

export async function buildQuorumCondition(
    options: QuorumPlumbingOptions,
    params: {
        subjects: readonly Subject[];
        threshold: number;
        onSubjectSealed?(event: SubjectSealed): void;
        resumeFrom?: { setId: string; members: readonly SubjectSealed[] };
    },
): Promise<BuiltQuorum> {
    const members: ConditionAdapter[] = params.subjects.map((subject, position) =>
        options.kindFor(subject).adapterFor(subject, position + 1),
    );

    const adapter = new QuorumConditionAdapter({
        members,
        ...(params.onSubjectSealed === undefined
            ? {}
            : {
                  onMemberSealed: (member) =>
                      params.onSubjectSealed?.({
                          index: member.index,
                          conditionType: member.conditionType,
                          summary: member.summary,
                          seal: member.seal,
                      }),
              }),
        ...(params.resumeFrom === undefined
            ? {}
            : {
                  resumeFrom: {
                      setId: params.resumeFrom.setId,
                      members: params.resumeFrom.members.map((member) => ({
                          index: member.index,
                          conditionType: member.conditionType,
                          summary: member.summary,
                          seal: member.seal,
                      })),
                  },
              }),
    });

    const condition = await adapter.buildCondition({
        threshold: params.threshold,
        // Positional: entry i is handed to member adapter i, untouched.
        members: params.subjects.map((subject) => options.kindFor(subject).conditionParams(subject)),
    });

    return { adapter, condition, setId: setIdOf(condition) };
}

/**
 * The quorum for a gate that already exists, with no ceremony run.
 *
 * Constructing a `QuorumConditionAdapter` costs nothing — the money is spent in `sealVault`, which
 * this never calls. That is what makes `addChain()` free: encrypting another chain's record needs
 * only the vault's published public component, so a second or tenth chain joins an existing gate
 * without contacting a single guardian.
 */
export function buildQuorumAppendAdapter(
    options: QuorumPlumbingOptions,
    subjects: readonly StoredSubject[],
): QuorumConditionAdapter {
    return new QuorumConditionAdapter({
        members: subjects.map((subject) =>
            options.kindFor(subject).adapterFor(asSubject(subject), subject.index),
        ),
    });
}

export interface BuiltQuorumProof {
    adapter: QuorumConditionAdapter;
    proof: ConditionProof;
    contacted: number[];
    untouched: number[];
}

export async function buildQuorumProof(
    options: QuorumPlumbingOptions,
    params: {
        /** The full registered set, in order — the quorum must be rebuilt at the n it was sealed at. */
        subjects: readonly StoredSubject[];
        selected: readonly number[];
        hooksFor(index: number): SubjectHooks;
        onPhase?(index: number, phase: SubjectPhase): void;
    },
): Promise<BuiltQuorumProof> {
    const adapter = new QuorumConditionAdapter({
        members: params.subjects.map((subject) =>
            options.kindFor(subject).adapterFor(asSubject(subject), subject.index),
        ),
    });

    const selected = [...params.selected].sort((a, b) => a - b);
    const proof = await adapter.buildProof({
        members: selected.map((index) => {
            const subject = params.subjects.find((candidate) => candidate.index === index);
            if (subject === undefined) {
                throw new Error(`No guardian at index ${index} in a set of ${params.subjects.length}.`);
            }
            params.onPhase?.(index, { kind: "requesting", message: "asking this guardian" });
            return {
                index,
                params: options.kindFor(subject).proofParams(asSubject(subject), params.hooksFor(index)),
            };
        }),
    });

    return {
        adapter,
        proof,
        contacted: selected,
        // Shown as prominently as `contacted`: "never contacted" is the property a quorum is for.
        untouched: params.subjects.map((s) => s.index).filter((index) => !selected.includes(index)),
    };
}

export function asSubject(stored: StoredSubject): Subject {
    return {
        kindId: stored.kindId,
        id: stored.id,
        values: stored.values,
        label: stored.label,
        publicLabel: stored.publicLabel,
        ...(stored.placementDomain === undefined ? {} : { placementDomain: stored.placementDomain }),
    };
}

function setIdOf(condition: Condition): string {
    const setId = (condition.descriptor as { setId?: unknown } | undefined)?.setId;
    if (typeof setId !== "string" || setId === "") {
        throw new Error(
            "Quorum condition has no set id; an interrupted setup cannot resume.",
        );
    }
    return setId;
}
