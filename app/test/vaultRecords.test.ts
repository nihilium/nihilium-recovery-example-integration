/**
 * `nextVaultId`, which exists because re-sealing under the old id is a silent disaster.
 *
 * `vaultId` is an HKDF input, so a second seal under the same id derives the *same* recovery key
 * behind the new gate — the seal you thought you replaced still opens the account — and overwrites
 * the stored seal on the way, since `SealStore` keys by it. Nothing in the SDK notices, which is why
 * the uniqueness has to come from the id itself rather than from a count of what survives locally.
 */
import { describe, expect, it } from "vitest";
import { nextVaultId, type VaultRecord } from "../src/integration/recovery/vaultRecords.js";

const ACCOUNT = "0x1A2b3C4d5E6f708192a3b4c5d6e7f8091a2b3c4d";

function vault(vaultId: string): VaultRecord {
    return { vaultId } as VaultRecord;
}

describe("nextVaultId", () => {
    it("names a vault after its account, lower-cased and without the 0x", () => {
        expect(nextVaultId(ACCOUNT, [])).toMatch(/^vault-1a2b3c4d-[0-9a-z]{6}$/);
    });

    it("never repeats, even against an empty list", () => {
        // The case that matters: auto-discard removes the replaced vault, so by the time a third
        // gate is minted the list can be empty again. A counter over `existing` would hand out an id
        // a discarded vault already used — and the seal file for it is still on the user's disk.
        const minted = new Set(Array.from({ length: 500 }, () => nextVaultId(ACCOUNT, [])));
        expect(minted.size).toBe(500);
    });

    it("avoids an id this device already holds", () => {
        const first = nextVaultId(ACCOUNT, []);
        expect(nextVaultId(ACCOUNT, [vault(first)])).not.toBe(first);
    });

    it("ignores vaults belonging to other accounts", () => {
        const existing = [vault("vault-ffffffff-aaaaaa"), vault("vault-00000000-bbbbbb")];
        expect(nextVaultId(ACCOUNT, existing)).toMatch(/^vault-1a2b3c4d-/);
    });

    it("handles an account id that is not 0x-prefixed", () => {
        // Solana and Zcash account ids are not hex and not prefixed; slicing "0x" off blindly would
        // eat two characters of a base58 address.
        expect(nextVaultId("So11111111111111111111111111111111111111112", [])).toMatch(
            /^vault-so111111-/,
        );
    });
});
