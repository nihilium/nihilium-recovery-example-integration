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
