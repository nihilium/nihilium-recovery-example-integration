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
import type { SealBlob, SealedDataEntry } from "@nihilium/recovery-core";
import type { GateRecord } from "../conditions/types.js";
import type { VaultChainRecord, VaultRecord } from "./vaultRecords.js";

/** The original: seal plus context, no records. Still read, never written. */
export const SEAL_FILE_FORMAT_V1 = "nihilium-demo-seal-file-v1";
export const SEAL_FILE_FORMAT = "nihilium-demo-seal-file-v2";

export interface SealFile {
    format: typeof SEAL_FILE_FORMAT | typeof SEAL_FILE_FORMAT_V1;
    exportedAt: number;
    vaultId: string;
    recordId: string;
    /** Bearer. The reason this file is not a backup you leave lying around. */
    seal: SealBlob;
    /** Non-bearer: inert without the seal, and required with it. */
    publicComponent: VaultRecord["publicComponent"];
    gate: GateRecord;
    chains: VaultChainRecord[];
    /**
     * The encrypted records — **v2 only**, and the whole reason v2 exists.
     *
     * v1 carried the seal and the context and nothing else, which meant an imported file only
     * opened a vault in a browser that already held its records: the browser that did not need the
     * file. On a fresh device it recovered nothing, and said so with the SDK's "holds no records"
     * error, which reads like the vault was empty.
     *
     * They are inert without the seal, so carrying them here costs nothing extra in secrecy — §12's
     * rule is the opposite of the seal's: duplicate records everywhere, never duplicate the seal.
     * The file as a whole is still bearer material, because the seal is in it.
     *
     * A real deployment gets these from the record host (`server/src/roles/records`) rather than
     * from a file. This demo has not built that role, and a file that cannot recover is worse than
     * a file that is bigger.
     */
    entries?: readonly SealedDataEntry[];
}

export function toSealFile(
    vault: VaultRecord,
    seal: SealBlob,
    entries: readonly SealedDataEntry[] = [],
): SealFile {
    return {
        format: SEAL_FILE_FORMAT,
        exportedAt: Date.now(),
        vaultId: vault.vaultId,
        recordId: vault.recordId,
        seal,
        publicComponent: vault.publicComponent,
        gate: vault.gate,
        chains: vault.chains,
        entries,
    };
}

/** What a v1 file cannot do, in one sentence, for a UI to render as a caution. */
export function sealFileLimitation(file: SealFile): string | null {
    if (file.format === SEAL_FILE_FORMAT && (file.entries?.length ?? 0) > 0) return null;
    return (
        "This file carries the seal but no encrypted records, so it can only open the vault on a " +
        "device that already holds them. Records are inert without the seal — copy them from the " +
        "browser that sealed this vault, or re-export the seal file from there."
    );
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
    if (file.format !== SEAL_FILE_FORMAT && file.format !== SEAL_FILE_FORMAT_V1) {
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
