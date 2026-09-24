/**
 * The seed book, and why there is no built-in phrase any more.
 *
 * This demo shipped with the published Hardhat mnemonic, chosen so nobody could mistake it for a
 * wallet worth funding. That backfired in a way worth keeping: the Solana account it derives had
 * been turned into a durable nonce account by somebody else — 51 devnet SOL, an authority we do not
 * hold, and 80 bytes of data that make the System Program refuse to transfer from it. A published
 * key is a key other people use, and a shared address accumulates other people's state.
 *
 * So the wallet mints its own on first run and keeps it. The invariant these tests hold down is
 * that there is **always exactly one derivable seed at minimum**, whatever storage does.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
    activeEntry,
    addGeneratedSeed,
    addImportedSeed,
    loadSeedBook,
    removeSeed,
    seedFingerprint,
    selectSeed,
} from "../src/demo/seeds.js";
import { isValidMnemonic, seedFromMnemonic } from "../src/integration/keys/mnemonic.js";

/** `localStorage` does not exist under the node environment; the book must survive that too. */
function withStorage(): Map<string, string> {
    const store = new Map<string, string>();
    (globalThis as { window?: unknown }).window = {
        localStorage: {
            getItem: (k: string) => store.get(k) ?? null,
            setItem: (k: string, v: string) => void store.set(k, v),
        },
    };
    return store;
}

beforeEach(() => {
    withStorage();
});

describe("first run", () => {
    it("mints exactly one seed, generated here", () => {
        const book = loadSeedBook();
        expect(book.seeds).toHaveLength(1);
        expect(activeEntry(book).origin).toBe("generated");
        expect(book.active).toBe(book.seeds[0]!.mnemonic);
    });

    it("mints a valid 12-word phrase every chain can derive from", () => {
        const seed = activeEntry(loadSeedBook()).mnemonic;
        expect(seed.split(" ")).toHaveLength(12);
        expect(isValidMnemonic(seed)).toBe(true);
        expect(() => seedFromMnemonic(seed)).not.toThrow();
    });

    it("mints a different seed for a different browser", () => {
        const first = activeEntry(loadSeedBook()).mnemonic;
        withStorage();
        expect(activeEntry(loadSeedBook()).mnemonic).not.toBe(first);
    });

    it("keeps the same seed across reloads", () => {
        // "When there's none there, create a new one" — not every time.
        const first = activeEntry(loadSeedBook()).mnemonic;
        expect(activeEntry(loadSeedBook()).mnemonic).toBe(first);
        expect(loadSeedBook().seeds).toHaveLength(1);
    });
});

describe("adding and switching", () => {
    it("keeps the old seed rather than replacing it", () => {
        const one = loadSeedBook();
        const two = addGeneratedSeed(one);
        expect(two.seeds).toHaveLength(2);
        expect(two.seeds.map((s) => s.mnemonic)).toContain(one.active);
        expect(two.active).not.toBe(one.active);
    });

    it("never mints the same seed twice", () => {
        let book = loadSeedBook();
        for (let i = 0; i < 5; i += 1) book = addGeneratedSeed(book);
        expect(new Set(book.seeds.map((s) => s.mnemonic)).size).toBe(book.seeds.length);
    });

    it("switches back to a seed already in the book", () => {
        const one = loadSeedBook();
        const two = addGeneratedSeed(one);
        expect(selectSeed(two, one.active).active).toBe(one.active);
    });

    it("ignores a request to select a seed it does not hold", () => {
        const book = loadSeedBook();
        const other = "legal winner thank year wave sausage worth useful legal winner thank yellow";
        expect(selectSeed(book, other).active).toBe(book.active);
    });

    it("persists across a reload", () => {
        const minted = activeEntry(addGeneratedSeed(loadSeedBook())).mnemonic;
        const reopened = loadSeedBook();
        expect(reopened.active).toBe(minted);
        expect(reopened.seeds).toHaveLength(2);
    });
});

describe("removing", () => {
    it("forgets a seed", () => {
        const two = addGeneratedSeed(loadSeedBook());
        const gone = two.active;
        const after = removeSeed(two, gone);
        expect(after.seeds.map((s) => s.mnemonic)).not.toContain(gone);
        expect(after.seeds).toHaveLength(1);
    });

    it("moves to a remaining seed when the active one is removed", () => {
        const one = loadSeedBook();
        const two = addGeneratedSeed(one);
        const after = removeSeed(two, two.active);
        // Never left pointing at a phrase the book no longer holds.
        expect(after.active).toBe(one.active);
        expect(after.seeds.some((s) => s.mnemonic === after.active)).toBe(true);
    });

    it("leaves the active seed alone when removing another", () => {
        const one = loadSeedBook();
        const two = addGeneratedSeed(one);
        const after = removeSeed(two, one.active);
        expect(after.active).toBe(two.active);
        expect(after.seeds).toHaveLength(1);
    });

    it("mints a replacement rather than leaving nothing", () => {
        // A book with no seed is a wallet that cannot derive. Removing the last one is allowed —
        // there is no protected floor any more — so it has to land somewhere.
        const book = loadSeedBook();
        const after = removeSeed(book, book.active);
        expect(after.seeds).toHaveLength(1);
        expect(after.seeds[0]!.mnemonic).not.toBe(book.active);
        expect(isValidMnemonic(after.active)).toBe(true);
    });

    it("ignores a seed it does not hold", () => {
        const book = loadSeedBook();
        expect(removeSeed(book, "nope").seeds.map((s) => s.mnemonic)).toEqual(
            book.seeds.map((s) => s.mnemonic),
        );
    });

    it("persists the removal", () => {
        const two = addGeneratedSeed(loadSeedBook());
        removeSeed(two, two.active);
        expect(loadSeedBook().seeds).toHaveLength(1);
    });
});

describe("unreadable storage", () => {
    it("mints rather than failing when the stored value is corrupt", () => {
        const store = withStorage();
        store.set("nihilium-demo.seeds", "{ not json");
        const book = loadSeedBook();
        expect(book.seeds).toHaveLength(1);
        expect(isValidMnemonic(book.active)).toBe(true);
    });

    it("drops stored entries that are not valid mnemonics", () => {
        const store = withStorage();
        store.set(
            "nihilium-demo.seeds",
            JSON.stringify({
                seeds: [{ mnemonic: "not a real phrase", label: "junk", addedAt: 1, origin: "generated" }],
                active: "not a real phrase",
            }),
        );
        const book = loadSeedBook();
        // An undrivable phrase is dropped, and the empty book that leaves is refilled.
        expect(book.seeds).toHaveLength(1);
        expect(isValidMnemonic(book.active)).toBe(true);
        expect(book.active).not.toBe("not a real phrase");
    });

    it("mints when localStorage throws outright", () => {
        // A private window, or blocked site data. The seed will not survive a reload, which is a
        // worse demo but not a broken one.
        (globalThis as { window?: unknown }).window = {
            localStorage: {
                getItem: () => {
                    throw new Error("blocked");
                },
                setItem: () => {
                    throw new Error("blocked");
                },
            },
        };
        const book = loadSeedBook();
        expect(book.seeds).toHaveLength(1);
        expect(isValidMnemonic(book.active)).toBe(true);
    });
});

describe("seedFingerprint", () => {
    it("shows the first and last word only", () => {
        const seed = activeEntry(loadSeedBook()).mnemonic;
        const words = seed.split(" ");
        expect(seedFingerprint(seed)).toBe(`${words[0]}…${words[11]}`);
    });
});

describe("a seed pasted in by hand", () => {
    beforeEach(() => withStorage());

    /**
     * Two genuinely valid BIP-39 phrases that share a first and last word — found by generating
     * until a pair collided, because the checksum makes them impossible to write by hand.
     */
    const PHRASE_A = "case feed neck junior pave stage buzz gather ridge buddy kingdom alien";
    const PHRASE_B = "case sheriff during local embark engage spoon endless grace transfer prize alien";

    it("is accepted, switched to, and marked as pasted rather than generated", () => {
        const book = addImportedSeed(loadSeedBook(), PHRASE_A);
        expect(book.active).toBe(PHRASE_A);
        expect(activeEntry(book).origin).toBe("imported");
        // The distinction is not cosmetic: removing a generated seed destroys the only copy, which
        // is the loss this demo stages. A pasted one presumably exists where it was pasted from.
        expect(book.seeds.filter((seed) => seed.origin === "generated")).toHaveLength(1);
    });

    it("normalizes spacing and case rather than refusing them", () => {
        const book = addImportedSeed(loadSeedBook(), `  ${PHRASE_A.toUpperCase()}  `);
        expect(book.active).toBe(PHRASE_A);
    });

    it("refuses a phrase that is not BIP-39", () => {
        // Would derive perfectly good accounts — just not the ones the user meant.
        expect(() => addImportedSeed(loadSeedBook(), "not even close to a mnemonic")).toThrow(
            /valid BIP-39/,
        );
    });

    it("refuses one already in the book", () => {
        const book = addImportedSeed(loadSeedBook(), PHRASE_A);
        expect(() => addImportedSeed(book, PHRASE_A)).toThrow(/already in the list/);
    });

    it("refuses a phrase whose first and last words collide with an existing seed", () => {
        /**
         * The guard worth having. `walletId` is `seedFingerprint(mnemonic)` — the first and last
         * word — and that string is what `VaultRecord.walletId` stores. Two phrases sharing both
         * words would share a wallet identity, so each would list the other's vaults as its own.
         * Nothing downstream could detect it, and no error would ever be raised.
         */
        expect(seedFingerprint(PHRASE_A)).toBe(seedFingerprint(PHRASE_B));

        const book = addImportedSeed(loadSeedBook(), PHRASE_A);
        expect(() => addImportedSeed(book, PHRASE_B)).toThrow(/same words/);
        // And the book is unchanged — a refused import must not half-apply.
        expect(book.seeds.some((seed) => seed.mnemonic === PHRASE_B)).toBe(false);
    });

    it("survives a book written before imports existed", () => {
        // Older rows carry no `origin`. Defaulting to `generated` is the safe direction: it makes
        // the removal warning say this browser holds the only copy.
        const store = withStorage();
        store.set(
            "nihilium-demo.seeds",
            JSON.stringify({ seeds: [{ mnemonic: PHRASE_A, label: "Seed 1", addedAt: 0 }], active: PHRASE_A }),
        );
        expect(activeEntry(loadSeedBook()).origin).toBe("generated");
    });
});

describe("naming seeds", () => {
    beforeEach(() => withStorage());

    const A = "case feed neck junior pave stage buzz gather ridge buddy kingdom alien";

    it("numbers from the highest taken, not from the count", () => {
        /**
         * The bug, in one sequence. Labels used to be `Seed ${seeds.length + 1}`, so removing one
         * dropped the count and the next seed reused a number already in use — and again, and
         * again, until every row in the switcher read "Seed 2" and none of them could be told
         * apart. Removing a seed is the loss this demo *stages*, so this happened constantly.
         */
        let book = loadSeedBook();
        expect(book.seeds.map((s) => s.label)).toEqual(["Seed 1"]);

        book = addGeneratedSeed(book);
        expect(book.seeds.map((s) => s.label)).toEqual(["Seed 1", "Seed 2"]);

        // Remove the first. The count is 1 again; the highest number taken is still 2.
        book = removeSeed(book, book.seeds[0]!.mnemonic);
        book = addGeneratedSeed(book);
        expect(book.seeds.map((s) => s.label)).toEqual(["Seed 2", "Seed 3"]);

        book = removeSeed(book, book.seeds[0]!.mnemonic);
        book = addGeneratedSeed(book);
        expect(book.seeds.map((s) => s.label)).toEqual(["Seed 3", "Seed 4"]);
    });

    it("gives an imported seed a free number too", () => {
        let book = addGeneratedSeed(loadSeedBook());
        book = removeSeed(book, book.seeds[0]!.mnemonic);
        book = addImportedSeed(book, A);
        expect(new Set(book.seeds.map((s) => s.label)).size).toBe(book.seeds.length);
    });

    it("never hands out a label another seed already has", () => {
        let book = loadSeedBook();
        for (let i = 0; i < 6; i++) {
            book = addGeneratedSeed(book);
            // Drop the oldest each round, which is what kept resetting the count.
            book = removeSeed(book, book.seeds[0]!.mnemonic);
        }
        expect(new Set(book.seeds.map((s) => s.label)).size).toBe(book.seeds.length);
    });

    it("repairs a book already carrying duplicates, rather than leaving it stuck", () => {
        // What a wallet that hit the bug has on disk right now. Clearing storage would also clear
        // the vaults, so the fix has to reach existing books.
        const store = withStorage();
        const three = [
            { mnemonic: A, label: "Seed 2", addedAt: 1, origin: "generated" },
            {
                mnemonic:
                    "legal winner thank year wave sausage worth useful legal winner thank yellow",
                label: "Seed 2",
                addedAt: 2,
                origin: "generated",
            },
            {
                mnemonic:
                    "case sheriff during local embark engage spoon endless grace transfer prize alien",
                label: "Seed 2",
                addedAt: 3,
                origin: "generated",
            },
        ];
        store.set("nihilium-demo.seeds", JSON.stringify({ seeds: three, active: A }));

        const labels = loadSeedBook().seeds.map((seed) => seed.label);
        expect(new Set(labels).size).toBe(3);
        // The first holder keeps its name, so nothing renames under someone who never hit this.
        expect(labels[0]).toBe("Seed 2");
    });

    it("leaves a healthy book's names alone", () => {
        const store = withStorage();
        store.set(
            "nihilium-demo.seeds",
            JSON.stringify({
                seeds: [
                    { mnemonic: A, label: "Seed 1", addedAt: 1, origin: "generated" },
                    {
                        mnemonic:
                            "legal winner thank year wave sausage worth useful legal winner thank yellow",
                        label: "Seed 2",
                        addedAt: 2,
                        origin: "generated",
                    },
                ],
                active: A,
            }),
        );
        expect(loadSeedBook().seeds.map((s) => s.label)).toEqual(["Seed 1", "Seed 2"]);
    });
});
