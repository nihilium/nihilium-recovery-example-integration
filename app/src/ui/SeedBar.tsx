/**
 * Which seed this wallet is, and the way to a different one.
 *
 * A wallet has one seed and hides it. This demo shows the current one in full — losing it on demand
 * is the thing being demonstrated — and keeps every seed it has minted, so you can switch back and
 * find that seed's vaults still there.
 *
 * The reason it exists is the aftermath of a recovery. Opening a vault exposes every chain's root
 * secret to whoever ran it, so the answer is not a new epoch on the same account: it is a different
 * account, which in a single-seed wallet means a different seed. Without one, the spent state could
 * only ever be described.
 */
import { useState } from "react";
import {
    activeEntry,
    seedFingerprint,
    type SeedBook,
    type SeedEntry,
} from "../demo/seeds.js";
import {
    SEED_RECOVERY_LABEL,
    type SeedRecovery,
} from "../integration/recovery/recoveryCatalogue.js";
import { SecretPhrase } from "./SecretPhrase.js";
import { Button, StatusMessage, TextInput } from "./ds.js";
import { Notice } from "./Notice.js";

export function SeedBar({
    book,
    recoveryFor,
    onGenerate,
    onImport,
    onSelect,
    onRemove,
}: {
    book: SeedBook;
    /**
     * Whether this seed has a recovery, per seed.
     *
     * On the bar rather than only on the wallet card because the question "is this seed covered"
     * belongs to the seed, and the card can only ever answer it for whichever one is active — so
     * the seeds you are *not* looking at, which are exactly the ones you would switch to in an
     * emergency, said nothing at all.
     */
    recoveryFor: (mnemonic: string) => SeedRecovery;
    onGenerate: () => void;
    /** Throws `SeedImportError` with a reason the user can act on. */
    onImport: (phrase: string) => void;
    onSelect: (mnemonic: string) => void;
    /** Opens the warning dialog. Removing a generated seed is the loss this demo stages. */
    onRemove: (seed: SeedEntry) => void;
}) {
    const [showAll, setShowAll] = useState(false);
    // Its own toggle, not part of the seed list. Folded into `showAll` it could only be closed by
    // collapsing the whole list — and with one seed the list has no toggle at all, so the one
    // control for getting a *second* seed in was unreachable.
    const [importing, setImporting] = useState(false);
    const current = activeEntry(book);

    return (
        <div className="stack">
            <div className="card-foot">
                <span className="seed-bar__current">
                    {/* Named loudly rather than quietly: which seed is active decides which
                        accounts exist and which vaults are reachable, so it is the one thing on
                        this row that must not be skimmed past. */}
                    <strong className="seed-bar__name">{current.label}</strong>
                    {/* Copyable, because the phrase is the thing a reader takes elsewhere — into a
                        faucet, another wallet, or a note — and selecting twelve words by hand from
                        a row this dense is how a word gets dropped. Blurred until shown. */}
                    <SecretPhrase phrase={current.mnemonic} />
                    <RecoveryDot recovery={recoveryFor(current.mnemonic)} />
                </span>
                <span className="row">
                    {book.seeds.length > 1 && (
                        <button
                            type="button"
                            className="linkish"
                            onClick={() => setShowAll((prev) => !prev)}
                        >
                            {showAll ? "Hide" : `${book.seeds.length} seeds`}
                        </button>
                    )}
                    <button
                        type="button"
                        className="linkish"
                        onClick={() => setImporting((prev) => !prev)}
                    >
                        {importing ? "Cancel" : "Paste a seed"}
                    </button>
                    <Button variant="ghost" onClick={onGenerate}>
                        New seed
                    </Button>
                </span>
            </div>

            {showAll && (
                <div className="gate-picker">
                    {book.seeds.map((seed) => (
                        <SeedRow
                            key={seed.mnemonic}
                            seed={seed}
                            active={seed.mnemonic === book.active}
                            recovery={recoveryFor(seed.mnemonic)}
                            onSelect={() => onSelect(seed.mnemonic)}
                            onRemove={() => onRemove(seed)}
                        />
                    ))}
                </div>
            )}

            {importing && (
                <SeedImport
                    onImport={(phrase) => {
                        onImport(phrase);
                        setImporting(false);
                    }}
                />
            )}

        </div>
    );
}

/**
 * Paste a phrase.
 *
 * The warning reports what this app does with what you are about to type, right now, on this
 * screen — so it sits beside the field rather than anywhere a reader has to go looking.
 */
function SeedImport({ onImport }: { onImport: (phrase: string) => void }) {
    const [phrase, setPhrase] = useState("");
    const [error, setError] = useState<string | null>(null);

    function submit(): void {
        try {
            onImport(phrase);
            setError(null);
        } catch (failure) {
            // The field keeps what was typed: a rejected phrase is usually one wrong word, and
            // clearing it would make the user paste the whole thing again to fix it.
            setError(failure instanceof Error ? failure.message : String(failure));
        }
    }

    return (
        <div className="stack seed-import">
            <Notice tone="caution">
                Seeds are stored unencrypted in this browser. Don&apos;t paste one that holds real
                funds.
            </Notice>
            <TextInput
                ariaLabel="Add a seed phrase"
                placeholder="twelve words, separated by spaces"
                value={phrase}
                onChange={(event) => setPhrase(event.target.value)}
            />
            {error !== null && <StatusMessage tone="error">{error}</StatusMessage>}
            <div className="row">
                <Button variant="ghost" onClick={submit} disabled={phrase.trim() === ""}>
                    Add this seed
                </Button>
            </div>
        </div>
    );
}

/**
 * One dot and one phrase: whether a seed is covered. On the seed rather than on the wallet card,
 * because the card can only answer for whichever seed is active — and the ones you are not looking
 * at are exactly the ones you would switch to in an emergency.
 */
function RecoveryDot({ recovery }: { recovery: SeedRecovery }) {
    // Reuses the protection palette so one colour means one thing across the page.
    const tone =
        recovery.state === "ready"
            ? "protected"
            : recovery.state === "spent"
              ? "spent"
              : recovery.state === "no-seal"
                ? "stale"
                : "unprotected";
    return (
        <span className="seed-recovery" title={recovery.summary ?? undefined}>
            <span className={`protection__dot protection__dot--${tone}`} aria-hidden="true" />
            {SEED_RECOVERY_LABEL[recovery.state]}
        </span>
    );
}

function SeedRow({
    seed,
    active,
    recovery,
    onSelect,
    onRemove,
}: {
    seed: SeedEntry;
    active: boolean;
    recovery: SeedRecovery;
    onSelect: () => void;
    onRemove: () => void;
}) {
    return (
        <div className="seed-row">
            <button
                type="button"
                className={active ? "gate-option gate-option--active" : "gate-option"}
                aria-pressed={active}
                disabled={active}
                onClick={onSelect}
            >
                <span className="gate-option__title">{seed.label}</span>
                <span className="gate-option__cost mono">
                    {/* Which it is decides what Remove destroys: a generated phrase exists only in
                        this browser, so removing it is the loss this demo stages. */}
                    {seedFingerprint(seed.mnemonic)} ·{" "}
                    {seed.origin === "imported" ? "pasted in" : "generated here"}
                </span>
                <span className="gate-option__gate">
                    <RecoveryDot recovery={recovery} />
                    {recovery.summary !== null && <span className="muted"> · {recovery.summary}</span>}
                </span>
            </button>
            {/* Every seed is removable. Removing the last one mints a replacement rather than
                leaving a wallet with nothing to derive from. */}
            <button type="button" className="linkish seed-row__note" onClick={onRemove}>
                Remove
            </button>
        </div>
    );
}
