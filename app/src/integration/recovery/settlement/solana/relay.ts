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
import type { VaultProgram } from "./program.js";
import { toIntent, type SolanaIntentInputs } from "./recovery.js";
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
        epoch: { toNumber(): number };
        nonce: { toNumber(): number };
        configNonce: { toNumber(): number };
        registered: boolean;
    };
    return {
        owner: row.owner.toBase58(),
        recoveryOwner: row.recoveryOwner.toBase58(),
        epoch: row.epoch.toNumber(),
        nonce: row.nonce.toNumber(),
        configNonce: row.configNonce.toNumber(),
        registered: row.registered,
    };
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
