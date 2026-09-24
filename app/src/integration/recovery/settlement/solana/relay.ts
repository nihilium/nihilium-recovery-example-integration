/**
 * Handing a Solana recovery to the relayer, and reading back what the chain says.
 *
 * Two of the three recovery instructions take **no signer at all**: `initiate_recovery` and
 * `execute_recovery` are permissionless to submit, because authority travels in detached ed25519
 * signatures the program reads out of the `Ed25519SigVerify` instruction rather than in the
 * transaction's signers. That is the property the whole role rests on — a user who has lost access
 * has no funded key by definition, so a recovery that needed one would fail in exactly the case it
 * exists for.
 *
 * So the browser signs and the server sends, and the two never share a key. The guardian signature
 * goes over the wire; the relayer rebuilds the digest from the intent it is about to submit rather
 * than trusting a message the caller supplied.
 *
 * **To replace:** the route, if your relayer lives elsewhere. Nothing above these functions knows
 * it is HTTP. **Assumes:** the server is configured for the same cluster. Its `/config` publishes
 * which, because the cluster tag is folded into every digest — a mismatch is a rejection with no
 * reason attached, and comparing here is free.
 */
import type { PublicKey } from "@solana/web3.js";
import { VetoStateOrdinal } from "@nihilium/recovery-onchain-solana";
import type { VetoState } from "@nihilium/recovery-core";
import type { AttemptClock } from "../timelock.js";
import type { VaultProgram } from "./program.js";
import { projectedState, toIntent, type SolanaIntentInputs } from "./recovery.js";
import type { SolanaVaultAddresses } from "./addresses.js";

/** The vault's replay-protection counters and who it currently answers to. */
export interface SolanaVaultState {
    owner: string;
    recoveryOwner: string;
    epoch: number;
    nonce: number;
    /**
     * What a registration signature is bound to, and **not** the epoch.
     *
     * `config_nonce` advances on every rotation, which is what makes a registration spendable once:
     * without it an old registration could be replayed to revert a later one. The epoch counts
     * completed recoveries and moves independently, so using it here produces a digest the guardian
     * signed for nothing.
     */
    configNonce: number;
    registered: boolean;
    /**
     * The veto clock, **as one consistent snapshot**.
     *
     * The account is raw storage, so its state and its counters are equally old and therefore agree
     * with each other. `projectTimelock` needs exactly that pairing; see `timelock.ts` for why
     * substituting `projectedState()` here reports an account as recoverable a full ceiling early.
     */
    clock: AttemptClock;
}

/** `None` is the absence of an attempt, not a state the SDK names — so it maps to `null`. */
function toVetoState(ordinal: number): VetoState | null {
    switch (ordinal) {
        case VetoStateOrdinal.NONE:
            return null;
        case VetoStateOrdinal.INITIATED:
            return "INITIATED";
        case VetoStateOrdinal.PAUSED:
            return "PAUSED";
        case VetoStateOrdinal.EXECUTABLE:
            return "EXECUTABLE";
        case VetoStateOrdinal.EXECUTED:
            return "EXECUTED";
        case VetoStateOrdinal.ABORTED:
            return "ABORTED";
        default:
            // Treated as unsafe rather than mapped to the nearest known state.
            throw new Error(
                `Unknown veto state ${ordinal}: this build does not know it.`,
            );
    }
}

export async function readVaultState(
    ctx: VaultProgram,
    addresses: SolanaVaultAddresses,
): Promise<SolanaVaultState> {
    // `any` is Anchor's own shape for a fetched account; the fields are checked below by use.
    const account = await ctx.program.account["vault"]!.fetch(addresses.vault);
    const row = account as {
        owner: PublicKey;
        recoveryOwner: PublicKey;
        epoch: BNish;
        nonce: BNish;
        configNonce: BNish;
        registered: boolean;
        attempt: {
            state: number;
            accruedSeconds: BNish;
            pausedSeconds: BNish;
            checkpointTime: BNish;
        };
        veto: { timelockSeconds: BNish; pauseCeilingSeconds: BNish };
    };
    return {
        owner: row.owner.toBase58(),
        recoveryOwner: row.recoveryOwner.toBase58(),
        epoch: row.epoch.toNumber(),
        nonce: row.nonce.toNumber(),
        configNonce: row.configNonce.toNumber(),
        registered: row.registered,
        clock: {
            state: toVetoState(row.attempt.state),
            accruedSeconds: row.attempt.accruedSeconds.toNumber(),
            pausedSeconds: row.attempt.pausedSeconds.toNumber(),
            // `i64` on-chain: Solana's clock is a signed unix timestamp, unlike the EVM `uint64`.
            checkpointSeconds: row.attempt.checkpointTime.toNumber(),
            timelockSeconds: row.veto.timelockSeconds.toNumber(),
            pauseCeilingSeconds: row.veto.pauseCeilingSeconds.toNumber(),
        },
    };
}

/** Anchor hands back `BN` for every integer wider than 32 bits; only this much of it is used. */
interface BNish {
    toNumber(): number;
}

export interface RelayDeps {
    serverUrl: string;
    onProgress?: (message: string) => void;
}

/**
 * Open a recovery through the relayer.
 *
 * The digest is computed here so the guardian signs it here, and computed again by the server so it
 * vouches only for what it is submitting. Both derive it from the same intent; neither takes the
 * other's word.
 */
export async function relayInitiate(
    ctx: VaultProgram,
    params: {
        addresses: SolanaVaultAddresses;
        intent: SolanaIntentInputs;
        /** The recovered key's public half, base58. */
        guardianPublicKey: string;
        /** 64 bytes over the intent digest, produced by the recovered key. */
        signature: Uint8Array;
    } & RelayDeps,
): Promise<{ hash: string; digest: string }> {
    const { forDigest } = toIntent(params.intent);
    const digest = ctx.digests.intentDigest(ctx.programId, params.addresses.vault, forDigest);
    params.onProgress?.(`initiate      digest=${digest.toString("hex").slice(0, 16)}…`);

    return post<{ hash: string; digest: string }>(params.serverUrl, "initiate", {
        vault: params.addresses.vault.toBase58(),
        intent: params.intent,
        guardianPublicKey: params.guardianPublicKey,
        signature: toHex(params.signature),
    });
}

/** Finish it. No signature — the attempt already holds the digest, and the timelock gates this. */
export async function relayExecute(
    params: {
        addresses: SolanaVaultAddresses;
        /** Byte-identical to the one `initiate` was called with; the program re-hashes and compares. */
        intent: SolanaIntentInputs;
    } & RelayDeps,
): Promise<{ hash: string }> {
    return post<{ hash: string }>(params.serverUrl, "execute", {
        vault: params.addresses.vault.toBase58(),
        intent: params.intent,
    });
}

/** The digest the recovered key has to sign, so a caller can sign before it relays. */
export function intentDigestFor(
    ctx: VaultProgram,
    addresses: SolanaVaultAddresses,
    intent: SolanaIntentInputs,
): Uint8Array {
    const { forDigest } = toIntent(intent);
    return new Uint8Array(ctx.digests.intentDigest(ctx.programId, addresses.vault, forDigest));
}

async function post<T>(serverUrl: string, route: string, body: unknown): Promise<T> {
    const response = await fetch(`${serverUrl}/api/roles/relayer/solana/${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
    const parsed = (await response.json()) as T & { error?: string };
    if (!response.ok) {
        // A 404 is the honest answer when the server runs without `SOLANA_RPC_URL`: the routes are
        // not mounted rather than stubbed, so say that instead of reporting a send failure.
        throw new Error(
            parsed.error ??
                (response.status === 404
                    ? "The Solana relayer is not mounted. Set SOLANA_RPC_URL in server/.env."
                    : `The relayer refused with HTTP ${response.status}.`),
        );
    }
    return parsed;
}

function toHex(bytes: Uint8Array): string {
    return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * The same two halves the EVM reader returns, so the two chains answer one shape.
 *
 * Two round trips on purpose. The account read gives the stored snapshot the arithmetic needs;
 * `projected_state` *simulates* the instruction to get the state a user should be shown, which is
 * the only way to learn that a pause past its ceiling has already lifted. Collapsing them into one
 * read loses whichever question was not asked — see `timelock.ts`.
 */
export async function readAttemptClock(
    ctx: VaultProgram,
    addresses: SolanaVaultAddresses,
): Promise<{ projected: VetoState | null; clock: AttemptClock | null; state: SolanaVaultState }> {
    const state = await readVaultState(ctx, addresses);
    if (state.clock.state === null) {
        // No attempt. Simulating `projected_state` would answer `NONE` at the cost of a round trip.
        return { projected: null, clock: state.clock, state };
    }

    /**
     * The projection is an improvement on the stored state, not a substitute for reading at all.
     *
     * `projected_state` is a *view* instruction: Anchor runs it by simulating a transaction, which
     * is a whole extra failure surface — a simulation can be refused for reasons that have nothing
     * to do with the vault, and it was taking the entire row down with it. The account read above
     * has already succeeded at that point, and its state is honest; the only thing the projection
     * adds is noticing that a pause has passed its ceiling.
     *
     * So a failure here degrades to the stored state rather than to nothing. That is the safe
     * direction: the stored state of an auto-lifted pause is `PAUSED`, which under-promises — it
     * says the clock is held when it is running again, never the reverse.
     */
    try {
        const name = await projectedState(ctx, addresses);
        return { projected: name === "NONE" ? null : name, clock: state.clock, state };
    } catch {
        return { projected: state.clock.state, clock: state.clock, state };
    }
}
