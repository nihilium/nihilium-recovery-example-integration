/**
 * The screen's text budget, enforced.
 *
 * The app went through a redesign whose whole point was that a card at rest shows a heading, at most
 * one sentence, its status and its actions — everything else behind the Explain toggle. That rule
 * decays the moment someone adds "just one more clarifying paragraph", so it is a test.
 *
 * The split is *reports* versus *teaches*. Something that reports — a verdict, a price, an SDK
 * refusal, the `Demo` tag — is a fact about this run and must be visible however the toggle is set.
 * Something that teaches is true regardless of what the user just did, and belongs inside `<Explain>`.
 * Both directions are asserted, because the failure mode of the first rule is a wall of text and the
 * failure mode of the second is a warning nobody sees.
 */
import { describe, expect, it } from "vitest";
import { readSources } from "./helpers/sources.js";

/**
 * Comments stripped first, and not as tidying: several of these files *discuss* `<Explain>` in their
 * header, and an unpaired tag in a comment opens a range that swallows the rest of the file — which
 * is how the first draft of this test concluded that a button's tooltip was hidden behind the toggle.
 * Dropping comments also makes the assertions mean what they say, since only rendered strings remain.
 */
function stripComments(text: string): string {
    return text
        .replaceAll(/\/\*[\s\S]*?\*\//g, (block) => " ".repeat(block.length))
        // Anchored on whitespace so `https://…` inside a string survives.
        .replaceAll(/(^|\s)\/\/[^\n]*/g, (line) => " ".repeat(line.length));
}

const ui = readSources("src").map((file) => ({ ...file, text: stripComments(file.text) }));
const byPath = new Map(ui.map((file) => [file.path, file]));

/** Where each `<Explain>…</Explain>` body sits. They do not nest, so a lazy match is exact. */
function explainRanges(text: string): { start: number; end: number }[] {
    return [...text.matchAll(/<Explain>[\s\S]*?<\/Explain>/g)].map((match) => ({
        start: match.index,
        end: match.index + match[0].length,
    }));
}

function occurrences(text: string, needle: string): number[] {
    const out: number[] = [];
    for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) out.push(at);
    return out;
}

/** Copy that is true whatever the user just did. It explains, so it goes behind the toggle. */
const TEACHES: readonly { file: string; phrase: string }[] = [
    { file: "src/App.tsx", phrase: "One 12-word seed phrase" },
    { file: "src/ui/DemoBanner.tsx", phrase: "does not defend a" },
    { file: "src/ui/WalletCard.tsx", phrase: "No settlement binding yet" },
    { file: "src/ui/WalletCard.tsx", phrase: "are KDF inputs" },
    { file: "src/ui/SealRow.tsx", phrase: "two-domain rule" },
    { file: "src/ui/SealRow.tsx", phrase: "disabled for two reasons" },
    { file: "src/ui/RecoveryCard.tsx", phrase: "A new gate on this account does not undo" },
    { file: "src/ui/RecoveryCard.tsx", phrase: "The two badges answer two questions" },
    { file: "src/ui/RecoverDialog.tsx", phrase: "not a vote, an absence" },
    { file: "src/ui/RecoverDialog.tsx", phrase: "that key signs the" },
    { file: "src/ui/SealDialog.tsx", phrase: "live zkEmail DKIM registry" },
];

/**
 * Copy that reports something about *this* run. Hiding any of it behind a toggle would be the
 * demo lying by omission — which is the failure this repo cares about most.
 */
const REPORTS: readonly { file: string; phrase: string }[] = [
    // The SDK's own §12 sentence, on the disabled button, whatever the toggle says.
    { file: "src/ui/SealRow.tsx", phrase: "blocked[0]?.reason" },
    // The price, rendered before the button that spends it.
    { file: "src/ui/SealDialog.tsx", phrase: "method.cost.describe(preset)" },
    // What a recovery cost, verbatim.
    { file: "src/ui/RecoverDialog.tsx", phrase: "state.result.spentReason" },
    { file: "src/ui/RecoveryCard.tsx", phrase: "vault.spent.reason" },
    // Why a method is refused, on the method. A greyed option with no reason is a dead end.
    { file: "src/ui/SealDialog.tsx", phrase: "offer.unavailable" },
    // What stage this recovery is at, off-chain and on. Hiding it would leave the card unable to
    // say that a vault was opened and the account never moved.
    { file: "src/ui/RecoveryCard.tsx", phrase: "<StageBadge stage={stage} />" },
    // The watchtower's answer, whose resting state is "nothing is watching". Never styled as
    // reassurance, and never optional — see `recoveryHealth.ts`.
    { file: "src/ui/RecoveryCard.tsx", phrase: "<WatchBadge watching={watching} />" },
    // The one line that stops "the vault opened" reading as "the account is back".
    { file: "src/ui/RecoverDialog.tsx", phrase: "changed hands" },
    { file: "src/ui/DemoBanner.tsx", phrase: "The live ceremony is not configured" },
    // Per-guardian domain verdicts: a blocking answer that only shows in Explain mode is a seal
    // button that refuses to work for no visible reason.
    { file: "src/ui/SealDialog.tsx", phrase: "verdict.message" },
];

describe("what the screen says at rest", () => {
    it.each(TEACHES)("$file keeps “$phrase” behind the Explain toggle", ({ file, phrase }) => {
        const source = byPath.get(file);
        expect(source, `${file} is gone — update this test with it`).toBeDefined();
        const ranges = explainRanges(source!.text);
        const found = occurrences(source!.text, phrase);
        expect(found, `“${phrase}” is no longer in ${file}`).not.toEqual([]);
        const loose = found.filter((at) => !ranges.some((r) => at > r.start && at < r.end));
        expect(loose, "teaching copy renders only when the reader asks for it").toEqual([]);
    });

    it.each(REPORTS)("$file shows “$phrase” whatever the toggle says", ({ file, phrase }) => {
        const source = byPath.get(file);
        expect(source, `${file} is gone — update this test with it`).toBeDefined();
        const ranges = explainRanges(source!.text);
        const found = occurrences(source!.text, phrase);
        expect(found, `“${phrase}” is no longer in ${file}`).not.toEqual([]);
        const hidden = found.filter((at) => ranges.some((r) => at > r.start && at < r.end));
        expect(hidden, "a fact about this run is not an optional explanation").toEqual([]);
    });

    it("never claims the key is not assembled", () => {
        // `recover()` returns a scoped, zeroizing capability. It is a real key, in memory, and the
        // one piece of copy that would be worth more than this demo is the one that denies it.
        const violations = ui
            .filter((file) => /never[\s-]assembled|not assembled|without assembling/i.test(file.text))
            .map((file) => file.path);
        expect(violations).toEqual([]);
    });
});
