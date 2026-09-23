/**
 * The on-chain half of a recovery: sign the handover, submit it, watch the timelock, finish it.
 *
 * Opening the vault produced a key. This is what turns that key into control of the account, and
 * until it runs the account belongs to whoever it belonged to before. The two halves are separate
 * on purpose and fail separately — a vault can be open for days with nothing submitted.
 *
 * **The relayer sends, not the wallet.** `initiateRecovery` and `executeRecovery` are authorised by
 * the signature inside the intent, not by the sender, which is the whole reason someone who has lost
 * their account can recover it: they have no funded key left to pay with. These are also plain
 * transactions rather than UserOps, so no paymaster can cover them — the relayer is not an
 * optimisation, it is the only way this step happens at all.
 *
 * **The digest is read from the module.** Never derived here; see `settlement/evm/reads.ts`.
 *
 * `proveControl` is the step after the last one. `executeRecovery` installing a validator is a
 * state change nobody can see; moving value under the new key is the claim itself, and it is a
 * UserOp paid by the account rather than a relayer call, because by then the account is reachable
 * again.
 */
import { useCallback, useEffect, useState } from "react";
import { createPublicClient, http, type Address, type Hex, type PublicClient } from "viem";
import { sepolia } from "viem/chains";
import { recoveryModuleAddress } from "@nihilium/recovery-onchain-evm";
import { toSolanaAddress } from "@nihilium/recovery-key-solana";
import type { ChainModule, DerivedAccount } from "../integration/chains/types.js";
import type { VaultRecord } from "../integration/recovery/vaultRecords.js";
import { buildIntent, DEFAULT_INTENT_TTL_SECONDS } from "../integration/recovery/settlement/evm/intent.js";
import { createModuleReader, type SolidityIntent } from "../integration/recovery/settlement/evm/reads.js";
import { preflightRecovery, type PreflightProblem } from "../integration/recovery/settlement/evm/preflight.js";
import { sendAsRecoveredOwner } from "../integration/recovery/settlement/evm/recoveredOwner.js";
import { createVaultProgram, keypairFromSecret } from "../integration/recovery/settlement/solana/program.js";
import { solanaVaultAddresses } from "../integration/recovery/settlement/solana/addresses.js";
import {
    intentDigestFor,
    readVaultState,
    relayExecute,
    relayInitiate,
} from "../integration/recovery/settlement/solana/relay.js";
import type { SolanaIntentInputs } from "../integration/recovery/settlement/solana/recovery.js";
import type { AppBindings } from "./bindings.js";

export interface ChainRecoveryState {
    phase:
        | "idle"
        | "checking"
        | "signing"
        | "submitting"
        | "waiting"
        | "executing"
        | "done"
        | "proving"
        | "proved"
        | "failed";
    problems: readonly PreflightProblem[];
    /** Kept so `execute` sends byte-identical fields; the module matches on the hash of these. */
    intent: SolidityIntent | null;
    intentHash: Hex | null;
    initiateTx: string | null;
    executeTx: string | null;
    /** The transfer that demonstrates the new key controls the account. */
    proofTx: string | null;
    /** Kept for Solana's `execute`, which needs the same intent byte for byte. */
    solanaIntent: SolanaIntentInputs | null;
    log: string[];
    error: string | null;
}

const EMPTY: ChainRecoveryState = {
    phase: "idle",
    problems: [],
    intent: null,
    intentHash: null,
    initiateTx: null,
    executeTx: null,
    proofTx: null,
    solanaIntent: null,
    log: [],
    error: null,
};

export function useRecoveryChain(
    bindings: AppBindings,
    chain: ChainModule,
    vault: VaultRecord | null,
    /**
     * The wallet's own derived account.
     *
     * Needed on Solana and nowhere else: the vault PDA is seeded from the **creator**, and the
     * chain record holds the PDA rather than the key that made it. On EVM the account and the
     * record's `accountId` are the same address, so nothing reads this.
     */
    account?: DerivedAccount,
) {
    const [state, setState] = useState<ChainRecoveryState>(EMPTY);

    const evm = chain.id === "evm-sepolia";
    const solana = chain.id === "solana-devnet";
    const supported = evm || solana;
    const chainRecord = vault?.chains.find((row) => row.chainId === chain.id) ?? null;

    const note = useCallback((line: string) => {
        setState((prev) => ({ ...prev, log: [...prev.log, line] }));
    }, []);

    const reader = useCallback(() => {
        const client = createPublicClient({
            chain: sepolia,
            transport: http(bindings.env.sepoliaRpcUrl),
        }) as PublicClient;
        return createModuleReader(
            client,
            recoveryModuleAddress(bindings.env.chainId) as Address,
            chain.namespace,
        );
    }, [bindings.env.chainId, bindings.env.sepoliaRpcUrl, chain.namespace]);


    /**
     * The same handover on Solana, and a different shape for one reason: **nobody signs the
     * transaction**. Authority is a detached ed25519 signature the program reads out of the
     * `Ed25519SigVerify` instruction, so the browser signs the digest and the relayer sends — the
     * two never share a key, and the recovering user needs no SOL.
     */
    const initiateOnSolana = useCallback(
        async (params: { target: Address; material: Uint8Array }): Promise<void> => {
        if (chainRecord === null || account === undefined) return;
        try {
            const ctx = createVaultProgram({
                rpcUrl: bindings.env.solanaRpcUrl,
                cluster: "devnet",
                // Only used to build instructions here; it signs nothing, because nothing in this
                // flow is signed by a transaction signer.
                payer: keypairFromSecret(account.signer.exportPrivateKeyHex_DEMO_ONLY()),
            });
            const addresses = solanaVaultAddresses({
                cluster: "devnet",
                creator: account.signer.address,
            });

            // Read, never remembered: `epoch` and `nonce` are replay protection, and a stale pair
            // produces a signature the program refuses without naming the reason.
            const chainState = await readVaultState(ctx, addresses);
            note(`vault      epoch=${chainState.epoch} nonce=${chainState.nonce}`);
            if (!chainState.registered) {
                throw new Error(
                    `The vault at ${addresses.vault.toBase58()} has no guardian registered, so there ` +
                        "is no key it would accept a recovery from. Register one first.",
                );
            }

            const intent: SolanaIntentInputs = {
                newOwner: params.target,
                epoch: chainState.epoch,
                nonce: chainState.nonce,
                expiry: Math.floor(Date.now() / 1000) + DEFAULT_INTENT_TTL_SECONDS,
            };

            const digest = intentDigestFor(ctx, addresses, intent);
            setState((prev) => ({ ...prev, phase: "signing", solanaIntent: intent }));
            // ed25519 signs the message, not a pre-hash — the opposite of the EVM adapter, and the
            // reason `sign` lives on the chain module rather than being shared.
            const signature = await chain.keyAdapter.sign(params.material, digest);
            note(`signed     by the recovered key, ${signature.bytes.length} bytes`);

            setState((prev) => ({ ...prev, phase: "submitting" }));
            const result = await relayInitiate(ctx, {
                addresses,
                intent,
                // The vault's own recorded key, turned into the address the program knows it by.
                // Re-deriving it from `material` would compare a value against itself.
                guardianPublicKey: toSolanaAddress({
                    algorithm: "ed25519",
                    bytes: hexToBytes(chainRecord.recoveryPubKeyHex),
                }),
                signature: signature.bytes,
                serverUrl: bindings.env.serverUrl,
                onProgress: note,
            });
            note(`initiate   tx=${result.hash}`);
            setState((prev) => ({ ...prev, phase: "waiting", initiateTx: result.hash }));
        } catch (error) {
            setState((prev) => ({ ...prev, phase: "failed", error: messageOf(error) }));
        }
        },
        [account, bindings.env.serverUrl, bindings.env.solanaRpcUrl, chain.keyAdapter, chainRecord, note],
    );

    /**
     * Sign the handover and hand it to the relayer.
     *
     * `material` is the recovered private key. It is a parameter rather than something this hook
     * holds, so the key's lifetime stays owned by the screen that recovered it.
     */
    const initiate = useCallback(
        async (params: { target: Address; material: Uint8Array }) => {
            if (!supported || chainRecord === null || vault === null) return;
            setState({ ...EMPTY, phase: "checking" });

            if (solana) {
                await initiateOnSolana(params);
                return;
            }

            try {
                const module = reader();
                const account = chainRecord.accountId as Address;

                // Before anything is signed: the module installed, the epoch matching, no attempt
                // already in flight, the intent outliving the timelock.
                const problems = await preflightRecovery(module, {
                    account,
                    expectedRecoveryPubKeyHex: chainRecord.recoveryPubKeyHex,
                    intentTtlSeconds: DEFAULT_INTENT_TTL_SECONDS,
                });
                setState((prev) => ({ ...prev, problems }));
                if (problems.some((problem) => problem.blocking)) {
                    setState((prev) => ({
                        ...prev,
                        phase: "failed",
                        error: problems.find((p) => p.blocking)!.message,
                    }));
                    return;
                }

                const config = await module.configOf(account);
                note(`configOf   epoch=${config.epoch} nonce=${config.nonce}`);

                const { solidity } = buildIntent({
                    account,
                    newOwner: params.target,
                    epoch: config.epoch,
                    nonce: config.nonce,
                    moduleAddress: module.moduleAddress,
                });

                // Read, never computed: the deployment's `version()` differs from the checked-out
                // Solidity, and that string is inside the EIP-712 domain separator.
                const digest = await module.hashIntent(solidity);
                note(`hashIntent ${digest}`);

                setState((prev) => ({ ...prev, phase: "signing", intent: solidity, intentHash: digest }));
                const signature = await chain.keyAdapter.sign(params.material, hexToBytes(digest));
                note(`signed     by the recovered key, ${signature.bytes.length} bytes`);

                setState((prev) => ({ ...prev, phase: "submitting" }));
                const result = await post(bindings.env.serverUrl, "initiate", {
                    intent: serialize(solidity),
                    signature: `0x${toHex(signature.bytes)}`,
                });
                note(`initiate   tx=${result.hash}`);

                setState((prev) => ({
                    ...prev,
                    phase: "waiting",
                    initiateTx: String(result.hash),
                }));
            } catch (error) {
                setState((prev) => ({ ...prev, phase: "failed", error: messageOf(error) }));
            }
        },
        [
            bindings.env.serverUrl,
            chain.keyAdapter,
            chainRecord,
            initiateOnSolana,
            note,
            reader,
            solana,
            supported,
            vault,
        ],
    );


    /** Only legal once the module says `EXECUTABLE`; the relayer's call reverts otherwise. */
    const execute = useCallback(async () => {
        if (solana) {
            if (state.solanaIntent === null || account === undefined || vault === null) return;
            setState((prev) => ({ ...prev, phase: "executing", error: null }));
            try {
                const result = await relayExecute({
                    addresses: solanaVaultAddresses({
                        cluster: "devnet",
                        creator: account.signer.address,
                    }),
                    // Byte-identical to the one `initiate` carried, or the program's re-hash misses
                    // and the attempt stays open.
                    intent: state.solanaIntent,
                    serverUrl: bindings.env.serverUrl,
                    onProgress: note,
                });
                note(`execute    tx=${result.hash} — owner rotated, epoch bumped`);
                setState((prev) => ({ ...prev, phase: "done", executeTx: result.hash }));
            } catch (error) {
                setState((prev) => ({ ...prev, phase: "failed", error: messageOf(error) }));
            }
            return;
        }

        if (state.intent === null) return;
        setState((prev) => ({ ...prev, phase: "executing", error: null }));
        try {
            const result = await post(bindings.env.serverUrl, "execute", {
                intent: serialize(state.intent),
            });
            note(`execute    tx=${result.hash}`);
            setState((prev) => ({ ...prev, phase: "done", executeTx: String(result.hash) }));
        } catch (error) {
            setState((prev) => ({ ...prev, phase: "failed", error: messageOf(error) }));
        }
    }, [account, bindings.env.serverUrl, note, solana, state.intent, state.solanaIntent, vault]);

    /**
     * Send a token amount out of the recovered account, signed by the key it was handed to.
     *
     * Deliberately a real transfer and not a zero-value no-op: a UserOp that moves nothing proves
     * the signature was accepted and nothing else, and the claim being demonstrated is that the
     * owner can spend again.
     */
    const proveControl = useCallback(
        async (params: { to: Address; amount: bigint; newOwnerPrivateKeyHex: string }) => {
            if (chainRecord === null) return;
            setState((prev) => ({ ...prev, phase: "proving", error: null }));
            try {
                const result = await sendAsRecoveredOwner({
                    rpcUrl: bindings.env.sepoliaRpcUrl,
                    bundlerUrl: bindings.env.bundlerUrl,
                    account: chainRecord.accountId as Address,
                    newOwnerPrivateKeyHex: params.newOwnerPrivateKeyHex,
                    to: params.to,
                    amount: params.amount,
                    onProgress: note,
                });
                setState((prev) => ({
                    ...prev,
                    phase: "proved",
                    proofTx: result.transactionHash,
                }));
            } catch (error) {
                setState((prev) => ({ ...prev, phase: "failed", error: messageOf(error) }));
            }
        },
        [bindings.env.bundlerUrl, bindings.env.sepoliaRpcUrl, chainRecord, note],
    );

    const reset = useCallback(() => setState(EMPTY), []);

    // While an attempt is in flight the chain is the only thing that can say the timelock matured,
    // so it is polled rather than timed locally — a local clock would drift past a pause.
    const [tick, setTick] = useState(0);
    useEffect(() => {
        if (state.phase !== "waiting") return;
        const id = setInterval(() => setTick((n) => n + 1), 5000);
        return () => clearInterval(id);
    }, [state.phase]);

    const [attempt, setAttempt] = useState<{ state: string | null; accruedSeconds: bigint } | null>(
        null,
    );
    useEffect(() => {
        // EVM only: `reader()` is the module's, and Solana's clock lives in the vault account.
        // Polling it there is the watchtower's job, not this hook's.
        if (!evm || chainRecord === null || state.phase !== "waiting") return;
        let live = true;
        void reader()
            .attemptOf(chainRecord.accountId as Address)
            .then((snapshot) => {
                if (!live) return;
                setAttempt({ state: snapshot.state, accruedSeconds: snapshot.accruedSeconds });
            })
            .catch(() => undefined);
        return () => {
            live = false;
        };
    }, [chainRecord, evm, reader, state.phase, tick]);

    return { state, attempt, supported, initiate, execute, proveControl, reset };
}

export type RecoveryChain = ReturnType<typeof useRecoveryChain>;

/** `bigint` does not survive `JSON.stringify`, and the relayer parses these back. */
function serialize(intent: SolidityIntent) {
    return {
        account: intent.account,
        epoch: intent.epoch.toString(),
        nonce: intent.nonce.toString(),
        newValidator: intent.newValidator,
        newValidatorInitData: intent.newValidatorInitData,
        expiry: intent.expiry,
    };
}

async function post(serverUrl: string, route: string, body: unknown): Promise<{ hash: string }> {
    const response = await fetch(`${serverUrl}/api/roles/relayer/${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
    const payload = (await response.json()) as { hash?: string; error?: string };
    if (!response.ok) {
        throw new Error(
            payload.error ??
                `The relayer refused ${route} (HTTP ${response.status}). It holds the gas for this ` +
                    "step; without it a recovered key has nothing to submit with.",
        );
    }
    return { hash: payload.hash! };
}

function hexToBytes(hex: string): Uint8Array {
    const body = hex.startsWith("0x") ? hex.slice(2) : hex;
    const out = new Uint8Array(body.length / 2);
    for (let i = 0; i < out.length; i += 1) {
        out[i] = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
}

function toHex(bytes: Uint8Array): string {
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
