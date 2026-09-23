/**
 * The on-chain half, as React state.
 *
 * Sealing produces a recovery key; this is what tells the chain about it. Until it runs, the badge
 * on the wallet reads "Sealed · not on-chain yet" and means it — the module has never heard of the
 * key, so nothing on Sepolia would honour a recovery.
 *
 * It reads the chain rather than remembering: `installed` and `recoveryOwner` come from `configOf()`
 * every time, because the account can be changed by anything holding its key and a cached answer
 * would be this app's belief rather than the chain's state. That is also what makes `stale`
 * detectable — a vault whose key the chain does not hold.
 */
import { useCallback, useEffect, useState } from "react";
import { createPublicClient, http, type Address, type Hex, type PublicClient } from "viem";
// noble's, not viem's: the vault records these keys with `bytesToHex`, which writes no `0x`, and
// viem's decoder demands one.
import { hexToBytes } from "@noble/hashes/utils.js";
import { sepolia } from "viem/chains";
import { recoveryModuleAddress } from "@nihilium/recovery-onchain-evm";
import { generateRRS, type VetoState } from "@nihilium/recovery-core";
import { toEvmAddress } from "@nihilium/recovery-key-evm";
import { toSolanaAddress } from "@nihilium/recovery-key-solana";
import type { ChainModule, DerivedAccount } from "../integration/chains/types.js";
import type { VaultRecord } from "../integration/recovery/vaultRecords.js";
import { protectAccount } from "../integration/recovery/settlement/evm/install.js";
import { createModuleReader } from "../integration/recovery/settlement/evm/reads.js";
import { isProtectedByVault } from "../integration/recovery/settlement/evm/preflight.js";
import {
    assertResumeQuorumPortable,
    demoVetoConfig,
    toSolidityVetoConfig,
    validateDemoVetoConfig,
    type SolidityVetoConfig,
} from "../integration/recovery/settlement/evm/vetoConfig.js";
import { solanaVaultAddresses } from "../integration/recovery/settlement/solana/addresses.js";
import { createVaultProgram, keypairFromSecret } from "../integration/recovery/settlement/solana/program.js";
import {
    createVault,
    registerGuardian,
    registrationDigestFor,
} from "../integration/recovery/settlement/solana/vault.js";
import { addChainToVault } from "../integration/recovery/vault.js";
import { chainContextOf } from "../integration/recovery/vaultRecords.js";
import { readVaultState } from "../integration/recovery/settlement/solana/relay.js";
import { loadFeePayer } from "../integration/recovery/settlement/solana/submit.js";
import type { MethodRegistry } from "../integration/conditions/types.js";
import type { AppBindings } from "./bindings.js";

/** What the server's relayer role publishes: the operator's veto keys, not the account's. */
interface RelayerConfig {
    recoveryModuleAddress: Address;
    relayer: Address;
    pauseAuthority: Address;
    resumeMembers: Address[];
    resumeThreshold: number;
    timelockSeconds: number;
    pauseCeilingSeconds: number;
}

export interface OnChainState {
    installed: boolean;
    /**
     * In that chain's own notation — `0x…` on EVM, base58 on Solana.
     *
     * A string rather than an `Address`, because this is displayed and compared, never used to
     * build a call. Typing it as EVM-shaped is how a Solana answer ends up either cast or dropped.
     */
    recoveryOwner: string | null;
    /** True when the chain holds *this* vault's key. False with a vault present means `stale`. */
    matchesVault: boolean;
    /**
     * The module's view of any recovery attempt on this account: `null` when there is none.
     *
     * Read here rather than remembered, and read for *any* attempt rather than only this browser's —
     * polling `stateOf` is how a recovery somebody else submitted becomes visible at all. It is not
     * a substitute for a watchtower, which fires earlier and off-chain; see `recoveryHealth.ts`.
     */
    attempt: VetoState | null;
    /** Seconds accrued toward the timelock, as of the last checkpoint. */
    accruedSeconds: bigint;
    intentHash: Hex | null;
}

export interface SettlementState {
    phase: "idle" | "protecting" | "failed";
    onchain: OnChainState | null;
    error: string | null;
    log: string[];
    txHash: string | null;
}

const EMPTY: SettlementState = {
    phase: "idle",
    onchain: null,
    error: null,
    log: [],
    txHash: null,
};

export function useSettlement(
    bindings: AppBindings,
    chain: ChainModule,
    account: DerivedAccount | undefined,
    vault: VaultRecord | null,
    /**
     * Needed only where registering *mints* a key rather than merely naming one.
     *
     * Solana's `register` is signed by the incoming guardian, so protecting there runs `addChain()`
     * as part of the same operation — and `addChain()` needs the method this vault was sealed with.
     */
    methods: MethodRegistry | null,
    /**
     * Called when this hook has written to the vault ledger itself.
     *
     * Protecting on Solana mints a fresh key for the chain, so it goes through `addChainToVault` —
     * which makes this hook a second writer of state `useRecoveryFlow` owns. Without telling it, the
     * badge compares the chain's new recovery owner against the record it replaced and reads
     * `stale` forever.
     */
    onVaultChanged?: () => void | Promise<void>,
) {
    const [state, setState] = useState<SettlementState>(EMPTY);
    const [nonce, setNonce] = useState(0);

    const evm = chain.id === "evm-sepolia";
    const solana = chain.id === "solana-devnet";
    const chainRecord = vault?.chains.find((row) => row.chainId === chain.id) ?? null;
    const accountId = account?.accountId;

    const moduleAddress = evm
        ? (recoveryModuleAddress(bindings.env.chainId) as Address)
        : null;

    const reader = useCallback(() => {
        const client = createPublicClient({
            chain: sepolia,
            transport: http(bindings.env.sepoliaRpcUrl),
        }) as PublicClient;
        return createModuleReader(client, moduleAddress!, chain.namespace);
    }, [bindings.env.sepoliaRpcUrl, chain.namespace, moduleAddress]);

    /**
     * The same question on Solana, asked of the vault account rather than a module.
     *
     * Without this the badge reads "Sealed · not on-chain yet" forever, including straight after a
     * registration that landed — the state was masked to `null` for every chain but EVM, and
     * `null` is deliberately rendered as "not asked yet".
     */
    useEffect(() => {
        if (!solana || vault === null || account === undefined) return;
        const record = vault.chains.find((row) => row.chainId === chain.id);
        if (record === undefined) return;
        let live = true;

        void (async () => {
            try {
                const ctx = createVaultProgram({
                    rpcUrl: bindings.env.solanaRpcUrl,
                    cluster: "devnet",
                    payer: keypairFromSecret(account.signer.exportPrivateKeyHex_DEMO_ONLY()),
                });
                const addresses = solanaVaultAddresses({
                    cluster: "devnet",
                    creator: account.signer.address,
                });
                const info = await ctx.connection.getAccountInfo(addresses.vault, "confirmed");
                if (!live) return;
                if (info === null) {
                    // No vault account at all. Not an error — it is what "never protected" looks
                    // like on a chain where the protected account has to be created first.
                    setState((prev) => ({
                        ...prev,
                        onchain: {
                            installed: false,
                            recoveryOwner: null,
                            matchesVault: false,
                            attempt: null,
                            accruedSeconds: 0n,
                            intentHash: null,
                        },
                    }));
                    return;
                }

                const chainState = await readVaultState(ctx, addresses);
                const expected = toSolanaAddress({
                    algorithm: "ed25519",
                    bytes: hexToBytes(record.recoveryPubKeyHex),
                });
                if (!live) return;
                setState((prev) => ({
                    ...prev,
                    phase: "idle",
                    onchain: {
                        installed: chainState.registered,
                        recoveryOwner: chainState.registered ? chainState.recoveryOwner : null,
                        // The chain holding *a* key is not the chain holding *this vault's* key —
                        // the difference is the whole of the `stale` state.
                        matchesVault:
                            chainState.registered && chainState.recoveryOwner === expected,
                        attempt: null,
                        accruedSeconds: 0n,
                        intentHash: null,
                    },
                }));
            } catch (error) {
                // An unreadable chain is not an unprotected account, and must not render as one.
                if (!live) return;
                setState((prev) => ({ ...prev, phase: "failed", error: messageOf(error) }));
            }
        })();

        return () => {
            live = false;
        };
    }, [account, bindings.env.solanaRpcUrl, chain.id, solana, vault, nonce]);

    // Re-read whenever the account, the vault or a completed write says the answer may have moved.
    useEffect(() => {
        // Nothing to read: not an EVM chain, or no account yet. `onchain` stays whatever it was
        // and is masked to null on the way out, rather than written here — a setState in an effect
        // just to say "nothing happened" is a render nobody needed.
        if (!evm || moduleAddress === null || accountId === undefined) return;
        let live = true;

        void (async () => {
            try {
                const module = reader();
                const installed = await module.isInitialized(accountId as Address);
                const config = installed ? await module.configOf(accountId as Address) : null;
                const attempt = installed ? await module.attemptOf(accountId as Address) : null;
                const matchesVault =
                    chainRecord === null || !installed
                        ? false
                        : await isProtectedByVault(
                              module,
                              accountId as Address,
                              chainRecord.recoveryPubKeyHex,
                          );
                if (!live) return;
                setState((prev) => ({
                    ...prev,
                    phase: "idle",
                    onchain: {
                        installed,
                        recoveryOwner: config?.recoveryOwner ?? null,
                        matchesVault,
                        attempt: attempt?.state ?? null,
                        accruedSeconds: attempt?.accruedSeconds ?? 0n,
                        intentHash: attempt?.intentHash ?? null,
                    },
                }));
            } catch (error) {
                // An unreadable chain is not an unprotected account, and must not render as one.
                if (!live) return;
                setState((prev) => ({ ...prev, phase: "failed", error: messageOf(error) }));
            }
        })();

        return () => {
            live = false;
        };
    }, [evm, moduleAddress, accountId, chainRecord, reader, nonce]);

    const note = useCallback((line: string) => {
        setState((prev) => ({ ...prev, log: [...prev.log, line] }));
    }, []);

    /**
     * Protect on Solana: create the vault if it does not exist, then register the guardian.
     *
     * Two instructions rather than one because they are two different facts. `create_vault` brings
     * the **account recovery protects** into existence — a keypair's address is its public key and
     * cannot be recovered, so the protected thing has to be a program-owned PDA, created in
     * advance. `register` binds this vault's recovery key to it.
     *
     * Both go through the fee payer when the server offers one, so an owner with zero SOL can still
     * do this. That matters more here than on EVM: the PDAs need rent before they exist at all, and
     * rent is not something a faucet-less demo can conjure.
     */
    const protectOnSolana = useCallback(async () => {
        if (account === undefined || vault === null) return;
        const method = methods?.get(vault.gate.methodId) ?? null;
        if (method === null) {
            setState((prev) => ({
                ...prev,
                phase: "failed",
                error:
                    `This vault was sealed with "${vault.gate.methodId}", which is not configured. ` +
                    "Registering mints a fresh key for this chain, and that needs the vault's own method.",
            }));
            return;
        }
        setState((prev) => ({ ...prev, phase: "protecting", error: null, log: [], txHash: null }));

        try {
            const owner = keypairFromSecret(account.signer.exportPrivateKeyHex_DEMO_ONLY());
            const ctx = createVaultProgram({
                rpcUrl: bindings.env.solanaRpcUrl,
                cluster: "devnet",
                payer: owner,
            });
            const addresses = solanaVaultAddresses({
                cluster: "devnet",
                creator: account.signer.address,
            });

            // The operator's veto authorities, and the only source for them: the program refuses a
            // config where one party holds two roles, so there is no local placeholder that works.
            const solanaConfig = await fetchSolanaRelayerConfig(bindings.env.serverUrl);

            // `null` when the server runs without Solana configured. The demo still works — the
            // owner pays — so this falls back rather than refusing, and says which one happened.
            const feePayer = await loadFeePayer(bindings.env.serverUrl);
            const via = feePayer ?? { kind: "self" as const };
            note(
                feePayer === null
                    ? "feepayer      unavailable — the owner pays its own fees and rent"
                    : "feepayer      the server pays; this wallet needs no SOL",
            );

            const existing = await ctx.connection.getAccountInfo(addresses.vault, "confirmed");
            if (existing === null) {
                await createVault({ ...ctx }, { addresses, via, onProgress: note });
            } else {
                note(`create_vault  already at ${addresses.vault.toBase58()}`);
            }

            // Read, never assumed: `configNonce` is what makes a registration spendable once, so a
            // stale one cannot be replayed to revert a later rotation.
            const chainState = await readVaultState(ctx, addresses);

            const veto = {
                // Three parties, three keys — the program checks this and refuses
                // `PauseAndAbortHeldByOneParty` and its siblings outright.
                pauseAuthority: solanaConfig.pauseAuthority,
                // The wallet's own key, as on EVM: the common case is not a rogue provider, it is
                // a recovery opened while the owner still has access, and the party who should
                // stop that is whoever holds the key.
                abortAuthority: account.signer.address,
                resumeMembers: solanaConfig.resumeMembers,
                resumeThreshold: solanaConfig.resumeThreshold,
                timelockSeconds: solanaConfig.timelockSeconds,
                pauseCeilingSeconds: solanaConfig.pauseCeilingSeconds,
            };

            // **The recovery key has to sign its own registration**, and the app only ever receives
            // its public half from `addChain()`. So this mints the root here, keeps it for exactly
            // one signature, and wipes it — which is also why sealing and registering are a single
            // operation on this chain: the digest binds the veto fingerprint and `config_nonce`,
            // neither of which is knowable before now.
            const rrs = generateRRS();
            let guardianSignature: Uint8Array;
            let recoveryOwner: string;
            try {
                const updated = await addChainToVault(bindings.stores, {
                    method,
                    vault,
                    chain,
                    account,
                    recoveryKey: { kind: "rrs", rrs },
                    // A chain already in the vault holds a key whose root nobody kept, so it can
                    // never sign. Minting a fresh one is the only way to register at all.
                    rekey: vault.chains.some((row) => row.chainId === chain.id),
                    onProgress: note,
                });
                const record = updated.chains.find((row) => row.chainId === chain.id)!;
                recoveryOwner = toSolanaAddress({
                    algorithm: "ed25519",
                    bytes: hexToBytes(record.recoveryPubKeyHex),
                });

                const digest = registrationDigestFor(ctx, addresses, {
                    recoveryOwner,
                    veto,
                    configNonce: chainState.configNonce,
                });
                const priv = chain.keyAdapter.derivePrivateKey(rrs, chainContextOf(updated, record));
                try {
                    guardianSignature = (await chain.keyAdapter.sign(priv, digest)).bytes;
                } finally {
                    priv.fill(0);
                }
            } finally {
                // The root does not outlive the signature it was minted for.
                rrs.fill(0);
            }
            note(`recoveryOwner ${recoveryOwner}`);

            await registerGuardian(ctx, {
                addresses,
                recoveryOwner,
                veto,
                // `config_nonce`, never the epoch: it is what makes this registration spendable
                // once, so an old one cannot be replayed to revert a later rotation. The epoch
                // counts completed recoveries and moves independently.
                configNonce: chainState.configNonce,
                guardianSignature,
                via,
                onProgress: note,
            });

            // The ledger first, then the chain read: re-reading the chain against a stale record
            // is what made this look like a rotation that never finished.
            await onVaultChanged?.();
            setState((prev) => ({ ...prev, phase: "idle" }));
            setNonce((n) => n + 1);
        } catch (error) {
            setState((prev) => ({ ...prev, phase: "failed", error: messageOf(error) }));
        }
    }, [
        account,
        bindings.env.serverUrl,
        bindings.env.solanaRpcUrl,
        bindings.stores,
        chain,
        methods,
        note,
        onVaultChanged,
        vault,
    ]);

    /**
     * Install the module, or replace what is installed.
     *
     * The veto authorities come from the server because they are the *operator's* keys; only
     * `abortAuthority` is decided here, and it is this wallet's own EOA — an owner who still holds
     * their key can kill a recovery started against them. The SDK calls that the natural default:
     * the common case is not a rogue provider, it is a recovery opened while the owner still has
     * access, and the obvious party to stop that is whoever holds the key. Seed-derived is fine;
     * the one rule that survives is that the abort key must not be seal-gated, or it would inherit
     * the very liveness it exists to back up. See `settlement/evm/vetoConfig.ts`.
     */
    const protect = useCallback(async () => {
        if (solana) {
            await protectOnSolana();
            return;
        }
        if (account === undefined || moduleAddress === null || vault === null) return;
        setState((prev) => ({ ...prev, phase: "protecting", error: null, log: [], txHash: null }));

        try {
            // One action, on every chain. A chain not yet in the vault is added here rather than by
            // a separate button the reader has to find and press first — `addChain()` is free and
            // instant, and making it a prerequisite step made it look like a cost.
            let record = chainRecord;
            if (record === null) {
                const method = methods?.get(vault.gate.methodId) ?? null;
                if (method === null) {
                    throw new Error(
                        `This vault was sealed with "${vault.gate.methodId}", which is not ` +
                            "configured, so this chain cannot be added to it.",
                    );
                }
                const updated = await addChainToVault(bindings.stores, {
                    method,
                    vault,
                    chain,
                    account,
                    onProgress: note,
                });
                record = updated.chains.find((row) => row.chainId === chain.id) ?? null;
                await onVaultChanged?.();
            }
            if (record === null) throw new Error(`${chain.label} is not in this vault.`);

            const response = await fetch(`${bindings.env.serverUrl}/api/roles/relayer/config`);
            if (!response.ok) {
                throw new Error(
                    "The relayer is not reachable, so the veto authorities are unknown. Start it " +
                        "with `npm run dev:server`.",
                );
            }
            const config = (await response.json()) as RelayerConfig;

            // Built nested, validated, then flattened — never flattened first. `validateVetoConfig`
            // speaks the SDK's shape, and it is the only thing that will ever check this: the
            // module has no idea whether the pause authority also sits in the resume quorum, and
            // would install that config happily.
            const nested = demoVetoConfig({
                namespace: chain.namespace,
                pauseAuthority: config.pauseAuthority,
                // The wallet's own key — the SDK's natural default. See `vetoConfig.ts`.
                abortAuthority: account.signer.address,
                resumeMembers: config.resumeMembers,
                resumeThreshold: config.resumeThreshold,
                timelockSeconds: config.timelockSeconds,
                pauseCeilingSeconds: config.pauseCeilingSeconds,
            });
            validateDemoVetoConfig(nested);
            assertResumeQuorumPortable(nested);
            const veto: SolidityVetoConfig = toSolidityVetoConfig(nested);

            const recoveryOwner = recoveryOwnerAddress(record.recoveryPubKeyHex);
            note(`recoveryOwner ${recoveryOwner}`);

            const result = await protectAccount(
                {
                    rpcUrl: bindings.env.sepoliaRpcUrl,
                    bundlerUrl: bindings.env.bundlerUrl,
                    ownerPrivateKeyHex: account.signer.exportPrivateKeyHex_DEMO_ONLY(),
                    moduleAddress,
                    attester: bindings.env.moduleAttester,
                },
                {
                    recoveryOwner,
                    veto,
                    // An install over an existing one reverts `AlreadyInstalled`, so a replacement
                    // has to uninstall first — in the same operation.
                    ...(state.onchain?.installed === true ? { replacing: true } : {}),
                    onProgress: note,
                },
            );

            setState((prev) => ({ ...prev, phase: "idle", txHash: result.transactionHash }));
            // Re-read rather than assume: the chain is the source of truth for what is installed.
            setNonce((n) => n + 1);
        } catch (error) {
            setState((prev) => ({ ...prev, phase: "failed", error: messageOf(error) }));
        }
    }, [
        account,
        bindings.env,
        bindings.stores,
        chain,
        chainRecord,
        methods,
        moduleAddress,
        note,
        onVaultChanged,
        protectOnSolana,
        solana,
        state.onchain,
        vault,
    ]);

    return {
        // Masked rather than stored: switching chains must not leave the previous one's answer on
        // screen, and switching back must not have thrown it away. Both chains are read now, so
        // the mask covers only the ones that are not.
        state: evm || solana ? state : { ...state, onchain: null },
        protect,
        supported: evm || solana,

        refresh: () => setNonce((n) => n + 1),
    };
}

export type Settlement = ReturnType<typeof useSettlement>;

/** What the server's Solana relayer publishes — the twin of `RelayerConfig` for that chain. */
interface SolanaRelayerConfig {
    pauseAuthority: string;
    resumeMembers: string[];
    resumeThreshold: number;
    timelockSeconds: number;
    pauseCeilingSeconds: number;
}

async function fetchSolanaRelayerConfig(serverUrl: string): Promise<SolanaRelayerConfig> {
    const response = await fetch(`${serverUrl}/api/roles/relayer/solana/config`);
    if (!response.ok) {
        throw new Error(
            "The Solana relayer is not reachable, so the veto authorities are unknown — and the " +
                "program refuses a config where one party holds two of them, so there is no local " +
                "default to fall back to. Start the server with `npm run dev:server`, and check " +
                "SOLANA_RPC_URL is set.",
        );
    }
    return (await response.json()) as SolanaRelayerConfig;
}

function recoveryOwnerAddress(hex: string): Address {
    // Kept in step with `preflight.ts`, which derives the same address for its owner check.
    const body = hex.startsWith("0x") ? hex.slice(2) : hex;
    const bytes = new Uint8Array(body.length / 2);
    for (let i = 0; i < bytes.length; i += 1) {
        bytes[i] = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16);
    }
    // The SDK's own `toEvmAddress`, the one used at derivation time: a second implementation
    // here would make a checksum difference look like a key mismatch.
    return toEvmAddress({ algorithm: "secp256k1", bytes }) as Address;
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
