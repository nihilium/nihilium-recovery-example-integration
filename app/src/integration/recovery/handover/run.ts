/**
 * Driving a whole vault's handover — every chain, one call.
 *
 * A vault is one gate over several accounts, so moving it is one decision and not one per chain.
 * That is the shape the whole repo argues for: a ceremony is paid once and covers everything, and a
 * user who then had to drive EVM and Solana separately would be paying for the asymmetry twice.
 *
 * **Per-chain failure is a row, never a throw.** Chains fail independently and for unrelated
 * reasons — a relayer down, a record sealed before this app tracked something, a build with no
 * module for that chain. Aborting the loop would strand the chains that worked, and the ceremony
 * that produced their keys is spent and cannot be re-run.
 *
 * **To replace:** `handoverFor`, if your app resolves chains differently. Keep the shape: submit
 * every chain immediately so the key can be wiped, then come back for execute and sweep with no key
 * at all.
 * **Assumes:** `keys` came from one `recoverAllChains` and are still live. The caller wipes them the
 * moment `submitAll` returns, and nothing here holds a reference past that.
 */
import type { ChainRegistry } from "../../chains/types.js";
import type { RecoveredChainKey } from "../recoverAll.js";
import { handoverId, type HandoverRecord, type HandoverStore } from "../handovers.js";
import type { ChainHandover } from "./types.js";

export interface HandoverDeps {
    chains: ChainRegistry;
    store: HandoverStore;
    /** `null` on a chain this build cannot carry through; the row says so and the others proceed. */
    handoverFor(chainId: string): ChainHandover | null;
    serverUrl: string;
    onProgress?(message: string): void;
}

export interface SubmitAllParams {
    vaultId: string;
    keys: readonly RecoveredChainKey[];
    /** Per chain: the key that will control the account, and where its funds should end up. */
    destinationFor(chainId: string): { newOwner: string; sweepTo: string } | null;
    ownerWalletId: string;
}

/**
 * Sign and submit every chain's intent, now, while the keys are live.
 *
 * This is the only step that needs them. Doing it immediately — rather than when the user later
 * presses the button — is what lets the keys be wiped straight after and the timelock be waited out
 * with nothing sensitive anywhere. `executeRecovery` takes no signature; by then the clock is the
 * authority.
 */
export async function submitAll(
    deps: HandoverDeps,
    params: SubmitAllParams,
): Promise<HandoverRecord[]> {
    const out: HandoverRecord[] = [];

    /**
     * Rows already here, and the reason this function reads before it writes.
     *
     * Records are keyed `${vaultId}:${chainId}`, so a second run over the same vault overwrites the
     * first. That destroyed the one thing in this system that cannot be rebuilt: a submitted row
     * holds the **intent**, and the key that signed it was wiped on purpose the moment it was used.
     * Re-running a recovery — which is legal, it just buys another ceremony — therefore replaced a
     * live, executable attempt with a failure row, and the attempt on-chain became unreachable: the
     * module will only execute an intent byte-identical to the one it was opened with.
     *
     * So a chain that already has an intent is left completely alone, and the new run reports it as
     * already submitted rather than trying again. Trying again could not work anyway: both chains
     * allow one attempt at a time and refuse a second with `AttemptInFlight`.
     */
    const existing = new Map(
        (await deps.store.forVault(params.vaultId)).map((record) => [record.chainId, record]),
    );

    for (const key of params.keys) {
        const held = existing.get(key.chainId);
        if (held !== undefined && held.stage !== "failed") {
            deps.onProgress?.(
                `initiate   ${key.chainId} already submitted (${held.stage}) — left as it is, ` +
                    "because its intent is the only thing that can execute it",
            );
            out.push(held);
            continue;
        }

        const base = {
            id: handoverId(params.vaultId, key.chainId),
            vaultId: params.vaultId,
            chainId: key.chainId,
            accountId: key.chainRecord.accountId,
            signerAddress: key.chainRecord.signerAddress ?? null,
            ownerWalletId: params.ownerWalletId,
            submittedAt: Date.now(),
            executeTx: null,
            sweepTx: null,
        };

        const destination = params.destinationFor(key.chainId);
        const handover = deps.handoverFor(key.chainId);
        const chain = deps.chains.get(key.chainId);

        const stop = (failure: string): HandoverRecord => ({
            ...base,
            newOwner: destination?.newOwner ?? "",
            sweepTo: destination?.sweepTo ?? "",
            intent: null,
            stage: "failed",
            initiateTx: null,
            failure,
        });

        if (key.failure !== null || key.material === null) {
            out.push(stop(key.failure ?? "No key was recovered for this chain."));
            continue;
        }
        if (destination === null || handover === null || chain === undefined) {
            out.push(
                stop(
                    `This build cannot hand ${key.chainLabel} over: ` +
                        `${handover === null || chain === undefined ? "no settlement is wired for it" : "no destination was derived for it"}.`,
                ),
            );
            continue;
        }

        try {
            deps.onProgress?.(`initiate   ${key.chainId} → ${destination.newOwner}`);
            const result = await handover.initiate({
                chainRecord: key.chainRecord,
                serverUrl: deps.serverUrl,
                keyAdapter: chain.keyAdapter,
                material: key.material,
                newOwner: destination.newOwner,
                ...(deps.onProgress ? { onProgress: deps.onProgress } : {}),
            });
            out.push({
                ...base,
                newOwner: destination.newOwner,
                sweepTo: destination.sweepTo,
                intent: result.intent,
                stage: "submitted",
                initiateTx: result.hash,
                failure: null,
            });
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            deps.onProgress?.(`initiate   ${key.chainId} ✗ ${reason}`);
            out.push(stop(reason));
        }
    }

    // Only the rows this run actually produced. An untouched row is already in the store, and
    // writing it back is a chance to write it back wrong.
    for (const record of out) {
        if (existing.get(record.chainId) === record) continue;
        await deps.store.put(record);
    }
    return out;
}

export interface MoveAllParams {
    records: readonly HandoverRecord[];
    /** The destination key per chain, so the sweep can sign as the account it just took over. */
    ownerKeyFor(chainId: string): string | null;
}

/**
 * Finish it: execute where the timelock has matured, then sweep.
 *
 * Needs no recovered key — `executeRecovery` is authorised by the clock, and the sweep is signed by
 * the destination key the wallet already holds. That is what makes this callable in a session that
 * never ran the ceremony.
 *
 * Idempotent per chain: a record already `executed` is only swept, and one already `swept` is left
 * alone. Pressing the button twice after a partial failure is the normal way to finish.
 */
export async function moveAll(
    deps: HandoverDeps,
    params: MoveAllParams,
): Promise<HandoverRecord[]> {
    const out: HandoverRecord[] = [];

    for (const record of params.records) {
        if (record.stage === "swept" || record.stage === "failed") {
            out.push(record);
            continue;
        }

        const handover = deps.handoverFor(record.chainId);
        const ownerKey = params.ownerKeyFor(record.chainId);
        // Built from the stored row alone. See `HandoverAccount`: this has to work in a session
        // that holds no vault record and no recovered key.
        const account = {
            accountId: record.accountId,
            signerAddress: record.signerAddress ?? undefined,
        };

        if (handover === null || ownerKey === null) {
            out.push({
                ...record,
                stage: "failed",
                failure:
                    handover === null
                        ? "No settlement is wired for this chain in this build."
                        : "The seed control was handed to is not in this browser. Add it to move " +
                          "these funds.",
            });
            continue;
        }

        let current = record;
        try {
            if (current.stage === "submitted") {
                deps.onProgress?.(`execute    ${current.chainId}`);
                const executed = await handover.execute({
                    chainRecord: account,
                    serverUrl: deps.serverUrl,
                    intent: current.intent,
                    ...(deps.onProgress ? { onProgress: deps.onProgress } : {}),
                });
                current = { ...current, stage: "executed", executeTx: executed.hash };
                await deps.store.put(current);
            }

            deps.onProgress?.(`sweep      ${current.chainId} → ${current.sweepTo}`);
            const swept = await handover.sweep({
                chainRecord: account,
                serverUrl: deps.serverUrl,
                to: current.sweepTo,
                ownerPrivateKeyHex: ownerKey,
                amount: null,
                ...(deps.onProgress ? { onProgress: deps.onProgress } : {}),
            });
            current = { ...current, stage: "swept", sweepTx: swept.hash, failure: null };
            deps.onProgress?.(`swept      ${current.chainId} ${swept.moved} → ${current.sweepTo}`);
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            deps.onProgress?.(`${current.stage === "submitted" ? "execute" : "sweep"}    ${current.chainId} ✗ ${reason}`);
            // Kept at the stage it reached rather than marked failed: a timelock that has not
            // matured, or a relayer that is down, is a reason to press the button again later —
            // not a reason to make the chain unreachable.
            current = { ...current, failure: reason };
        }

        await deps.store.put(current);
        out.push(current);
    }

    return out;
}
