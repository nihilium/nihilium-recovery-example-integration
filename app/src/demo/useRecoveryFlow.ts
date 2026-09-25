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
import {
    exportSealFile,
    importSealFile,
    refreshVaultFromHost,
    resealVault,
    sealVault,
} from "../integration/recovery/vault.js";
import { recordHostUrlFor, syncVaultToHost } from "../integration/recovery/recordHost.js";
import {
    recoverAllChains,
    type RecoveredChainKey,
} from "../integration/recovery/recoverAll.js";
import { parseSealFile, toSealFile, type SealFile } from "../integration/recovery/sealFile.js";
import { nextVaultId, type VaultRecord } from "../integration/recovery/vaultRecords.js";
import type { SealRef } from "@nihilium/recovery-core";
import type { AppBindings } from "./bindings.js";
import { deriveWallet } from "./wallet.js";
import { destinationsFor } from "./destinations.js";
import { seedFingerprint } from "./seeds.js";
import { submitAll } from "../integration/recovery/handover/run.js";
import {
    canHandOverAny,
    checkHandovers,
    describeBlocked,
    type ChainReadiness,
} from "../integration/recovery/handover/preflight.js";
import { spentFromHandovers } from "../integration/recovery/handovers.js";
import { handoverFor } from "./handoverRegistry.js";

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
}

export interface FlowState {
    phase: FlowPhase;
    /** Every vault this browser holds. Auto-discard keeps it at one per account, not by assumption. */
    vaults: VaultRecord[];
    /**
     * Which of those vaults this browser still holds the seal for.
     *
     * Read alongside the vaults because the two can disagree, and the disagreement is the state a
     * user most needs told: records are inert and duplicable, the seal is not, so a vault with a
     * ledger row and no seal is one whose only way in is the file handed over at seal time.
     */
    seals: SealRef[];
    /** Held in memory only, and handed to the user as a download. Never written beside the record. */
    sealFile: SealFile | null;
    members: MemberView[];
    /**
     * Keyed by member index, never a single slot: members run concurrently, so a shared slot loses
     * one of two simultaneous waits.
     *
     * Against the live ceremony a prompt never carries `resolve` — there is no button here that
     * makes a human answer their mail. What it may carry is a `link`: a passport scan the human has
     * to open on their phone, which the dialog renders as a QR code.
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
    /**
     * Per vault: whether its records and chain contexts are on the record host. Reported rather than
     * assumed — records belong everywhere, and a host that silently missed one is a recovery that
     * silently misses a chain.
     */
    hostSync: Record<string, { ok: boolean; message: string }>;
    error: string | null;
    result: {
        contacted: readonly number[];
        untouched: readonly number[];
        /**
         * **Every chain the vault covers**, from one ceremony.
         *
         * A list rather than one key, because a vault is one gate over many chains and recovering
         * them one at a time would email the guardians once per chain. Each entry carries its own
         * `failure`, so a chain this build cannot derive does not cost the others their keys.
         */
        keys: readonly RecoveredChainKey[];
        /** How many times the guardians were actually asked. One, whatever the chain count. */
        ceremonies: number;
        /**
         * Chains whose intent never reached the relayer, so nothing is on-chain for them.
         *
         * Recorded rather than inferred from whether a key is still held: `wipe()` zeroes the bytes
         * in place and leaves the array, so "material is not null" stayed true after a perfectly
         * successful recovery — and the retry button it drove never went away.
         */
        unsubmitted: readonly string[];
        spentReason: string;
    } | null;
}

const EMPTY: FlowState = {
    phase: "idle",
    vaults: [],
    seals: [],
    sealFile: null,
    members: [],
    prompts: {},
    logs: { seal: [], recover: [] },
    hostSync: {},
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
    /**
     * Push every live vault's records and chain contexts to its record host. Idempotent: it appends
     * only what the host lacks, so it runs after every reload, and a host that was down catches up.
     */
    const syncToHost = useCallback(
        async (vaults: readonly VaultRecord[]) => {
            for (const vault of vaults) {
                if (vault.spent !== null) continue;
                const url = recordHostUrlFor(vault, bindings.recordHostUrl);
                let status: { ok: boolean; message: string };
                try {
                    const { appended } = await syncVaultToHost(
                        bindings.stores.dataStore,
                        bindings.recordHost(url),
                        vault,
                    );
                    status = {
                        ok: true,
                        message:
                            appended === 0
                                ? `replicated to ${url}`
                                : `replicated to ${url} · ${appended} new`,
                    };
                } catch (error) {
                    status = { ok: false, message: `not replicated: ${messageOf(error)}` };
                }
                setState((prev) => ({
                    ...prev,
                    hostSync: { ...prev.hostSync, [vault.vaultId]: status },
                }));
            }
        },
        [bindings],
    );

    const reload = useCallback(async () => {
        const [stored, seals, handovers] = await Promise.all([
            bindings.vaults.list(),
            bindings.stores.sealStore.listSeals(),
            bindings.handovers.list(),
        ]);
        // Vaults opened before the spent mark was saved at recovery time. A handover row proves the
        // vault opened, so they are marked and saved here — once, since a saved mark is never
        // rewritten. See `spentFromHandovers`.
        const repaired = spentFromHandovers(stored, handovers);
        await Promise.all(repaired.map((vault) => bindings.vaults.put(vault)));
        const fixed = new Map(repaired.map((vault) => [vault.vaultId, vault]));
        const vaults = stored.map((vault) => fixed.get(vault.vaultId) ?? vault);
        setState((prev) => ({
            ...prev,
            vaults,
            seals,
            phase: prev.phase === "idle" && vaults.length > 0 ? "sealed" : prev.phase,
        }));
        // After every reload, which is after every seal, protect and import: whatever changed here
        // reaches the host without each caller having to remember to send it.
        void syncToHost(vaults);
    }, [bindings, syncToHost]);

    // Whatever this browser already sealed, so a reload does not look like a fresh start.
    useEffect(() => {
        // No `live` guard: `reload` merges into state rather than replacing it, so a late resolve
        // after a remount writes the same rows it would have written anyway.
        //
        // The rule reads `reload` as a synchronous setState; it is not — it awaits two store reads
        // first, so the write always lands in a later tick. Reading IndexedDB is exactly the
        // "synchronising with an external system" the rule exempts.
        // eslint-disable-next-line react/set-state-in-effect
        void reload();
    }, [reload]);

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
    const walletVault =
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
            timelockSeconds: number,
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
                    timelockSeconds,
                    // Written into the seal file: where a fresh device finds this vault's records,
                    // including every chain added after the file was saved.
                    recordHosts: [bindings.recordHostUrl],
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
                    // The seal and the instructions; the records go to the host, below.
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
        (methodId: string, subjects: readonly Subject[], threshold: number, timelockSeconds: number) =>
            runSeal(methodId, subjects, threshold, null, timelockSeconds),
        [runSeal],
    );

    /** A fresh paid ceremony under a new vaultId. The old gate stands until this one commits. */
    const reseal = useCallback(
        (methodId: string, subjects: readonly Subject[], threshold: number, timelockSeconds: number) =>
            runSeal(methodId, subjects, threshold, active, timelockSeconds),
        [active, runSeal],
    );


    /**
     * The vault as its record host knows it: records pulled into this device, and every chain the
     * host holds a context for — including chains protected after the seal file was saved.
     *
     * A host that cannot be reached is not fatal. The vault comes back as this device knows it, and
     * the caller says so: recovering fewer chains than the vault holds is a fact the user must see.
     */
    const refreshFromHost = useCallback(
        async (vault: VaultRecord): Promise<{ vault: VaultRecord; note: string }> => {
            const url = recordHostUrlFor(vault, bindings.recordHostUrl);
            try {
                const pulled = await refreshVaultFromHost(
                    bindings.stores,
                    bindings.recordHost(url),
                    vault,
                );
                if (pulled.chainsAdded.length > 0 || pulled.recordsAdded > 0) await reload();
                return {
                    vault: pulled.vault,
                    note:
                        `records    from ${url}: ${pulled.recordsAdded} new record` +
                        `${pulled.recordsAdded === 1 ? "" : "s"}` +
                        (pulled.chainsAdded.length > 0
                            ? `, chains added since the file: ${pulled.chainsAdded.join(", ")}`
                            : ""),
                };
            } catch (error) {
                return {
                    vault,
                    note: `records    ${url} unreachable (${messageOf(error)}) — using what this device holds`,
                };
            }
        },
        [bindings, reload],
    );

    /**
     * What each chain would say to a handover, read before a ceremony. Free: a few RPC reads.
     *
     * Takes the vault rather than the active wallet's, for the same reason `recover` does: the vault
     * being recovered usually belongs to a seed this browser no longer holds.
     */
    const checkHandover = useCallback(
        (vault: VaultRecord): Promise<ChainReadiness[]> =>
            checkHandovers({ handoverFor: (chainId) => handoverFor(bindings, chainId) }, vault.chains),
        [bindings],
    );

    const recover = useCallback(
        async (
            given: VaultRecord,
            selected: readonly number[],
            /**
             * The seed control is handed to. Its keys sign nothing here — they are the *destination*
             * — but the intents submitted below name them, so it has to be decided before the
             * ceremony rather than after.
             */
            ownerMnemonic: string,
        ) => {
            // The vault is a **parameter**, not "the active wallet's". Recovery is for the case
            // where the seed is gone, so the vault being opened usually belongs to a wallet this
            // browser can no longer derive — and reading it off the active seed made exactly that
            // vault unreachable. See `recoveryCatalogue.ts`.
            //
            // The method the vault records, never "whatever is current": a gate can only be opened
            // by the ceremony that built it, and the registry may well offer several.
            const method = methods?.get(given.gate.methodId) ?? null;
            if (method === null) return;

            // The host first: chains protected after the seal file was saved exist only there, and
            // both the check below and the recovery after it must see them.
            const { vault, note: hostNote } = await refreshFromHost(given);

            // Checked again here, not only in the dialog: the dialog's answer can be minutes old,
            // and this is the last moment before anything is sent, paid for or spent.
            const readiness = await checkHandover(vault);
            if (!canHandOverAny(readiness)) {
                const blocked = describeBlocked(readiness);
                setState((prev) => ({
                    ...prev,
                    phase: "failed",
                    result: null,
                    error:
                        "Nothing was sent: no chain in this vault can be handed over on-chain, so a " +
                        `recovery would spend the vault for nothing. ${blocked.join(" ")}`,
                    logs: { ...prev.logs, recover: blocked.map((line) => `preflight  ${line}`) },
                }));
                return;
            }

            setState((prev) => ({
                ...prev,
                phase: "recovering",
                error: null,
                result: null,
                logs: { ...prev.logs, recover: [hostNote] },
                members: vault.gate.subjects.map((subject) => ({
                    index: subject.index,
                    label: subject.label,
                    phase: selected.includes(subject.index)
                        ? { kind: "requesting" as const, message: "asking this guardian" }
                        : { kind: "idle" as const },
                })),
            }));

            const lastProgress = new Map<number, string>();
            try {
                const outcome = await recoverAllChains(bindings.stores, {
                    method,
                    gate: vault.gate,
                    selected,
                    vault,
                    chains: bindings.chains,
                    ...(state.sealFile ? { seal: state.sealFile.seal } : {}),
                    onProgress: noteRecover,
                    // The adapter's own running commentary goes to the transcript, not the row: the
                    // row says what the app knows (the phase), and two voices describing one wait
                    // read as two different things happening. Only changes are logged, because an
                    // adapter that polls reports the same line every few seconds.
                    onSubjectProgress: (index, message) => {
                        if (lastProgress.get(index) === message) return;
                        lastProgress.set(index, message);
                        noteRecover(`#${index}         ${message}`);
                    },
                    onSubjectPhase: (index, phase) =>
                        setState((prev) => ({
                            ...prev,
                            members: prev.members.map((member) =>
                                member.index === index ? { ...member, phase } : member,
                            ),
                        })),
                    onSubjectPrompt: (index, prompt) =>
                        setState((prev) => {
                            const { [index]: _previous, ...rest } = prev.prompts;
                            return { ...prev, prompts: prompt === null ? rest : { ...rest, [index]: prompt } };
                        }),
                });

                // The keys are *assembled* — not never-assembled, whatever a marketing page might
                // say — and in `rawKey` mode this demo holds the bytes so it can show them and sign
                // the on-chain handover with them. They live until `forgetKey()` or a reload; there
                // is no zeroizing scope in this mode, which is the cost of being able to look.
                noteRecover(`openRecords ${selected.length} shares combined`);
                // The line this whole change exists to be able to print.
                noteRecover(
                    `ceremony   ${outcome.ceremonies} for ${outcome.keys.length} chain` +
                        `${outcome.keys.length === 1 ? "" : "s"}`,
                );
                for (const key of outcome.keys) {
                    noteRecover(
                        key.failure === null
                            ? `recovered  ${key.chainId} ${key.chainRecord.algorithm} ${key.publicKeyHex}`
                            : `failed     ${key.chainId} ${key.failure}`,
                    );
                }
                if (outcome.spent === null) {
                    throw new Error(
                        "No chain in this vault could be opened. Each chain's reason is in the transcript.",
                    );
                }
                const spentSeal = outcome.spent;
                const spent = { at: Date.now(), reason: spentSeal.reason };
                // Saved now, before anything below can fail. It used to live only in React state, so
                // the next reload read the vault as unspent and its seed as "recovery ready".
                await bindings.vaults.put({
                    ...((await bindings.vaults.get(vault.vaultId)) ?? vault),
                    spent,
                });

                /**
                 * Submit every chain's intent **now**, while the keys are live, then wipe them.
                 *
                 * This is the only step that needs them. A timelock can outlast the session, and
                 * the two alternatives are both bad: hold the keys open and a closed tab costs the
                 * recovery, or write them to disk and the demo does the one thing §12 forbids. A
                 * signed intent authorises one handover to one named owner and is worth nothing
                 * else, so it is what gets stored — and `executeRecovery` needs no signature later,
                 * because by then the timelock is the authority.
                 *
                 * It matters more than it sounds: the vault is spent the moment it opened, so a
                 * recovery that loses its keys mid-timelock cannot be redone without paying again.
                 */
                const owner = await deriveWallet(bindings.chains, ownerMnemonic);
                const signingKeys = destinationsFor(ownerMnemonic);
                const submitted = await submitAll(
                    {
                        chains: bindings.chains,
                        store: bindings.handovers,
                        handoverFor: (chainId) => handoverFor(bindings, chainId),
                        serverUrl: bindings.env.serverUrl,
                        onProgress: noteRecover,
                    },
                    {
                        vaultId: vault.vaultId,
                        keys: outcome.keys,
                        ownerWalletId: seedFingerprint(ownerMnemonic),
                        destinationFor: (chainId) => {
                            // Two different addresses, and conflating them is the bug. `newOwner`
                            // is a plain key the destination seed can sign with, because the
                            // account has to answer to *something*. `sweepTo` is that seed's own
                            // protected account, which is where the value should end up.
                            const signing = signingKeys.find((row) => row.chainId === chainId);
                            const protectedAccount = owner.accounts[chainId]?.[0]?.address;
                            if (signing === undefined || protectedAccount === undefined) return null;
                            return { newOwner: signing.address, sweepTo: protectedAccount };
                        },
                    },
                );
                /**
                 * Wiped only if every chain got its intent in.
                 *
                 * This is the one place where tidiness and correctness point opposite ways. The
                 * keys should not outlive their use — but a chain whose submit failed has no signed
                 * intent, and the vault is already spent, so wiping now would destroy the only
                 * thing that could still move that account. There is no second ceremony to fall
                 * back on: `recover()` marked the vault spent before this line ran.
                 *
                 * So a failure keeps them, in memory, until the user retries or closes the dialog —
                 * and the dialog says so, rather than leaving a wiped key looking like a transient
                 * network error.
                 */
                const stuck = submitted.filter((record) => record.stage === "failed");
                const unsubmitted = stuck.map((record) => record.chainId);
                if (stuck.length === 0) {
                    outcome.wipe();
                } else {
                    noteRecover(
                        `keys       held for ${stuck.length} chain${stuck.length === 1 ? "" : "s"} ` +
                            "that did not submit — retry before closing, or the recovery is lost",
                    );
                }
                // The SDK's own statement of what this recovery cost, verbatim, in the transcript. The
                // dialog shows a short status line instead; this keeps the full sentence reported.
                noteRecover(`spent       ${spentSeal.reason}`);
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
                        keys: outcome.keys,
                        ceremonies: outcome.ceremonies,
                        unsubmitted,
                        spentReason: spentSeal.reason,
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
        [bindings, methods, noteRecover, checkHandover, refreshFromHost, state.sealFile],
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
            if (prev.result === null) return prev;
            // Every chain's, not the one on screen. A recovery now yields a key per chain, and
            // dropping only the visible one would leave the rest reachable from app state.
            for (const key of prev.result.keys) key.material?.fill(0);
            return {
                ...prev,
                result: {
                    ...prev.result,
                    keys: prev.result.keys.map((key) => ({ ...key, material: null })),
                },
            };
        });
    }, []);

    /**
     * The seal file for a vault as it stands now — every chain added since sealing included. The
     * copy in `state.sealFile` is the one taken at sealing, and is only right until the first
     * `addChain()`.
     */
    const exportSeal = useCallback(
        (vault: VaultRecord): Promise<SealFile> => exportSealFile(bindings.stores, vault.vaultId),
        [bindings],
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

    /**
     * Try the chains that did not submit again, with the keys still in memory.
     *
     * The only path back from a relayer that was down at exactly the wrong moment. It needs the keys
     * and therefore this session — which is why `recover` keeps them when a submit fails, and why
     * the dialog cannot be closed past a failure without saying what closing costs.
     */
    const retryHandover = useCallback(
        async (vault: VaultRecord, ownerMnemonic: string) => {
            const keys = state.result?.keys;
            if (keys === undefined) return;
            const owner = await deriveWallet(bindings.chains, ownerMnemonic);
            const signingKeys = destinationsFor(ownerMnemonic);
            const stuck = keys.filter((key) => key.material !== null);
            const submitted = await submitAll(
                {
                    chains: bindings.chains,
                    store: bindings.handovers,
                    handoverFor: (chainId) => handoverFor(bindings, chainId),
                    serverUrl: bindings.env.serverUrl,
                    onProgress: noteRecover,
                },
                {
                    vaultId: vault.vaultId,
                    keys: stuck,
                    ownerWalletId: seedFingerprint(ownerMnemonic),
                    destinationFor: (chainId) => {
                        const signing = signingKeys.find((row) => row.chainId === chainId);
                        const protectedAccount = owner.accounts[chainId]?.[0]?.address;
                        if (signing === undefined || protectedAccount === undefined) return null;
                        return { newOwner: signing.address, sweepTo: protectedAccount };
                    },
                },
            );
            const stillStuck = submitted
                .filter((record) => record.stage === "failed")
                .map((record) => record.chainId);
            if (stillStuck.length === 0) {
                for (const key of stuck) key.material?.fill(0);
                noteRecover("keys       every chain submitted; the recovered keys are wiped");
            }
            setState((prev) =>
                prev.result === null
                    ? prev
                    : { ...prev, result: { ...prev.result, unsubmitted: stillStuck } },
            );
            return submitted;
        },
        [bindings, noteRecover, state.result],
    );

    /**
     * Take a seal file the user picked, and reload so the vault appears in the list.
     *
     * On the flow rather than in the card because the ledger is this hook's, and a card that wrote
     * to storage behind it would leave the two disagreeing until something else happened to reload.
     */
    const importSeal = useCallback(
        async (text: string) => {
            const file = parseSealFile(text);
            const outcome = await importSealFile(bindings.stores, file);
            // The file holds the seal and the instructions; the records, and any chain added after
            // the file was saved, come from the host it names.
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
