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
import { AddressChip } from "./AddressChip.js";
import { Button } from "./ds.js";
import { Explain } from "./Explain.js";

export function SeedBar({
    book,
    onGenerate,
    onSelect,
    onRemove,
}: {
    book: SeedBook;
    onGenerate: () => void;
    onSelect: (mnemonic: string) => void;
    /** Opens the warning dialog. Removing a generated seed is the loss this demo stages. */
    onRemove: (seed: SeedEntry) => void;
}) {
    const [showAll, setShowAll] = useState(false);
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
                        a row this dense is how a word gets dropped. */}
                    <AddressChip value={current.mnemonic} display={current.mnemonic} />
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
                            onSelect={() => onSelect(seed.mnemonic)}
                            onRemove={() => onRemove(seed)}
                        />
                    ))}
                </div>
            )}

            <Explain>
                <p>
                    Every seed is kept, not replaced. Switching changes which accounts the wallet
                    derives, and a vault is bound to the account it was sealed against — so the gates
                    you made under one seed stay with it and reappear when you switch back.
                </p>
                <p>
                    A generated seed comes from this browser&apos;s CSPRNG and is held in
                    <code> localStorage</code> in the clear, which is exactly what a wallet must
                    never do. Every seed can be removed; removing the last one mints a replacement,
                    so there is always something to derive from.
                </p>
            </Explain>
        </div>
    );
}

function SeedRow({
    seed,
    active,
    onSelect,
    onRemove,
}: {
    seed: SeedEntry;
    active: boolean;
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
                    {seedFingerprint(seed.mnemonic)} · generated here
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
