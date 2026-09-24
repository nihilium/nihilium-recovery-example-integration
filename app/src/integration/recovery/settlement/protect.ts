/**
 * Telling a chain about a vault's recovery key — reading what it holds, and putting it there.
 *
 * Sealing produces a recovery key; nothing on chain honours it until this runs. Both halves live
 * here rather than in a React hook because neither is about React, and because a function closed
 * over "the chain on screen" can only ever protect the chain on screen — which is what made
 * protecting a two-chain vault two separate errands.
 *
 * **One action, on every chain.** A chain the gate has not reached yet is added as part of
 * protecting it rather than by a separate button pressed first: `addChain()` is free, local and
 * instant, and making it a prerequisite step made the free half read as a cost.
 *
 * **The two chains do genuinely different things**, and the difference is not cosmetic. On EVM the
 * account installs a module and the recovery key is named in its init data, so the key can be
 * derived beforehand. On Solana `register` must be **signed by the incoming recovery key**, and the
 * digest it signs binds a `config_nonce` that is not knowable until the vault is read — so there,
 * sealing the chain into the vault and registering it are necessarily one operation, and the root
 * is minted, used once and wiped inside it.
 *
 * **To replace:** `SettlementEnv`, the two chain-id checks in `supportsSettlement`, and the
 * `fetch` calls to this demo's server. The veto authorities are the *operator's* keys and have to
 * come from wherever your operator keeps them; only `abortAuthority` is decided here, and it is the
 * wallet's own key.
 * **Assumes:** the account passed in is the one the vault record names for this chain, and that the
 * server publishing the veto authorities is the same one that will relay the recovery. A config
 * from one operator and a relayer from another installs a gate nobody can pause.
 */
import { createPublicClient, http, type Address, type Hex, type PublicClient } from "viem";
// noble's, not viem's: the vault records these keys with `bytesToHex`, which writes no `0x`, and
// viem's decoder demands one.
import { hexToBytes } from "@noble/hashes/utils.js";
import { sepolia } from "viem/chains";
import { recoveryModuleAddress } from "@nihilium/recovery-onchain-evm";
import { generateRRS, type VetoState } from "@nihilium/recovery-core";
import { toEvmAddress } from "@nihilium/recovery-key-evm";
import { toSolanaAddress } from "@nihilium/recovery-key-solana";
import type { ChainModule, DerivedAccount } from "../../chains/types.js";
import type { MethodRegistry } from "../../conditions/types.js";
import { addChainToVault, type VaultDeps } from "../vault.js";
import { chainContextOf, type VaultRecord } from "../vaultRecords.js";
import { protectAccount } from "./evm/install.js";
import { createModuleReader, readAttemptClock as readEvmAttemptClock } from "./evm/reads.js";
import { isProtectedByVault } from "./evm/preflight.js";
import {
    assertResumeQuorumPortable,
    demoVetoConfig,
    toSolidityVetoConfig,
    validateDemoVetoConfig,
    type SolidityVetoConfig,
} from "./evm/vetoConfig.js";
import { solanaVaultAddresses } from "./solana/addresses.js";
import { createVaultProgram, keypairFromSecret } from "./solana/program.js";
import { createVault, registerGuardian, registrationDigestFor } from "./solana/vault.js";
import { readAttemptClock, readVaultState } from "./solana/relay.js";
import { loadFeePayer } from "./solana/submit.js";
import type { AttemptClock } from "./timelock.js";

const EVM_CHAIN_ID = "evm-sepolia";
const SOLANA_CHAIN_ID = "solana-devnet";

/**
 * Whether this build can register a recovery key on a chain at all.
 *
 * Chain ids, because `ChainModule.settlement` is `null` on every chain in this repo — the
 * `SettlementBinding` seam exists and nothing fills it. That is the right place for this answer to
 * come from eventually; until it does, a lie here is better than a lie there.
 */
export function supportsSettlement(chainId: string): boolean {
    return chainId === EVM_CHAIN_ID || chainId === SOLANA_CHAIN_ID;
}

/** Exactly the configuration these two chains need, so the demo's own env can satisfy it. */
export interface SettlementEnv {
    chainId: number;
    serverUrl: string;
    sepoliaRpcUrl: string;
    bundlerUrl: string;
    moduleAttester: `0x${string}`;
    solanaRpcUrl: string;
}

export interface ProtectDeps {
    env: SettlementEnv;
    stores: VaultDeps;
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
     *
     * **The projected state**, not the stored one: a pause past its ceiling has lifted in every
     * sense that matters, and rendering it as still paused would show a freeze that is over. This is
     * the value to render and to gate an execute on — and, deliberately, *not* the one `clock`
     * carries. See `timelock.ts`.
     */
    attempt: VetoState | null;
    /**
     * The veto clock as one consistent snapshot, for `projectTimelock`. `null` where the chain has
     * no attempt or was not read.
     *
     * Its `state` is the **stored** one, which can disagree with `attempt` above. That is not a bug
     * to reconcile: the counters belong to the stored state, and pairing them with the projected one
     * drops an elapsed pause ceiling and reports the account recoverable early.
     */
    clock: AttemptClock | null;
    intentHash: Hex | null;
}

/** What "never protected" looks like where the protected account must be created first. */
const NOTHING: OnChainState = {
    installed: false,
    recoveryOwner: null,
    matchesVault: false,
    attempt: null,
    clock: null,
    intentHash: null,
};

export interface ReadProtectionParams {
    chain: ChainModule;
    account: DerivedAccount;
    /** `null` is legitimate on EVM — the module can hold a key for a vault this browser never had. */
    vault: VaultRecord | null;
}

/**
 * What the chain currently holds for this account. `null` where there is nothing to ask.
 *
 * Reads rather than remembers: `installed` and `recoveryOwner` come off the chain every time,
 * because the account can be changed by anything holding its key and a cached answer would be this
 * app's belief rather than the chain's state. That is also what makes `stale` detectable at all — a
 * vault whose key the chain does not hold.
 *
 * Throws on an unreadable chain. An unreadable chain is not an unprotected account and the caller
 * must not render it as one — and, just as importantly, `null` here means only "this build does not
 * settle that chain". A chain the vault has not reached yet still gets read and still gets an
 * answer, because it is the chain most likely to need protecting.
 */
export async function readProtection(
    deps: ProtectDeps,
    params: ReadProtectionParams,
): Promise<OnChainState | null> {
    if (params.chain.id === SOLANA_CHAIN_ID) return readSolana(deps, params);
    if (params.chain.id === EVM_CHAIN_ID) return readEvm(deps, params);
    return null;
}

async function readSolana(
    deps: ProtectDeps,
    params: ReadProtectionParams,
): Promise<OnChainState> {
    /**
     * `undefined` where the gate has not reached this chain yet — and that is a state to report,
     * not a reason to stop.
     *
     * This used to return early, which was right when the only caller was a per-chain hook that
     * wanted "leave the badge alone". It is wrong for a caller asking which chains need protecting:
     * a chain the vault does not cover is *exactly* the chain that needs it, and bailing made it
     * indistinguishable from a chain that could not be read — so it was skipped, silently, with
     * funds on it.
     */
    const record = params.vault?.chains.find((row) => row.chainId === params.chain.id);

    const ctx = createVaultProgram({
        rpcUrl: deps.env.solanaRpcUrl,
        cluster: "devnet",
        payer: keypairFromSecret(params.account.signer.exportPrivateKeyHex_DEMO_ONLY()),
    });
    const addresses = solanaVaultAddresses({
        cluster: "devnet",
        creator: params.account.signer.address,
    });
    const info = await ctx.connection.getAccountInfo(addresses.vault, "confirmed");
    // No vault account at all. Not an error — it is what "never protected" looks like on a chain
    // where the protected account has to be created first.
    if (info === null) return NOTHING;

    const { projected, clock, state: chainState } = await readAttemptClock(ctx, addresses);
    // No record means there is nothing of this vault's to match against, so the answer is no — the
    // chain may well hold a key, just not one this gate issued.
    const expected =
        record === undefined
            ? null
            : toSolanaAddress({
                  algorithm: "ed25519",
                  bytes: hexToBytes(record.recoveryPubKeyHex),
              });

    return {
        installed: chainState.registered,
        recoveryOwner: chainState.registered ? chainState.recoveryOwner : null,
        // The chain holding *a* key is not the chain holding *this vault's* key — the difference is
        // the whole of the `stale` state.
        matchesVault:
            expected !== null && chainState.registered && chainState.recoveryOwner === expected,
        attempt: projected,
        clock,
        // The vault stores `intent_digest`, not the intent, and the digest is not what EVM's
        // `intentHash` is. Left null rather than filled with a lookalike.
        intentHash: null,
    };
}

async function readEvm(
    deps: ProtectDeps,
    params: ReadProtectionParams,
): Promise<OnChainState | null> {
    const accountId = params.account.accountId;
    if (accountId === undefined) return null;
    const moduleAddress = recoveryModuleAddress(deps.env.chainId) as Address;
    const chainRecord = params.vault?.chains.find((row) => row.chainId === params.chain.id) ?? null;

    const client = createPublicClient({
        chain: sepolia,
        transport: http(deps.env.sepoliaRpcUrl),
    }) as PublicClient;
    const module = createModuleReader(client, moduleAddress, params.chain.namespace);

    const installed = await module.isInitialized(accountId as Address);
    const config = installed ? await module.configOf(accountId as Address) : null;
    const attempt = installed ? await readEvmAttemptClock(module, accountId as Address) : null;
    const intentHash = installed ? (await module.attemptOf(accountId as Address)).intentHash : null;
    const matchesVault =
        chainRecord === null || !installed
            ? false
            : await isProtectedByVault(module, accountId as Address, chainRecord.recoveryPubKeyHex);

    return {
        installed,
        recoveryOwner: config?.recoveryOwner ?? null,
        matchesVault,
        attempt: attempt?.projected ?? null,
        clock: attempt?.clock ?? null,
        intentHash: intentHash ?? null,
    };
}

export interface ProtectParams {
    chain: ChainModule;
    account: DerivedAccount;
    vault: VaultRecord;
    /**
     * Needed only where registering *mints* a key rather than merely naming one.
     *
     * Solana's `register` is signed by the incoming guardian, so protecting there runs `addChain()`
     * as part of the same operation — and `addChain()` needs the method this vault was sealed with.
     */
    methods: MethodRegistry | null;
    /** Whether the chain already holds a module. An install over one reverts `AlreadyInstalled`. */
    installed: boolean;
    onProgress?(message: string): void;
    /**
     * Called when this has written to the vault ledger itself, before the chain is re-read.
     *
     * Protecting on Solana mints a fresh key for the chain, so it goes through `addChainToVault` —
     * making this a second writer of state the app's flow owns. Without telling it, the badge
     * compares the chain's new recovery owner against the record it replaced and reads `stale`
     * forever.
     */
    onVaultChanged?(): void | Promise<void>;
}

export interface ProtectResult {
    /** `null` on Solana, where the fee payer's send is the transaction and the id is not returned. */
    txHash: string | null;
}

/** Throws with the reason on failure. A caller protecting several chains catches per chain. */
export async function protectChain(
    deps: ProtectDeps,
    params: ProtectParams,
): Promise<ProtectResult> {
    if (params.chain.id === SOLANA_CHAIN_ID) return protectOnSolana(deps, params);
    if (params.chain.id === EVM_CHAIN_ID) return protectOnEvm(deps, params);
    throw new Error(`This build cannot register a recovery key on ${params.chain.label}.`);
}

/**
 * Protect on Solana: create the vault if it does not exist, then register the guardian.
 *
 * Two instructions rather than one because they are two different facts. `create_vault` brings the
 * **account recovery protects** into existence — a keypair's address is its public key and cannot be
 * recovered, so the protected thing has to be a program-owned PDA, created in advance. `register`
 * binds this vault's recovery key to it.
 *
 * Both go through the fee payer when the server offers one, so an owner with zero SOL can still do
 * this. That matters more here than on EVM: the PDAs need rent before they exist at all, and rent is
 * not something a faucet-less demo can conjure.
 */
async function protectOnSolana(
    deps: ProtectDeps,
    params: ProtectParams,
): Promise<ProtectResult> {
    const { chain, account, vault } = params;
    const note = params.onProgress ?? (() => undefined);
    const method = params.methods?.get(vault.gate.methodId) ?? null;
    if (method === null) {
        // Registering mints a fresh key for this chain, and that needs the vault's own method.
        throw new Error(
            `Vault sealed with "${vault.gate.methodId}", which is not configured in this app.`,
        );
    }

    const owner = keypairFromSecret(account.signer.exportPrivateKeyHex_DEMO_ONLY());
    const ctx = createVaultProgram({
        rpcUrl: deps.env.solanaRpcUrl,
        cluster: "devnet",
        payer: owner,
    });
    const addresses = solanaVaultAddresses({
        cluster: "devnet",
        creator: account.signer.address,
    });

    // The operator's veto authorities, and the only source for them: the program refuses a config
    // where one party holds two roles, so there is no local placeholder that works.
    const solanaConfig = await fetchSolanaRelayerConfig(deps.env.serverUrl);

    // `null` when the server runs without Solana configured. The demo still works — the owner pays
    // — so this falls back rather than refusing, and says which one happened.
    const feePayer = await loadFeePayer(deps.env.serverUrl);
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

    // Read, never assumed: `configNonce` is what makes a registration spendable once, so a stale one
    // cannot be replayed to revert a later rotation.
    const chainState = await readVaultState(ctx, addresses);

    const veto = {
        // Three parties, three keys — the program checks this and refuses
        // `PauseAndAbortHeldByOneParty` and its siblings outright.
        pauseAuthority: solanaConfig.pauseAuthority,
        // The wallet's own key, as on EVM: the common case is not a rogue provider, it is a recovery
        // opened while the owner still has access, and the party who should stop that is whoever
        // holds the key.
        abortAuthority: account.signer.address,
        resumeMembers: solanaConfig.resumeMembers,
        resumeThreshold: solanaConfig.resumeThreshold,
        // The owner's choice, made at seal time; the operator's default for older vaults.
        timelockSeconds: vault.timelockSeconds ?? solanaConfig.timelockSeconds,
        pauseCeilingSeconds: solanaConfig.pauseCeilingSeconds,
    };

    // **The recovery key has to sign its own registration**, and the app only ever receives its
    // public half from `addChain()`. So this mints the root here, keeps it for exactly one
    // signature, and wipes it — which is also why sealing and registering are a single operation on
    // this chain: the digest binds the veto fingerprint and `config_nonce`, neither of which is
    // knowable before now.
    const rrs = generateRRS();
    let guardianSignature: Uint8Array;
    let recoveryOwner: string;
    try {
        const updated = await addChainToVault(deps.stores, {
            method,
            vault,
            chain,
            account,
            recoveryKey: { kind: "rrs", rrs },
            // A chain already in the vault holds a key whose root nobody kept, so it can never sign.
            // Minting a fresh one is the only way to register at all.
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
        // `config_nonce`, never the epoch: it is what makes this registration spendable once, so an
        // old one cannot be replayed to revert a later rotation. The epoch counts completed
        // recoveries and moves independently.
        configNonce: chainState.configNonce,
        guardianSignature,
        via,
        onProgress: note,
    });

    // The ledger first, then the chain read: re-reading the chain against a stale record is what
    // made this look like a rotation that never finished.
    await params.onVaultChanged?.();
    return { txHash: null };
}

/**
 * Install the module, or replace what is installed.
 *
 * The veto authorities come from the server because they are the *operator's* keys; only
 * `abortAuthority` is decided here, and it is this wallet's own EOA — an owner who still holds their
 * key can kill a recovery started against them. The SDK calls that the natural default: the common
 * case is not a rogue provider, it is a recovery opened while the owner still has access, and the
 * obvious party to stop that is whoever holds the key. Seed-derived is fine; the one rule that
 * survives is that the abort key must not be seal-gated, or it would inherit the very liveness it
 * exists to back up. See `evm/vetoConfig.ts`.
 */
async function protectOnEvm(deps: ProtectDeps, params: ProtectParams): Promise<ProtectResult> {
    const { chain, account, vault } = params;
    const note = params.onProgress ?? (() => undefined);
    const moduleAddress = recoveryModuleAddress(deps.env.chainId) as Address;

    // One action, on every chain. A chain not yet in the vault is added here rather than by a
    // separate button the reader has to find and press first — `addChain()` is free and instant, and
    // making it a prerequisite step made it look like a cost.
    let record = vault.chains.find((row) => row.chainId === chain.id) ?? null;
    if (record === null) {
        const method = params.methods?.get(vault.gate.methodId) ?? null;
        if (method === null) {
            throw new Error(
                `Vault sealed with "${vault.gate.methodId}", which is not configured in this app.`,
            );
        }
        const updated = await addChainToVault(deps.stores, {
            method,
            vault,
            chain,
            account,
            onProgress: note,
        });
        record = updated.chains.find((row) => row.chainId === chain.id) ?? null;
        await params.onVaultChanged?.();
    }
    if (record === null) throw new Error(`${chain.label} is not in this vault.`);

    const response = await fetch(`${deps.env.serverUrl}/api/roles/relayer/config`);
    if (!response.ok) {
        // The veto authorities are the operator's keys and come only from the server.
        throw new Error(
            "Relayer not reachable. Run `npm run dev:server`.",
        );
    }
    const config = (await response.json()) as RelayerConfig;

    // Built nested, validated, then flattened — never flattened first. `validateVetoConfig` speaks
    // the SDK's shape, and it is the only thing that will ever check this: the module has no idea
    // whether the pause authority also sits in the resume quorum, and would install that config
    // happily.
    const nested = demoVetoConfig({
        namespace: chain.namespace,
        pauseAuthority: config.pauseAuthority,
        // The wallet's own key — the SDK's natural default. See `vetoConfig.ts`.
        abortAuthority: account.signer.address,
        resumeMembers: config.resumeMembers,
        resumeThreshold: config.resumeThreshold,
        // The owner's choice, made at seal time; the operator's default for older vaults.
        timelockSeconds: vault.timelockSeconds ?? config.timelockSeconds,
        pauseCeilingSeconds: config.pauseCeilingSeconds,
    });
    validateDemoVetoConfig(nested);
    assertResumeQuorumPortable(nested);
    const veto: SolidityVetoConfig = toSolidityVetoConfig(nested);

    const recoveryOwner = recoveryOwnerAddress(record.recoveryPubKeyHex);
    note(`recoveryOwner ${recoveryOwner}`);

    const result = await protectAccount(
        {
            rpcUrl: deps.env.sepoliaRpcUrl,
            bundlerUrl: deps.env.bundlerUrl,
            ownerPrivateKeyHex: account.signer.exportPrivateKeyHex_DEMO_ONLY(),
            moduleAddress,
            attester: deps.env.moduleAttester,
        },
        {
            recoveryOwner,
            veto,
            // An install over an existing one reverts `AlreadyInstalled`, so a replacement has to
            // uninstall first — in the same operation.
            ...(params.installed ? { replacing: true } : {}),
            onProgress: note,
        },
    );

    return { txHash: result.transactionHash };
}

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
        // The program refuses a config where one party holds two roles, so there is no local default.
        throw new Error(
            "Solana relayer not reachable. Run `npm run dev:server` with SOLANA_RPC_URL set.",
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
    // The SDK's own `toEvmAddress`, the one used at derivation time: a second implementation here
    // would make a checksum difference look like a key mismatch.
    return toEvmAddress({ algorithm: "secp256k1", bytes }) as Address;
}
