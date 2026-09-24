/**
 * The file a user is handed at seal time, and the thing v1 could not do.
 *
 * v1 carried the seal and the chain context and **not** the encrypted records — so importing it
 * only worked in a browser that already held them, which is the browser that did not need the file.
 * On a fresh device it recovered nothing and reported the SDK's "holds no records" error, which
 * reads as though the vault was empty rather than as though the file was incomplete.
 *
 * Records are inert without the seal, so carrying them costs nothing in secrecy: §12's rule for
 * records is the opposite of the seal's. The file as a whole stays bearer material, because the
 * seal is in it.
 */
import { describe, expect, it } from "vitest";
import {
    SEAL_FILE_FORMAT,
    SEAL_FILE_FORMAT_V1,
    parseSealFile,
    sealFileLimitation,
    sealFileName,
    toSealFile,
    type SealFile,
} from "../src/integration/recovery/sealFile.js";
import type { VaultRecord } from "../src/integration/recovery/vaultRecords.js";

const VAULT = {
    vaultId: "vault-abc123",
    recordId: "AAAA-BBBB-CCCC",
    publicComponent: { format: "demo", recordId: "AAAA-BBBB-CCCC" },
    gate: { methodId: "email-quorum", threshold: 2, summary: "any 2 of 3" },
    chains: [{ chainId: "evm-sepolia", accountId: "0xabc" }],
} as unknown as VaultRecord;

const SEAL = { format: "demo-seal", payload: { anything: true } } as never;
const ENTRIES = [
    { entryId: "e1", record: { format: "demo-record", payload: {} } },
    { entryId: "e2", record: { format: "demo-record", payload: {} } },
] as never[];

describe("writing a seal file", () => {
    it("writes v2 and carries the records", () => {
        const file = toSealFile(VAULT, SEAL, ENTRIES);
        expect(file.format).toBe(SEAL_FILE_FORMAT);
        expect(file.entries).toHaveLength(2);
        expect(file.vaultId).toBe("vault-abc123");
    });

    it("names the file by vault, never by a guardian", () => {
        // A filename is visible in a directory listing and in a download bar. `alice@gmail.com.seal`
        // discloses a guardian to anyone who glances at either.
        expect(sealFileName(VAULT)).toBe("vault-vault-abc123.seal.json");
        expect(sealFileName(VAULT)).not.toMatch(/@/);
    });

    it("round-trips through JSON", () => {
        const parsed = parseSealFile(JSON.stringify(toSealFile(VAULT, SEAL, ENTRIES)));
        expect(parsed.entries).toHaveLength(2);
        expect(parsed.gate.summary).toBe("any 2 of 3");
    });
});

describe("reading an older file", () => {
    const v1: SealFile = {
        format: SEAL_FILE_FORMAT_V1,
        exportedAt: 1,
        vaultId: "vault-old",
        recordId: "AAAA-BBBB-CCCC",
        seal: SEAL,
        publicComponent: VAULT.publicComponent,
        gate: VAULT.gate,
        chains: VAULT.chains,
    };

    it("still loads, rather than being refused for being old", () => {
        // Refusing would strand every file already on somebody's disk — and the seal in it is the
        // only copy of the bearer half for a vault whose seed may be gone.
        const parsed = parseSealFile(JSON.stringify(v1));
        expect(parsed.vaultId).toBe("vault-old");
    });

    it("says what it cannot do instead of failing later with a confusing error", () => {
        expect(sealFileLimitation(v1)).toContain("no encrypted records");
        expect(sealFileLimitation(toSealFile(VAULT, SEAL, ENTRIES))).toBeNull();
    });

    it("treats a v2 file with an empty record list as the same limitation", () => {
        // Same practical outcome as v1, so it gets the same warning rather than a silent pass.
        expect(sealFileLimitation(toSealFile(VAULT, SEAL, []))).toContain("no encrypted records");
    });
});

describe("refusing a file that is not one of ours", () => {
    it("names what it got rather than saying 'invalid'", () => {
        expect(() => parseSealFile(JSON.stringify({ format: "something-else" }))).toThrow(
            /something-else/,
        );
    });

    it("refuses non-JSON", () => {
        expect(() => parseSealFile("not json at all")).toThrow(/not JSON/);
    });

    it("refuses a file carrying no gate or no chains", () => {
        const gutted = { ...toSealFile(VAULT, SEAL, ENTRIES), chains: [] };
        expect(() => parseSealFile(JSON.stringify(gutted))).toThrow(/incomplete/);
    });
});
