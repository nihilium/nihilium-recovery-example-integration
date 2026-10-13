/**
 * The recovery flow's state, in `useState` and nothing else.
 *
 * The SDK-facing work is `@nihilium/recovery-sdk`'s plain functions; this is the one file that turns
 * them into something React can render. Owned by `App` rather than by a panel, because the wallet's
 * protection badge and the recovery card read the same vault and must never disagree about it.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { SealRef } from "@nihilium/recovery-core";
import {
    canHandOverAny,
    checkHandovers,
    describeBlocked,
    exportSealFile,
    importSealFile,
    markSpent,
    nextVaultId,
    parseSealFile,
    recordHostUrlFor,
    recoverVault,
    refreshVaultFromHost,
    resealVault,
    sealVault,
    spentFromHandovers,
    submitHandovers,
    syncVaultToHost,
    toSealFile,
    type ChainReadiness,
    type RecoverVaultResult,
    type RecoveredChainKey,
    type SealFile,
    type VaultRecord,
} from "@nihilium/recovery-sdk";
import type { ChainModule, DerivedAccount } from "../integration/chains/types.js";
import type { MethodRegistry, Subject, SubjectPhase, SubjectPrompt } from "../integration/conditions/types.js";
import type { AppBindings } from "../wiring.js";
import { deriveWallet } from "./wallet.js";
import { destinationsFor } from "./destinations.js";
import { seedFingerprint } from "./seeds.js";

export type FlowPhase = "idle" | "sealing" | "sealed" | "recovering" | "recovered" | "failed";

/** Which operation a transcript line belongs to. */
export type LogChannel = "seal" | "recover";

export interface MemberView {
    index: number;
    label: string;
    phase: SubjectPhase;
}

export interface FlowState {
    phase: FlowPhase;
    /** Every vault this browser holds. */
    vaults: VaultRecord[];
    /** Which of those vaults this browser still holds the seal for. A ledger row with no seal is one whose only way in is the file. */
    seals: SealRef[];
    /** Held in memory only, and handed to the user as a download. Never written beside the record. */
    sealFile: SealFile | null;
    members: MemberView[];
    /** Keyed by member index: members run concurrently, so a shared slot loses one of two waits. */
    prompts: Record<number, SubjectPrompt>;
    /** One transcript per operation, never one shared array. */
    logs: Record<LogChannel, string[]>;
    /** Per vault: whether its records and chain contexts are on the record host. */
    hostSync: Record<string, { ok: boolean; message: string }>;
    error: string | null;
    result: {
        contacted: readonly number[];
        untouched: readonly number[];
        /** **Every chain the vault covers**, from one ceremony. Each entry carries its own `failure`. */
        keys: readonly RecoveredChainKey[];
        /** Chains whose intent never reached the relayer, so nothing is on-chain for them. */
        unsubmitted: readonly string[];
        spentReason: string;
    } | null;
}

const EMPTY: FlowState = {
    phase: "idle", vaults: [], seals: [], sealFile: null, members: [], prompts: {},
    logs: { seal: [], recover: [] }, hostSync: {}, error: null, result: null,
};

export function useRecoveryFlow(
    bindings: AppBindings,
    /** The whole registry, not one method: a recovery must run the method its vault was sealed with. */
    methods: MethodRegistry | null,
    chain: ChainModule,
    account: DerivedAccount | undefined,
    /** Which wallet is on screen — a seed fingerprint, never an address. */
    walletId: string,
) {
    const [state, setState] = useState<FlowState>(EMPTY);
    // The live recovery's keys, held outside React state so they can be zeroized without a re-render
    // and never cloned by one. Dropped by `forgetKey`.
    const [held, setHeld] = useState<RecoverVaultResult | null>(null);

    /** Push every live vault's records and chain contexts to its record host. Idempotent. */
    const syncToHost = useCallback(
        async (vaults: readonly VaultRecord[]) => {
            for (const vault of vaults) {
                if (vault.spent !== null) continue;
                const url = recordHostUrlFor(vault, bindings.recordHostUrl);
                let status: { ok: boolean; message: string };
                try {
                    const { appended } = await syncVaultToHost(bindings.deps.dataStore, bindings.recordHost(url), vault);
                    status = { ok: true, message: appended === 0 ? `replicated to ${url}` : `replicated to ${url} · ${appended} new` };
                } catch (error) {
                    status = { ok: false, message: `not replicated: ${messageOf(error)}` };
                }
                setState((prev) => ({ ...prev, hostSync: { ...prev.hostSync, [vault.vaultId]: status } }));
            }
        },
        [bindings],
    );

    const reload = useCallback(async () => {
        const [stored, seals, handovers] = await Promise.all([
            bindings.deps.ledger.list(),
            bindings.deps.sealStore.listSeals(),
            bindings.deps.handovers.list(),
        ]);
        // Vaults opened before the spent mark was saved at recovery time. A handover row proves the
        // vault opened, so they are marked and saved here — once, since a saved mark is never rewritten.
        const repaired = spentFromHandovers(stored, handovers);
        await Promise.all(repaired.map((vault) => bindings.deps.ledger.put(vault)));
        const fixed = new Map(repaired.map((vault) => [vault.vaultId, vault]));
        const vaults = stored.map((vault) => fixed.get(vault.vaultId) ?? vault);
        setState((prev) => ({ ...prev, vaults, seals, phase: prev.phase === "idle" && vaults.length > 0 ? "sealed" : prev.phase }));
        void syncToHost(vaults);
    }, [bindings, syncToHost]);

    useEffect(() => {
        // eslint-disable-next-line react/set-state-in-effect -- reads IndexedDB first; the write lands later
        void reload();
    }, [reload]);

    const note = useCallback((channel: LogChannel, line: string) => {
        setState((prev) => ({ ...prev, logs: { ...prev.logs, [channel]: [...prev.logs[channel], line] } }));
    }, []);
    const noteSeal = useCallback((line: string) => note("seal", line), [note]);
    const noteRecover = useCallback((line: string) => note("recover", line), [note]);

    /** The vault covering one chain. A vault covers the chains `addChain()` was called for, not all. */
    const vaultFor = useCallback(
        (chainId: string, forWalletId: string | undefined): VaultRecord | null => {
            if (forWalletId === undefined) return null;
            return state.vaults.find((vault) => vault.walletId === forWalletId && vault.chains.some((row) => row.chainId === chainId)) ?? null;
        },
        [state.vaults],
    );

    const active = vaultFor(chain.id, walletId);
    /** The vault this wallet holds, whether or not it covers the chain on screen. */
    const walletVault = state.vaults.find((row) => row.walletId === walletId) ?? null;
    const covers = active !== null;

    const runSeal = useCallback(
        async (methodId: string, subjects: readonly Subject[], threshold: number, replacing: VaultRecord | null, timelockSeconds: number) => {
            const method = methods?.get(methodId) ?? null;
            if (method === null || account === undefined) return;
            setState((prev) => ({ ...prev, phase: "sealing", error: null, logs: { ...prev.logs, seal: [] }, members: [] }));
            try {
                const params = {
                    gate: method,
                    subjects,
                    threshold,
                    chain,
                    account: { accountId: account.accountId, signerAddress: account.signer.address },
                    walletId,
                    vaultId: nextVaultId(account.accountId, state.vaults),
                    timelockSeconds,
                    // Written into the seal file: where a fresh device finds this vault's records.
                    recordHosts: [bindings.recordHostUrl],
                    onSubjectSealed: (event: { index: number; summary: string }) => noteSeal(`sealVault  #${event.index}  ${event.summary}`),
                    onProgress: noteSeal,
                };
                const { vault, seal: sealBlob } = replacing === null
                    ? await sealVault(bindings.deps, params)
                    : await resealVault(bindings.deps, { ...params, replacing: replacing.vaultId });
                noteSeal(`seal       recordId=${vault.recordId}`);
                noteSeal(`seal       ${vault.ceremonyMs} ms ceremony · ${vault.chains[0]?.writeMs ?? 0} ms addChain`);
                setState((prev) => ({
                    ...prev,
                    phase: "sealed",
                    vaults: [...prev.vaults.filter((row) => row.vaultId !== replacing?.vaultId), vault],
                    sealFile: toSealFile(vault, sealBlob),
                    result: null,
                }));
                void syncToHost([vault]);
            } catch (error) {
                setState((prev) => ({ ...prev, phase: "failed", error: messageOf(error) }));
            }
        },
        [account, bindings, chain, methods, noteSeal, state.vaults, syncToHost, walletId],
    );

    const seal = useCallback(
        (methodId: string, subjects: readonly Subject[], threshold: number, timelockSeconds: number) => runSeal(methodId, subjects, threshold, null, timelockSeconds),
        [runSeal],
    );
    /** A fresh paid ceremony under a new vaultId. The old gate stands until this one commits. */
    const reseal = useCallback(
        (methodId: string, subjects: readonly Subject[], threshold: number, timelockSeconds: number) => runSeal(methodId, subjects, threshold, active, timelockSeconds),
        [active, runSeal],
    );

    /** The vault as its record host knows it. A host that cannot be reached is not fatal. */
    const refreshFromHost = useCallback(
        async (vault: VaultRecord): Promise<{ vault: VaultRecord; note: string }> => {
            const url = recordHostUrlFor(vault, bindings.recordHostUrl);
            try {
                const pulled = await refreshVaultFromHost(bindings.deps, bindings.recordHost(url), vault);
                if (pulled.chainsAdded.length > 0 || pulled.recordsAdded > 0) await reload();
                return {
                    vault: pulled.vault,
                    note: `records    from ${url}: ${pulled.recordsAdded} new record${pulled.recordsAdded === 1 ? "" : "s"}` +
                        (pulled.chainsAdded.length > 0 ? `, chains added since the file: ${pulled.chainsAdded.join(", ")}` : ""),
                };
            } catch (error) {
                return { vault, note: `records    ${url} unreachable (${messageOf(error)}) — using what this device holds` };
            }
        },
        [bindings, reload],
    );

    /** What each chain would say to a handover, read before a ceremony. Free: a few RPC reads. */
    const checkHandover = useCallback(
        (vault: VaultRecord): Promise<ChainReadiness[]> => checkHandovers(bindings.deps, vault),
        [bindings],
    );

    const submit = useCallback(
        async (vault: VaultRecord, keys: readonly RecoveredChainKey[], ownerMnemonic: string) => {
            const owner = await deriveWallet(bindings.chains, ownerMnemonic);
            const signingKeys = destinationsFor(ownerMnemonic);
            return submitHandovers(bindings.deps, {
                vaultId: vault.vaultId,
                keys,
                ownerWalletId: seedFingerprint(ownerMnemonic),
                onProgress: noteRecover,
                destinationFor: (chainId) => {
                    // Two different addresses: `newOwner` is a plain key the destination seed can sign
                    // with; `sweepTo` is that seed's own protected account, where the value should end up.
                    const signing = signingKeys.find((row) => row.chainId === chainId);
                    const protectedAccount = owner.accounts[chainId]?.[0]?.address;
                    if (signing === undefined || protectedAccount === undefined) return null;
                    return { newOwner: signing.address, sweepTo: protectedAccount };
                },
            });
        },
        [bindings, noteRecover],
    );

    const recover = useCallback(
        async (given: VaultRecord, selected: readonly number[], ownerMnemonic: string) => {
            // The method the vault records, never "whatever is current".
            const method = methods?.get(given.gate.methodId) ?? null;
            if (method === null) return;

            // The host first: chains protected after the seal file was saved exist only there.
            const { vault, note: hostNote } = await refreshFromHost(given);

            // Checked again here, not only in the dialog: this is the last moment before anything is spent.
            const readiness = await checkHandover(vault);
            if (!canHandOverAny(readiness)) {
                const blocked = describeBlocked(readiness);
                setState((prev) => ({
                    ...prev, phase: "failed", result: null,
                    error: `Nothing was sent: no chain in this vault can be handed over on-chain, so a recovery would spend the vault for nothing. ${blocked.join(" ")}`,
                    logs: { ...prev.logs, recover: blocked.map((line) => `preflight  ${line}`) },
                }));
                return;
            }

            setState((prev) => ({
                ...prev, phase: "recovering", error: null, result: null,
                logs: { ...prev.logs, recover: [hostNote] },
                members: vault.gate.subjects.map((subject) => ({
                    index: subject.index, label: subject.label,
                    phase: selected.includes(subject.index) ? { kind: "requesting" as const, message: "asking this guardian" } : { kind: "idle" as const },
                })),
            }));

            const lastProgress = new Map<number, string>();
            try {
                const outcome = await recoverVault(bindings.deps, {
                    gate: method,
                    selected,
                    vault,
                    // `rawKey`: the demo shows the bytes that came out and signs the handover with them.
                    // A production wallet takes the capability instead and lets it zeroize itself.
                    mode: "rawKey",
                    ...(state.sealFile ? { seal: state.sealFile.seal } : {}),
                    onProgress: noteRecover,
                    onSubjectProgress: (index, message) => {
                        if (lastProgress.get(index) === message) return;
                        lastProgress.set(index, message);
                        noteRecover(`#${index}         ${message}`);
                    },
                    onSubjectPhase: (index, phase) =>
                        setState((prev) => ({ ...prev, members: prev.members.map((member) => (member.index === index ? { ...member, phase } : member)) })),
                    onSubjectPrompt: (index, prompt) =>
                        setState((prev) => {
                            const { [index]: _previous, ...rest } = prev.prompts;
                            return { ...prev, prompts: prompt === null ? rest : { ...rest, [index]: prompt } };
                        }),
                });

                noteRecover(`openRecords ${selected.length} shares combined · one ceremony for ${outcome.keys.length} chain${outcome.keys.length === 1 ? "" : "s"}`);
                for (const key of outcome.keys) {
                    noteRecover(key.failure === null
                        ? `recovered  ${key.chainId} ${key.chainRecord.algorithm} ${key.publicKeyHex}`
                        : `failed     ${key.chainId} ${key.failure}`);
                }
                if (outcome.spent === null) throw new Error("No chain in this vault could be opened. Each chain's reason is in the transcript.");
                const spentSeal = outcome.spent;
                const spent = { at: Date.now(), reason: spentSeal.reason };
                // Saved now, before anything below can fail.
                await markSpent(bindings.deps, vault.vaultId, spent);

                /**
                 * Submit every chain's intent **now**, while the keys are live, then wipe them. A
                 * signed intent authorises one handover to one named owner and is worth nothing else,
                 * so it is what gets stored — and `execute` needs no signature later.
                 */
                const submitted = await submit(vault, outcome.keys, ownerMnemonic);
                // Wiped only if every chain got its intent in: a chain whose submit failed has no
                // signed intent, the vault is already spent, and the keys are the only thing left
                // that could still move that account.
                const stuck = submitted.filter((record) => record.stage === "failed");
                const unsubmitted = stuck.map((record) => record.chainId);
                if (stuck.length === 0) {
                    outcome.wipe();
                    setHeld(null);
                } else {
                    setHeld(outcome);
                    noteRecover(`keys       held for ${stuck.length} chain${stuck.length === 1 ? "" : "s"} that did not submit — retry before closing, or the recovery is lost`);
                }
                noteRecover(`spent       ${spentSeal.reason}`);
                setState((prev) => ({
                    ...prev, phase: "recovered", prompts: {},
                    vaults: prev.vaults.map((row) => (row.vaultId === vault.vaultId ? { ...row, spent } : row)),
                    members: prev.members.map((member) => ({ ...member, phase: selected.includes(member.index) ? { kind: "done", message: "proof accepted" } : { kind: "idle" } })),
                    result: { contacted: outcome.contacted, untouched: outcome.untouched, keys: outcome.keys, unsubmitted, spentReason: spentSeal.reason },
                }));
            } catch (error) {
                setState((prev) => ({ ...prev, phase: "failed", prompts: {}, error: messageOf(error) }));
            }
        },
        [bindings, methods, noteRecover, checkHandover, refreshFromHost, state.sealFile, submit],
    );

    /** Drop the recovered keys. Called when the recovery dialog closes. */
    const forgetKey = useCallback(() => {
        held?.wipe();
        setHeld(null);
    }, [held]);

    /** The seal file for a vault as it stands now — every chain added since sealing included. */
    const exportSeal = useCallback((vault: VaultRecord): Promise<SealFile> => exportSealFile(bindings.deps, vault.vaultId), [bindings]);

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

    /** Try the chains that did not submit again, with the keys still in memory. */
    const retryHandover = useCallback(
        async (vault: VaultRecord, ownerMnemonic: string) => {
            const keys = state.result?.keys;
            if (keys === undefined || held === null) return;
            const stuck = keys.filter((key) => state.result?.unsubmitted.includes(key.chainId));
            const submitted = await submit(vault, stuck, ownerMnemonic);
            const stillStuck = submitted.filter((record) => record.stage === "failed").map((record) => record.chainId);
            if (stillStuck.length === 0) {
                held.wipe();
                setHeld(null);
                noteRecover("keys       every chain submitted; the recovered keys are wiped");
            }
            setState((prev) => (prev.result === null ? prev : { ...prev, result: { ...prev.result, unsubmitted: stillStuck } }));
            return submitted;
        },
        [held, noteRecover, state.result, submit],
    );

    /** Take a seal file the user picked, and reload so the vault appears in the list. */
    const importSeal = useCallback(
        async (text: string) => {
            const file = parseSealFile(text);
            const outcome = await importSealFile(bindings.deps, file);
            const { vault } = await refreshFromHost(outcome.vault);
            await reload();
            return { file, ...outcome, vault };
        },
        [bindings, reload, refreshFromHost],
    );

    const clearError = useCallback(() => {
        setState((prev) => (prev.error === null ? prev : { ...prev, error: null }));
    }, []);

    return useMemo(
        () => ({ state, active, vault: walletVault, covers, vaultFor, seal, reseal, recover, checkHandover, refreshFromHost, exportSeal, retryHandover, reload, importSeal, forgetKey, answerPrompt, clearError }),
        [state, active, walletVault, covers, vaultFor, seal, reseal, recover, checkHandover, refreshFromHost, exportSeal, retryHandover, reload, importSeal, forgetKey, answerPrompt, clearError],
    );
}

export type RecoveryFlow = ReturnType<typeof useRecoveryFlow>;

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
