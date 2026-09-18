/**
 * The recovery flow's state, in `useState` and nothing else.
 *
 * This is the only hook that wraps `integration/` logic, which is the arrangement CLAUDE.md asks
 * for: the SDK-facing code is plain functions, and exactly one file here turns them into something
 * React can render.
 *
 * It is owned by `App` rather than by a panel, because the wallet's protection badge and the recovery
 * card read the same vault and must never disagree about it.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ChainModule, DerivedAccount } from "../integration/chains/types.js";
import type {
    MethodRegistry,
    Subject,
    SubjectPhase,
    SubjectPrompt,
} from "../integration/conditions/types.js";
import { recoverVault, resealVault, sealVault } from "../integration/recovery/vault.js";
import { toSealFile, type SealFile } from "../integration/recovery/sealFile.js";
import { nextVaultId, type VaultRecord } from "../integration/recovery/vaultRecords.js";
import type { AppBindings } from "./bindings.js";

export type FlowPhase = "idle" | "sealing" | "sealed" | "recovering" | "recovered" | "failed";

export interface MemberView {
    index: number;
    label: string;
    phase: SubjectPhase;
    message?: string;
}

export interface FlowState {
    phase: FlowPhase;
    /** Every vault this browser holds. Auto-discard keeps it at one per account, not by assumption. */
    vaults: VaultRecord[];
    /** Held in memory only, and handed to the user as a download. Never written beside the record. */
    sealFile: SealFile | null;
    members: MemberView[];
    /**
     * Keyed by member index, never a single slot: members run concurrently, so a shared slot loses
     * one of two simultaneous waits.
     *
     * Empty against the live ceremony, and necessarily so — there is no button here that makes a
     * human answer their mail. A guardian's row sits in `awaiting-human` until they actually reply.
     */
    prompts: Record<number, SubjectPrompt>;
    log: string[];
    error: string | null;
    result: {
        contacted: readonly number[];
        untouched: readonly number[];
        publicKeyHex: string;
        spentReason: string;
    } | null;
}

const EMPTY: FlowState = {
    phase: "idle",
    vaults: [],
    sealFile: null,
    members: [],
    prompts: {},
    log: [],
    error: null,
    result: null,
};

export function useRecoveryFlow(
    bindings: AppBindings,
    /** The whole registry, not one method: a recovery must run the method its vault was sealed with. */
    methods: MethodRegistry | null,
    chain: ChainModule,
    account: DerivedAccount | undefined,
) {
    const [state, setState] = useState<FlowState>(EMPTY);

    // Whatever this browser already sealed, so a reload does not look like a fresh start.
    useEffect(() => {
        let live = true;
        void bindings.vaults.list().then((vaults) => {
            if (!live) return;
            setState((prev) => ({
                ...prev,
                vaults,
                phase: prev.phase === "idle" && vaults.length > 0 ? "sealed" : prev.phase,
            }));
        });
        return () => {
            live = false;
        };
    }, [bindings]);

    const note = useCallback((line: string) => {
        setState((prev) => ({ ...prev, log: [...prev.log, line] }));
    }, []);

    /** The vault covering one chain. A vault covers the chains `addChain()` was called for, not all. */
    const vaultFor = useCallback(
        (chainId: string): VaultRecord | null =>
            state.vaults.find((vault) => vault.chains.some((row) => row.chainId === chainId)) ?? null,
        [state.vaults],
    );

    const active = vaultFor(chain.id);

    const runSeal = useCallback(
        async (
            methodId: string,
            subjects: readonly Subject[],
            threshold: number,
            replacing: VaultRecord | null,
        ) => {
            const method = methods?.get(methodId) ?? null;
            if (method === null || account === undefined) return;
            setState((prev) => ({ ...prev, phase: "sealing", error: null, log: [], members: [] }));
            try {
                const params = {
                    method,
                    subjects,
                    threshold,
                    chain,
                    account,
                    vaultId: nextVaultId(account.accountId, state.vaults),
                    onSubjectSealed: (event: { index: number; summary: string }) =>
                        note(`sealVault  #${event.index}  ${event.summary}`),
                    onProgress: note,
                };
                const { vault, seal: sealBlob } =
                    replacing === null
                        ? await sealVault(bindings.stores, params)
                        : await resealVault(bindings.stores, {
                              ...params,
                              replacing: replacing.vaultId,
                          });
                note(`seal       recordId=${vault.recordId}`);
                note(`seal       ${vault.chains[0]?.writeMs ?? 0} ms · ${subjects.length} ceremonies`);
                setState((prev) => ({
                    ...prev,
                    phase: "sealed",
                    // The replaced vault is gone from storage by now; drop it here in the same step so
                    // the badge never shows a gate that no longer has a seal.
                    vaults: [
                        ...prev.vaults.filter((row) => row.vaultId !== replacing?.vaultId),
                        vault,
                    ],
                    sealFile: toSealFile(vault, sealBlob),
                    result: null,
                }));
            } catch (error) {
                setState((prev) => ({ ...prev, phase: "failed", error: messageOf(error) }));
            }
        },
        [account, bindings, chain, methods, note, state.vaults],
    );

    const seal = useCallback(
        (methodId: string, subjects: readonly Subject[], threshold: number) =>
            runSeal(methodId, subjects, threshold, null),
        [runSeal],
    );

    /** A fresh paid ceremony under a new vaultId. The old gate stands until this one commits. */
    const reseal = useCallback(
        (methodId: string, subjects: readonly Subject[], threshold: number) =>
            runSeal(methodId, subjects, threshold, active),
        [active, runSeal],
    );

    const recover = useCallback(
        async (selected: readonly number[]) => {
            const vault = active;
            const chainRecord = vault?.chains.find((row) => row.chainId === chain.id);
            // The method the vault records, never "whatever is current": a gate can only be opened
            // by the ceremony that built it, and the registry may well offer several.
            const method = vault === null ? null : (methods?.get(vault.gate.methodId) ?? null);
            if (vault === null || chainRecord === undefined || method === null) return;

            setState((prev) => ({
                ...prev,
                phase: "recovering",
                error: null,
                result: null,
                members: vault.gate.subjects.map((subject) => ({
                    index: subject.index,
                    label: subject.label,
                    phase: selected.includes(subject.index)
                        ? { kind: "requesting" as const, message: "asking this guardian" }
                        : { kind: "idle" as const },
                })),
            }));

            try {
                const outcome = await recoverVault(bindings.stores, {
                    method,
                    gate: vault.gate,
                    selected,
                    chain,
                    vault,
                    chainRecord,
                    ...(state.sealFile ? { seal: state.sealFile.seal } : {}),
                    onProgress: note,
                    onSubjectProgress: (index, message) =>
                        setState((prev) => ({
                            ...prev,
                            members: prev.members.map((member) =>
                                member.index === index ? { ...member, message } : member,
                            ),
                        })),
                    onSubjectPhase: (index, phase) =>
                        setState((prev) => ({
                            ...prev,
                            members: prev.members.map((member) =>
                                member.index === index ? { ...member, phase } : member,
                            ),
                        })),
                });

                const publicKeyHex =
                    outcome.authority.kind === "capability"
                        ? bytesToHexLocal(outcome.authority.capability.publicKey.bytes)
                        : "(raw key)";
                // Zeroized as soon as the demo is done with it: the capability is scoped, and the key
                // it holds is assembled — not never-assembled, whatever a marketing page might say.
                if (outcome.authority.kind === "capability") outcome.authority.capability.zeroize();

                note(`openRecords ${selected.length} shares combined`);
                const spent = { at: Date.now(), reason: outcome.spent.reason };
                setState((prev) => ({
                    ...prev,
                    phase: "recovered",
                    prompts: {},
                    vaults: prev.vaults.map((row) =>
                        row.vaultId === vault.vaultId ? { ...row, spent } : row,
                    ),
                    members: prev.members.map((member) => ({
                        ...member,
                        phase: selected.includes(member.index)
                            ? { kind: "done", message: "proof accepted" }
                            : { kind: "idle" },
                    })),
                    result: {
                        contacted: outcome.contacted,
                        untouched: outcome.untouched,
                        publicKeyHex,
                        spentReason: outcome.spent.reason,
                    },
                }));
            } catch (error) {
                setState((prev) => ({
                    ...prev,
                    phase: "failed",
                    prompts: {},
                    error: messageOf(error),
                }));
            }
        },
        [active, bindings, chain, methods, note, state.sealFile],
    );

    const answerPrompt = useCallback((index: number, accept: boolean) => {
        setState((prev) => {
            const prompt = prev.prompts[index];
            if (prompt === undefined) return prev;
            if (accept) prompt.resolve?.();
            else prompt.reject?.("this guardian never replied");
            const { [index]: _answered, ...rest } = prev.prompts;
            return { ...prev, prompts: rest };
        });
    }, []);

    const clearError = useCallback(() => {
        setState((prev) => (prev.error === null ? prev : { ...prev, error: null }));
    }, []);

    return useMemo(
        () => ({ state, active, vaultFor, seal, reseal, recover, answerPrompt, clearError }),
        [state, active, vaultFor, seal, reseal, recover, answerPrompt, clearError],
    );
}

export type RecoveryFlow = ReturnType<typeof useRecoveryFlow>;

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function bytesToHexLocal(bytes: Uint8Array): string {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
