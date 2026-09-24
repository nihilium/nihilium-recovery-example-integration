/**
 * Which vaults a browser can still open, and which of them need opening.
 *
 * The rule under test is one this app got wrong for its whole life: the vault that most needs a
 * recovery is the one whose seed is *gone*, and a screen keyed on "the account you are signed into"
 * can never show it. Before this existed, making a new seed left the old seed's gate unreachable —
 * the exact situation recovery is for.
 */
import { describe, expect, it } from "vitest";
import { groupRecoveries, isEmpty, seedRecovery } from "../src/integration/recovery/recoveryCatalogue.js";
import type { VaultRecord } from "../src/integration/recovery/vaultRecords.js";

function vault(over: Partial<VaultRecord> & Pick<VaultRecord, "vaultId" | "walletId">): VaultRecord {
    return {
        recordId: "AAAA-BBBB-CCCC" as VaultRecord["recordId"],
        createdAt: 1,
        ceremonyMs: 0,
        publicComponent: {} as VaultRecord["publicComponent"],
        gate: {} as VaultRecord["gate"],
        chains: [],
        spent: null,
        ...over,
    } as VaultRecord;
}

const MINE = vault({ vaultId: "v-mine", walletId: "case…alien", createdAt: 10 });
const ORPHAN = vault({ vaultId: "v-orphan", walletId: "gone…forever", createdAt: 20 });

describe("groupRecoveries", () => {
    it("puts a vault whose seed is gone in `lost`", () => {
        const { lost, present } = groupRecoveries({
            vaults: [MINE, ORPHAN],
            seals: [{ vaultId: "v-mine", storedAt: 0 }, { vaultId: "v-orphan", storedAt: 0 }],
            knownWalletIds: ["case…alien"],
        });
        expect(lost.map((row) => row.vault.vaultId)).toEqual(["v-orphan"]);
        expect(present.map((row) => row.vault.vaultId)).toEqual(["v-mine"]);
    });

    it("keeps a lost vault listed even with no seed in the book at all", () => {
        // A cleared seed book, or a browser that only ever imported a seal file. Every vault is
        // lost, and every one of them is exactly what this screen is for.
        const { lost } = groupRecoveries({
            vaults: [MINE, ORPHAN],
            seals: [],
            knownWalletIds: [],
        });
        expect(lost).toHaveLength(2);
    });

    it("reports a missing seal rather than hiding the vault", () => {
        /**
         * The seal is the unrecoverable half: records are inert and meant to be copied everywhere
         * (§12), so a vault with records and no seal cannot be opened from here at all. Dropping the
         * row would leave a user with no way to learn that the file they were handed is now the only
         * way in.
         */
        const { lost } = groupRecoveries({
            vaults: [ORPHAN],
            seals: [],
            knownWalletIds: [],
        });
        expect(lost[0]!.hasSeal).toBe(false);
        expect(lost[0]!.vault.vaultId).toBe("v-orphan");
    });

    it("sorts newest first, so a superseded gate is never the top row", () => {
        // Re-sealing mints a new vault under a new id and discards the old one — but a run that
        // died between the two leaves both. Offering the older one first opens the replaced gate.
        const older = vault({ vaultId: "v-old", walletId: "gone…forever", createdAt: 5 });
        const { lost } = groupRecoveries({
            vaults: [older, ORPHAN],
            seals: [],
            knownWalletIds: [],
        });
        expect(lost.map((row) => row.vault.vaultId)).toEqual(["v-orphan", "v-old"]);
    });

    it("carries each vault's chains, so a row can say what recovering it covers", () => {
        const multi = vault({
            vaultId: "v-multi",
            walletId: "gone…forever",
            chains: [
                { chainId: "evm-sepolia" },
                { chainId: "solana-devnet" },
            ] as VaultRecord["chains"],
        });
        const { lost } = groupRecoveries({ vaults: [multi], seals: [], knownWalletIds: [] });
        expect(lost[0]!.chainIds).toEqual(["evm-sepolia", "solana-devnet"]);
    });

    it("is empty only when there is genuinely nothing", () => {
        expect(isEmpty(groupRecoveries({ vaults: [], seals: [], knownWalletIds: [] }))).toBe(true);
        expect(isEmpty(groupRecoveries({ vaults: [ORPHAN], seals: [], knownWalletIds: [] }))).toBe(
            false,
        );
    });
});

describe("whether one seed has a recovery", () => {
    /**
     * Four answers rather than a boolean, because "a gate exists" and "you could open it from here"
     * are different questions. A green tick against a vault whose seal this browser does not hold
     * would be the demo saying you are covered when you are not — the exact class of claim CLAUDE.md
     * forbids, and the reason `unknown` never renders as all clear.
     */
    const gated = (over: Partial<VaultRecord>) =>
        vault({
            vaultId: "v1",
            walletId: "case…alien",
            gate: { summary: "any 2 of 3 email addresses" } as VaultRecord["gate"],
            ...over,
        });

    it("says none when no gate was ever set up", () => {
        const answer = seedRecovery({ vaults: [], seals: [], walletId: "case…alien" });
        expect(answer.state).toBe("none");
        expect(answer.summary).toBeNull();
        expect(answer.vaults).toBe(0);
    });

    it("says ready when the gate is live and its seal is here", () => {
        const answer = seedRecovery({
            vaults: [gated({})],
            seals: [{ vaultId: "v1", storedAt: 0 }],
            walletId: "case…alien",
        });
        expect(answer.state).toBe("ready");
        // The gate's own words, so the row says what would actually be asked.
        expect(answer.summary).toBe("any 2 of 3 email addresses");
    });

    it("distinguishes a gate this browser cannot open from one that is finished", () => {
        // Still protects the account — just not from this device. Reporting it as spent would be
        // telling someone their recovery is over when it is not.
        const answer = seedRecovery({ vaults: [gated({})], seals: [], walletId: "case…alien" });
        expect(answer.state).toBe("no-seal");
    });

    it("says spent once every gate has been opened", () => {
        const answer = seedRecovery({
            vaults: [gated({ spent: { at: 1, reason: "opened" } })],
            seals: [{ vaultId: "v1", storedAt: 0 }],
            walletId: "case…alien",
        });
        expect(answer.state).toBe("spent");
    });

    it("prefers a usable gate over a spent one the same seed also has", () => {
        // Re-sealing after a recovery leaves both. The seed is covered, and saying "spent" because
        // one old vault is would send a user to buy a ceremony they already have.
        const answer = seedRecovery({
            vaults: [
                gated({ vaultId: "old", spent: { at: 1, reason: "opened" }, createdAt: 1 }),
                gated({ vaultId: "new", createdAt: 2 }),
            ],
            seals: [{ vaultId: "new", storedAt: 0 }],
            walletId: "case…alien",
        });
        expect(answer.state).toBe("ready");
        expect(answer.vaults).toBe(2);
    });

    it("ignores other seeds' vaults entirely", () => {
        const answer = seedRecovery({
            vaults: [gated({ walletId: "someone…else" })],
            seals: [{ vaultId: "v1", storedAt: 0 }],
            walletId: "case…alien",
        });
        expect(answer.state).toBe("none");
    });
});
