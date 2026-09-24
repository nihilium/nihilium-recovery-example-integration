/**
 * Every seed this demo has used, and the one it is using now.
 *
 * A wallet has one seed for life and hides it. This demo needs several, visible, switchable — for
 * two reasons:
 *
 * There is no built-in phrase. The published one this demo shipped with had already been repurposed
 * by somebody else on devnet — 51 SOL in a durable nonce account we hold no authority over — which
 * is what a published key invites. The wallet mints its own on first run and keeps it.
 *
 * - **Recovery's aftermath needs somewhere to go.** A recovery decrypts every record, so the root
 *   secret is exposed to whoever ran it. The answer is not a new epoch on the same account, it is a
 *   different account — and in a single-seed wallet that means a different seed. Without one, the
 *   spent state can only be described, never demonstrated.
 * - **A second seed is the honest way to show a fresh device.** Not a reset button: the old seed
 *   stays, its vaults stay, and you can switch back and see them.
 *
 * Demo-only, and unusually so. Seeds are held in plaintext in `localStorage`, which is exactly what
 * a wallet must never do — the whole file is the thing `integration/` exists to be separate from.
 *
 * **To replace:** all of it. A wallet reads one seed from a device keystore and has no concept of a
 * seed list. **Assumes:** `localStorage` may throw or come back empty — a private window, blocked
 * site data — so every access is guarded and the built-in demo seed is always present as a floor.
 */
import { isValidMnemonic, newMnemonic } from "../integration/keys/mnemonic.js";

const KEY = "nihilium-demo.seeds";

export interface SeedEntry {
    mnemonic: string;
    label: string;
    /** Unix ms. The built-in seed reports 0 so it always sorts first. */
    addedAt: number;
    /**
     * Where the phrase came from. Shown, because it changes what removing it means: a generated
     * seed exists only in this browser, so removing it destroys the only copy — which is the loss
     * this demo stages. An imported one presumably exists wherever it was imported from.
     */
    origin: "generated" | "imported";
}

export interface SeedBook {
    seeds: readonly SeedEntry[];
    active: string;
}

/**
 * A seed, minted now.
 *
 * There is no built-in phrase to fall back to any more. The published one this demo used to ship
 * with had been repurposed by somebody else on devnet — which is what a published key invites — so
 * the wallet makes its own and keeps it. First run mints one; every run after that reads it back.
 */
/**
 * The next free `Seed N`, from the numbers already taken rather than from the count.
 *
 * Numbering by `seeds.length + 1` is wrong the moment anything is removed: delete "Seed 1" and the
 * count is 1 again, so the next seed is also called "Seed 2" — and the one after that, and the one
 * after that. Removing a seed is the loss this demo *stages*, so it happens constantly, and the
 * result was a wallet where every seed had the same name and the switcher was unusable.
 *
 * Reads the numbers out of the labels, so a book that already contains duplicates still gets a free
 * one rather than piling onto the collision.
 */
function highestNumber(seeds: readonly SeedEntry[]): number {
    let highest = 0;
    for (const seed of seeds) {
        const match = /^Seed (\d+)$/.exec(seed.label);
        if (match !== null) highest = Math.max(highest, Number(match[1]));
    }
    return highest;
}

function nextLabel(seeds: readonly SeedEntry[]): string {
    return `Seed ${highestNumber(seeds) + 1}`;
}

function mint(seeds: readonly SeedEntry[]): SeedEntry {
    return {
        mnemonic: newMnemonic(),
        label: nextLabel(seeds),
        addedAt: Date.now(),
        origin: "generated",
    };
}

/** The book a first run gets: exactly one seed, generated here, persisted immediately. */
function fresh(): SeedBook {
    const seed = mint([]);
    return write({ seeds: [seed], active: seed.mnemonic });
}

function read(): SeedBook {
    let raw: string | null = null;
    try {
        raw = window.localStorage.getItem(KEY);
    } catch {
        // Private window, blocked site data. A seed still gets minted; it just will not survive a
        // reload, which is a worse demo but not a broken one.
        return fresh();
    }
    if (raw === null) return fresh();

    try {
        const parsed = JSON.parse(raw) as Partial<SeedBook>;
        // Anything that is not a valid BIP-39 phrase is dropped rather than kept as an undrivable
        // account — a truncated or tampered list must not produce a wallet that cannot derive.
        const seeds = (parsed.seeds ?? [])
            .filter(
                (entry): entry is SeedEntry =>
                    typeof entry?.mnemonic === "string" && isValidMnemonic(entry.mnemonic),
            )
            // Books written before imports existed carry no `origin`. Defaulting to `generated` is
            // the safe direction: it makes the removal warning say the copy is the only one.
            .map((entry) => ({ ...entry, origin: entry.origin === "imported" ? "imported" as const : "generated" as const }));

        // Repair duplicates already on disk. Numbering used to come from the seed count, so any
        // wallet that removed a seed and added another has several called the same thing — and a
        // switcher whose rows all read "Seed 2" cannot be used. The first holder of a name keeps
        // it; later ones move to the next free number, so nothing renames under a user who never
        // hit the bug.
        const taken = new Set<string>();
        let highest = highestNumber(seeds);
        for (const entry of seeds) {
            if (!taken.has(entry.label)) {
                taken.add(entry.label);
                continue;
            }
            highest += 1;
            entry.label = `Seed ${highest}`;
            taken.add(entry.label);
        }
        if (seeds.length === 0) return fresh();

        const active =
            parsed.active !== undefined && seeds.some((s) => s.mnemonic === parsed.active)
                ? parsed.active
                : seeds[0]!.mnemonic;
        return { seeds, active };
    } catch {
        return fresh();
    }
}

function write(book: SeedBook): SeedBook {
    try {
        window.localStorage.setItem(KEY, JSON.stringify(book));
    } catch {
        /* the book still works for this session */
    }
    return book;
}

export function loadSeedBook(): SeedBook {
    return read();
}

/**
 * Mint a seed and switch to it.
 *
 * Switching is the point — a new seed nobody moves to is a new seed nobody can demonstrate. The old
 * one stays in the list with its vaults intact, because being able to go back is what makes this a
 * history rather than a reset.
 */
export function addGeneratedSeed(book: SeedBook): SeedBook {
    const entry = mint(book.seeds);
    return write({ seeds: [...book.seeds, entry], active: entry.mnemonic });
}

/**
 * Forget a seed.
 *
 * **This is the loss, staged.** A generated seed exists in one place — this browser — so removing it
 * destroys the only copy, and the wallet's own signing key with it. That is exactly the event
 * recovery exists for, which is why this is a demo affordance rather than housekeeping.
 *
 * What it does **not** destroy is the vault. A recovery needs the seal and the guardians, never the
 * wallet seed, and the chain context it needs is in the ledger row — so an account whose seed is
 * gone is still recoverable if a gate was set up for it. An account with no gate is simply gone.
 *
 * Removing the last one mints a replacement rather than leaving nothing: a book with no seed is a
 * wallet that cannot derive, and an empty screen teaches less than a fresh one.
 */
export function removeSeed(book: SeedBook, mnemonic: string): SeedBook {
    const seeds = book.seeds.filter((seed) => seed.mnemonic !== mnemonic);
    if (seeds.length === book.seeds.length) return book;
    if (seeds.length === 0) return fresh();
    // Removing the one in use falls back to the first remaining rather than leaving `active`
    // pointing at a phrase the book no longer holds.
    const active = book.active === mnemonic ? seeds[0]!.mnemonic : book.active;
    return write({ seeds, active });
}

export class SeedImportError extends Error {
    override readonly name = "SeedImportError";
}

/**
 * Take a phrase the user typed.
 *
 * Three refusals, and the third is the one worth reading:
 *
 * - not a valid BIP-39 phrase — an undrivable account is worse than no account;
 * - already in the book — two rows for one wallet, where switching between them does nothing;
 * - **a fingerprint collision.** `walletId` is `seedFingerprint(mnemonic)` (see `App.tsx`), which is
 *   the first and last word — and that is what `VaultRecord.walletId` stores. Two phrases sharing
 *   both words would therefore share a wallet identity, and each would show the other's vaults as
 *   its own. That is silent and unrecoverable-looking, so it is refused here.
 *
 * The real fix is a `walletId` derived by hash rather than by first-and-last word. It is not done
 * because changing it invalidates every `walletId` already in IndexedDB, which costs a `DB_VERSION`
 * bump and every existing vault with it — a price worth paying deliberately, not as a side effect
 * of adding an import box.
 */
export function addImportedSeed(book: SeedBook, phrase: string): SeedBook {
    const mnemonic = phrase.trim().replace(/\s+/g, " ").toLowerCase();
    if (!isValidMnemonic(mnemonic)) {
                // A phrase that fails here would still derive accounts — just not the ones meant.
        throw new SeedImportError("Not a valid BIP-39 phrase. Check the word count and spelling.");
    }
    if (book.seeds.some((seed) => seed.mnemonic === mnemonic)) {
        throw new SeedImportError("This phrase is already in the list.");
    }
    const fingerprint = seedFingerprint(mnemonic);
    const clash = book.seeds.find((seed) => seedFingerprint(seed.mnemonic) === fingerprint);
    if (clash !== undefined) {
                // This demo identifies a wallet by its first and last word, so the two would share every vault.
        throw new SeedImportError(
            `Starts and ends with the same words as "${clash.label}" (${fingerprint}). ` +
                "Use a different phrase.",
        );
    }

    const entry: SeedEntry = {
        mnemonic,
        label: nextLabel(book.seeds),
        addedAt: Date.now(),
        origin: "imported",
    };
    return write({ seeds: [...book.seeds, entry], active: entry.mnemonic });
}

export function selectSeed(book: SeedBook, mnemonic: string): SeedBook {
    if (!book.seeds.some((seed) => seed.mnemonic === mnemonic)) return book;
    return write({ ...book, active: mnemonic });
}

export function activeEntry(book: SeedBook): SeedEntry {
    // `read` guarantees a non-empty book with a resolvable `active`, so the fallback is only ever
    // reached by a caller that built a book by hand.
    return book.seeds.find((seed) => seed.mnemonic === book.active) ?? book.seeds[0]!;
}

/** First and last word only. A seed is shown in full exactly once, where the user asked for it. */
export function seedFingerprint(mnemonic: string): string {
    const words = mnemonic.split(" ");
    return words.length < 2 ? mnemonic : `${words[0]}…${words[words.length - 1]}`;
}
