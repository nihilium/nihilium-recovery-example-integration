/**
 * The file a user is handed at seal time: the seal and the instructions, never the records.
 *
 * v1 carried the seal and the chain context and not the records, so it only opened a vault in the
 * browser that already held them. v2 fixed that by copying the records in — and so froze them on
 * download day: a chain added later was simply not in the file, and a recovery from it did not know
 * the chain existed. v3 carries *where* the records live instead. The records and every chain's
 * context are on the record host, and a file downloaded once keeps recovering a vault that grows.
 */
import { describe, expect, it } from "vitest";
import {
    SEAL_FILE_FORMAT,
    SEAL_FILE_FORMAT_V1,
    SEAL_FILE_FORMAT_V2,
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
    recordHosts: ["https://host.example/api"],
} as unknown as VaultRecord;

const SEAL = { format: "demo-seal", payload: { anything: true } } as never;
const ENTRIES = [
    { entryId: "e1", record: { format: "demo-record", payload: {} } },
    { entryId: "e2", record: { format: "demo-record", payload: {} } },
] as never[];

describe("writing a seal file", () => {
    it("writes v3: the seal and where the records live, and no records", () => {
        const file = toSealFile(VAULT, SEAL);
        expect(file.format).toBe(SEAL_FILE_FORMAT);
        expect(file.recordHosts).toEqual(["https://host.example/api"]);
        expect(file.entries).toBeUndefined();
        expect(file.vaultId).toBe("vault-abc123");
    });

    it("names the file by vault, never by a guardian", () => {
        // A filename is visible in a directory listing and in a download bar. `alice@gmail.com.seal`
        // discloses a guardian to anyone who glances at either.
        expect(sealFileName(VAULT)).toBe("vault-vault-abc123.seal.json");
        expect(sealFileName(VAULT)).not.toMatch(/@/);
    });

    it("round-trips through JSON", () => {
        const parsed = parseSealFile(JSON.stringify(toSealFile(VAULT, SEAL)));
        expect(parsed.recordHosts).toEqual(["https://host.example/api"]);
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
    const v2: SealFile = { ...v1, format: SEAL_FILE_FORMAT_V2, entries: ENTRIES };

    it("still loads, rather than being refused for being old", () => {
        // Refusing would strand every file already on somebody's disk — and the seal in it is the
        // only copy of the bearer half for a vault whose seed may be gone.
        expect(parseSealFile(JSON.stringify(v1)).vaultId).toBe("vault-old");
        expect(parseSealFile(JSON.stringify(v2)).entries).toHaveLength(2);
    });

    it("says what it cannot do instead of failing later with a confusing error", () => {
        expect(sealFileLimitation(v1)).toContain("no encrypted records");
        expect(sealFileLimitation(v2)).toBeNull();
        expect(sealFileLimitation(toSealFile(VAULT, SEAL))).toBeNull();
    });

    it("warns about a v3 file that names no record host", () => {
        // Same practical outcome as v1: nothing in the file says where the records are.
        const hostless = toSealFile({ ...VAULT, recordHosts: [] } as VaultRecord, SEAL);
        expect(sealFileLimitation(hostless)).toContain("names no record host");
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
        const gutted = { ...toSealFile(VAULT, SEAL), chains: [] };
        expect(() => parseSealFile(JSON.stringify(gutted))).toThrow(/incomplete/);
    });
});
