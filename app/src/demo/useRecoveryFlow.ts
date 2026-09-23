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
import type { KeyAlgorithm } from "@nihilium/recovery-core";
import type { ChainModule, DerivedAccount } from "../integration/chains/types.js";
import type {
    MethodRegistry,
    Subject,
    SubjectPhase,
    SubjectPrompt,
} from "../integration/conditions/types.js";
import {

    recoverVault,
    resealVault,
    sealVault,
} from "../integration/recovery/vault.js";
import { toSealFile, type SealFile } from "../integration/recovery/sealFile.js";
import { nextVaultId, type VaultRecord } from "../integration/recovery/vaultRecords.js";
import type { AppBindings } from "./bindings.js";

export type FlowPhase = "idle" | "sealing" | "sealed" | "recovering" | "recovered" | "failed";

/** Which operation a transcript line belongs to. */
/**
 * Which operation a transcript line belongs to.
 *
 * No `addChain`: adding a chain is not something a user starts, it is the first half of protecting
 * one, so its lines belong beside the transaction they precede in the settlement transcript.
 */
export type LogChannel = "seal" | "recover";

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
    /**
     * One transcript per operation, never one shared array.
     *
     * It used to be shared, and the seal's lines were still on screen when the recover dialog
     * opened — a transcript is a report of *an operation*, so a line from a different one is not
     * stale decoration, it is the screen attributing work to something that did not do it.
     */
    logs: Record<LogChannel, string[]>;
    error: string | null;
    result: {
        contacted: readonly number[];
        untouched: readonly number[];
        algorithm: KeyAlgorithm;
        /** Derived in `recoverVault` with this chain's adapter, never re-derived by a caller. */
        publicKeyHex: string;
        /**
         * The private half, in `rawKey` mode. Held because the on-chain handover cannot be signed
         * without it — and shown, because a wallet that says "recovered" and displays nothing is
         * asking to be taken on trust.
         */
        material: Uint8Array | null;
        spentReason: string;
    } | null;
}

const EMPTY: FlowState = {
    phase: "idle",
    vaults: [],
    sealFile: null,
    members: [],
    prompts: {},
    logs: { seal: [], recover: [] },
    error: null,
    result: null,
};

export function useRecoveryFlow(
    bindings: AppBindings,
    /** The whole registry, not one method: a recovery must run the method its vault was sealed with. */
    methods: MethodRegistry | null,
    chain: ChainModule,
    account: DerivedAccount | undefined,
    /**
     * Which wallet is on screen — a seed fingerprint, never an address.
     *
     * Both lookups below key on it. A vault covers many chains whose protected accounts are
     * different kinds of thing — a smart account here, a program-owned vault on Solana — so an
     * address can only ever identify it on the chain it was sealed from. Keying on one made every
     * other chain read as "no recovery" and offer a second paid ceremony.
     */
    walletId: string,
) {
    const [state, setState] = useState<FlowState>(EMPTY);

    /**
     * Re-read the ledger.
     *
     * Exposed, not only run on mount, because this hook is no longer the only writer: protecting a
     * chain adds it to the vault, and `useSettlement` does that itself. Without being told, the
     * badge compares the chain's new recovery owner against the row it replaced and reads
     * "Protected by a replaced gate" forever.
     */
    const reload = useCallback(async () => {
        const vaults = await bindings.vaults.list();
        setState((prev) => ({
            ...prev,
            vaults,
            phase: prev.phase === "idle" && vaults.length > 0 ? "sealed" : prev.phase,
        }));
    }, [bindings]);

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

    const note = useCallback((channel: LogChannel, line: string) => {
        setState((prev) => ({
            ...prev,
            logs: { ...prev.logs, [channel]: [...prev.logs[channel], line] },
        }));
    }, []);

    // Bound per channel so they can be handed straight to an `onProgress` that takes a bare string,
    // and memoized so passing one does not re-run the effects that depend on it.
    const noteSeal = useCallback((line: string) => note("seal", line), [note]);
    const noteRecover = useCallback((line: string) => note("recover", line), [note]);

    /** The vault covering one chain. A vault covers the chains `addChain()` was called for, not all. */
    const vaultFor = useCallback(
        (chainId: string, forWalletId: string | undefined): VaultRecord | null => {
            if (forWalletId === undefined) return null;
            return (
                state.vaults.find(
                    (vault) =>
                        vault.walletId === forWalletId &&
                        vault.chains.some((row) => row.chainId === chainId),
                ) ?? null
            );
        },
        [state.vaults],
    );

    const active = vaultFor(chain.id, walletId);

    /**
     * The vault this wallet holds, whether or not it covers the chain on screen.
     *
     * The distinction matters and used to be missing: `vaultFor` answers "is *this chain* in a
     * vault", and switching to Solana therefore looked like having no recovery at all — offering a
     * second paid ceremony for a wallet that already had a perfectly good gate. One vault covers
     * every chain added to it; the fix is `addChain()`, which is free.
     */
    const vault =
        state.vaults.find((row) => row.walletId === walletId) ??
        // Nothing for this wallet. Not "the most recent vault" — that would show the previous
        // seed's gate against a wallet it does not protect.
        null;
    const covers = active !== null;

    const runSeal = useCallback(
        async (
            methodId: string,
            subjects: readonly Subject[],
            threshold: number,
            replacing: VaultRecord | null,
        ) => {
            const method = methods?.get(methodId) ?? null;
            if (method === null || account === undefined) return;
            setState((prev) => ({
                ...prev,
                phase: "sealing",
                error: null,
                logs: { ...prev.logs, seal: [] },
                members: [],
            }));
            try {
                const params = {
                    method,
                    subjects,
                    threshold,
                    chain,
                    account,
                    walletId,
                    vaultId: nextVaultId(account.accountId, state.vaults),
                    onSubjectSealed: (event: { index: number; summary: string }) =>
                        noteSeal(`sealVault  #${event.index}  ${event.summary}`),
                    onProgress: noteSeal,
                };
                const { vault, seal: sealBlob } =
                    replacing === null
                        ? await sealVault(bindings.stores, params)
                        : await resealVault(bindings.stores, {
                              ...params,
                              replacing: replacing.vaultId,
                          });
                noteSeal(`seal       recordId=${vault.recordId}`);
                noteSeal(`seal       ${vault.chains[0]?.writeMs ?? 0} ms · ${subjects.length} ceremonies`);
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
        [account, bindings, chain, methods, noteSeal, state.vaults, walletId],
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
                logs: { ...prev.logs, recover: [] },
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
                    onProgress: noteRecover,
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

                // The key is *assembled* — not never-assembled, whatever a marketing page might
                // say — and in `rawKey` mode this demo holds the bytes so it can show them and sign
                // the on-chain handover with them. They live until `forgetKey()` or a reload; there
                // is no zeroizing scope in this mode, which is the cost of being able to look.
                const material =
                    outcome.authority.kind === "rawKey" ? outcome.authority.material : null;

                noteRecover(`openRecords ${selected.length} shares combined`);
                noteRecover(`recovered  ${chainRecord.algorithm} ${outcome.publicKeyHex}`);
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
                        algorithm: chainRecord.algorithm,
                        publicKeyHex: outcome.publicKeyHex,
                        material,
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
        [active, bindings, chain, methods, noteRecover, state.sealFile],
    );

    /**
     * Drop the recovered private key.
     *
     * Called when the recovery dialog closes. It cannot undo the exposure — the bytes have been in
     * JS memory and may sit in a heap snapshot — but a key still reachable from app state after the
     * screen that needed it has gone is a key nobody is thinking about any more.
     */
    const forgetKey = useCallback(() => {
        setState((prev) => {
            if (prev.result?.material == null) return prev;
            prev.result.material.fill(0);
            return { ...prev, result: { ...prev.result, material: null } };
        });
    }, []);

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
        () => ({ state, active, vault, covers, vaultFor, seal, reseal, recover, reload, forgetKey, answerPrompt, clearError }),
        [state, active, vault, covers, vaultFor, seal, reseal, recover, reload, forgetKey, answerPrompt, clearError],
    );
}

export type RecoveryFlow = ReturnType<typeof useRecoveryFlow>;

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
