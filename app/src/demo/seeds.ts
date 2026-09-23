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
     * Always `generated`. Kept as a field rather than dropped because the distinction mattered once
     * and may again — a wallet that imported a phrase would want to say so.
     */
    origin: "generated";
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
function mint(index: number): SeedEntry {
    return {
        mnemonic: newMnemonic(),
        label: index === 0 ? "Seed 1" : `Seed ${index + 1}`,
        addedAt: Date.now(),
        origin: "generated",
    };
}

/** The book a first run gets: exactly one seed, generated here, persisted immediately. */
function fresh(): SeedBook {
    const seed = mint(0);
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
        const seeds = (parsed.seeds ?? []).filter(
            (entry): entry is SeedEntry =>
                typeof entry?.mnemonic === "string" && isValidMnemonic(entry.mnemonic),
        );
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
    const entry = mint(book.seeds.length);
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
