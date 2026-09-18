/**
 * The seal, as a file a user can actually keep.
 *
 * Two halves go in, and the difference between them is the §12 rule the whole design rests on:
 *
 * - **the seal** — bearer material. Whoever holds it may *attempt* a recovery, and only the identity
 *   gate and the on-chain veto stand in the way. It must not live in the same domain as the identity
 *   factor it is gated behind, which is why this app will not mail it to a guardian's address.
 * - **the context** — `vaultId`, `epoch`, `accountId`, the namespaces, the recovery public keys.
 *   None of it is secret, and none of it can be re-derived from the seal: `epoch` in particular is
 *   an HKDF input that the envelope does not carry, so a recovery without it derives the wrong key
 *   in silence.
 *
 * **To replace:** nothing, to keep this shape. A wallet that already backs up metadata may ship the
 * seal alone and re-derive the context from its own records — and a wallet that does neither has a
 * user who cannot recover.
 * **Assumes:** the file is treated as bearer material end to end. It is not encrypted here, because
 * encrypting it under a password the user also lost would be theatre.
 */
import type { SealBlob } from "@nihilium/recovery-core";
import type { GateRecord } from "../conditions/types.js";
import type { VaultChainRecord, VaultRecord } from "./vaultRecords.js";

export const SEAL_FILE_FORMAT = "nihilium-demo-seal-file-v1";

export interface SealFile {
    format: typeof SEAL_FILE_FORMAT;
    exportedAt: number;
    vaultId: string;
    recordId: string;
    /** Bearer. The reason this file is not a backup you leave lying around. */
    seal: SealBlob;
    /** Non-bearer: inert without the seal, and required with it. */
    publicComponent: VaultRecord["publicComponent"];
    gate: GateRecord;
    chains: VaultChainRecord[];
}

export function toSealFile(vault: VaultRecord, seal: SealBlob): SealFile {
    return {
        format: SEAL_FILE_FORMAT,
        exportedAt: Date.now(),
        vaultId: vault.vaultId,
        recordId: vault.recordId,
        seal,
        publicComponent: vault.publicComponent,
        gate: vault.gate,
        chains: vault.chains,
    };
}

export class SealFileError extends Error {
    override readonly name = "SealFileError";
}

export function parseSealFile(text: string): SealFile {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new SealFileError("That file is not JSON, so it is not a seal file this app wrote.");
    }
    const file = parsed as Partial<SealFile>;
    if (file.format !== SEAL_FILE_FORMAT) {
        throw new SealFileError(
            `Expected a ${SEAL_FILE_FORMAT} file; got "${String(file.format)}". A seal from a live ` +
                "ceremony and one from a simulated run are not interchangeable.",
        );
    }
    if (!file.seal || !file.gate || !Array.isArray(file.chains) || file.chains.length === 0) {
        throw new SealFileError("That seal file is incomplete — it carries no gate or no chains.");
    }
    return file as SealFile;
}

/** `vault-<id>.seal.json`, never the guardian's address: a filename is visible in a file listing. */
export function sealFileName(vault: { vaultId: string }): string {
    return `vault-${vault.vaultId}.seal.json`;
}
