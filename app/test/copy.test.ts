/**
 * The screen's text budget, enforced.
 *
 * This used to police a *split*: facts about the run stayed visible, explanations lived behind an
 * `<Explain>` toggle, and both directions were asserted. The toggle is gone — the app now shows
 * status and actions and nothing else — so what is left to enforce is narrower and, for a demo,
 * sharper: certain sentences must be on the screen, and certain claims must never be.
 *
 * The phrases below are not decoration. Each is a fact about *this run* that a user would act on
 * wrongly if it were missing: a price before a paid button, a refusal with its reason, what a
 * recovery cost, which vault a lost seed belongs to. Losing one is not a styling regression, it is
 * the demo omitting the thing it exists to show.
 */
import { describe, expect, it } from "vitest";
import { readSources } from "./helpers/sources.js";

/**
 * Comments stripped first, so the assertions mean what they say: a header discussing a phrase is not
 * the screen showing it. Only rendered strings remain.
 */
function stripComments(text: string): string {
    return text
        .replaceAll(/\/\*[\s\S]*?\*\//g, (block) => " ".repeat(block.length))
        // Anchored on whitespace so `https://…` inside a string survives.
        .replaceAll(/(^|\s)\/\/[^\n]*/g, (line) => " ".repeat(line.length));
}

const ui = readSources("src").map((file) => ({ ...file, text: stripComments(file.text) }));
const byPath = new Map(ui.map((file) => [file.path, file]));

/** Copy that reports something about *this* run. Removing any of it is the demo lying by omission. */
const REPORTS: readonly { file: string; phrase: string; why: string }[] = [
    {
        file: "src/ui/SealDialog.tsx",
        phrase: "method.cost.describe(preset)",
        why: "the price, rendered before the button that spends it",
    },
    {
        file: "src/ui/SealDialog.tsx",
        phrase: "offer.unavailable",
        why: "why a method is refused. A greyed option with no reason is a dead end",
    },
    {
        file: "src/ui/SealDialog.tsx",
        phrase: "verdict.message",
        why: "per-guardian domain verdicts. A blocking answer with no visible cause is a button that refuses to work",
    },
    {
        file: "src/ui/RecoverDialog.tsx",
        phrase: "Vault spent · {state.result.keys.length} chain key",
        why: "what a recovery cost: the vault is spent and its keys exposed. The SDK sentence is in the transcript",
    },
    {
        file: "src/ui/RecoverDialog.tsx",
        phrase: "control moves when the timelock matures",
        why: "the line that stops “the vault opened” reading as “the account is back”",
    },
    {
        file: "src/ui/RecoveryCard.tsx",
        phrase: "Vault spent · recovered {new Date(vault.spent.at)",
        why: "a spent vault is never silently reused",
    },
    {
        file: "src/ui/RecoveryCard.tsx",
        phrase: "<StageBadge stage={stage} />",
        why: "what stage this recovery is at, off-chain and on",
    },
    {
        file: "src/ui/RecoveryCard.tsx",
        phrase: "<WatchBadge watching={watching} />",
        why: "the watchtower's answer, whose resting state is “nothing is watching”",
    },
    {
        file: "src/ui/DemoBanner.tsx",
        phrase: "The live ceremony is not configured",
        why: "no API key means no method, and the panel says so rather than degrading to a simulation",
    },
    {
        file: "src/ui/TimelockBox.tsx",
        phrase: "headline(longest, anyReady, unreadable.length)",
        why: "how long until the account can be taken back",
    },
    {
        file: "src/ui/TimelockBox.tsx",
        phrase: "a chain could not be read",
        why: "`unknown` never renders as all clear — here it would hand the account over early",
    },
    {
        file: "src/ui/RecoveredKey.tsx",
        phrase: "recovered from",
        why: "one seal, every chain, as a count rather than a claim to believe",
    },
    {
        file: "src/ui/RecoveredKey.tsx",
        phrase: "{entry.failure}",
        why: "a chain that failed. Dropping it reads as a vault that never covered it",
    },
    {
        file: "src/ui/SeedBar.tsx",
        phrase: "Seeds are stored unencrypted in this browser",
        why: "what this app does with a phrase you are about to paste",
    },
    {
        file: "src/ui/SeedBar.tsx",
        phrase: "SEED_RECOVERY_LABEL[recovery.state]",
        why: "whether a seed is covered, on the seed itself",
    },
    {
        file: "src/ui/RecoveryVaultPicker.tsx",
        phrase: "Seed not in this browser",
        why: "the heading that makes a lost seed's vault findable at all",
    },
    {
        file: "src/ui/RecoveryVaultPicker.tsx",
        phrase: "Seal missing. Load the seal file.",
        why: "the difference between a vault you can open and one whose only way in is elsewhere",
    },
    {
        file: "src/ui/HandoverView.tsx",
        phrase: "Add it to move these funds.",
        why: "the sweep cannot be signed without it, and nothing else on the page would say so",
    },
    {
        file: "src/ui/HandoverView.tsx",
        phrase: "liveText(live[index]!)",
        why: "per chain, reconciled with the chain — the row alone said 'timelock running' forever",
    },
    {
        file: "src/ui/HandoverView.tsx",
        phrase: "not read yet",
        why: "a chain with no answer is never shown as ready to move",
    },
    {
        file: "src/ui/RecoveryCard.tsx",
        phrase: "Abort needs this vault's own seed",
        why: "abort is the owner's key, so in the true seed-loss case it is gone — said, not hidden",
    },
    {
        file: "src/ui/HandoverView.tsx",
        phrase: "control handed to",
        why: "fixed at recovery time inside a signed intent, unlike where the funds land",
    },
    {
        file: "src/ui/FeeEstimate.tsx",
        phrase: "fees in ETH and SOL — no USD price",
        why: "a price that could not be read must not render as a free operation",
    },
    {
        file: "src/ui/FeeEstimate.tsx",
        phrase: "in part assumed",
        why: "not every gas figure has a transaction behind it, and the headline says which kind it is",
    },
    {
        file: "src/ui/FeeEstimate.tsx",
        phrase: "no transaction",
        why: "a chain this build does not settle is a row, not an omission from the total",
    },
    {
        file: "src/ui/FeeEstimate.tsx",
        phrase: "rent, refundable",
        why: "Solana's rent-exemption comes back when the account closes, so it is not a fee",
    },
    {
        file: "src/ui/FeeEstimate.tsx",
        phrase: "priced at Ethereum mainnet rates",
        why: "the work is measured on testnets; without this line the figure reads as what was spent",
    },
    {
        file: "src/ui/FeeEstimate.tsx",
        phrase: "Chainlink prices, {formatAge(",
        why: "the SOL/USD feed runs a ~24h heartbeat, so a six-hour-old price is normal and must show",
    },
    {
        file: "src/ui/RecoverDialog.tsx",
        phrase: "vaultChains.map",
        why: "one ceremony covers every chain the vault holds, so control is named once per chain",
    },
    {
        file: "src/ui/WalletCard.tsx",
        phrase: "deposit address",
        why: "on Solana the vault and the account holding its SOL differ; showing only the second made a recoverable vault look like a plain wallet",
    },
    {
        file: "src/ui/ProtectAllDialog.tsx",
        phrase: "{row.reason}",
        why: "a chain left unprotected is what this button could most easily hide, so each says why",
    },
    {
        file: "src/ui/ProtectAllDialog.tsx",
        phrase: "balance could not be read",
        why: "an unreadable balance is not a zero one, and this is the screen that decides on it",
    },
    {
        file: "src/ui/RecoveryCard.tsx",
        phrase: "the old guardians. Protect all",
        why: "until a rotation lands the OLD guardians can recover it, named per chain rather than one",
    },
    {
        file: "src/ui/RecoveryCard.tsx",
        phrase: "Protect all chains with funds",
        why: "the gate is one thing; a per-chain button could only ever offer the chain on screen",
    },
    {
        file: "src/ui/FeeEstimate.tsx",
        phrase: "not charged in this demo",
        why: "the protocol fee is priced, not collected — simulated is labelled where it is shown",
    },
    {
        file: "src/ui/FeeEstimate.tsx",
        phrase: "{step.payer}",
        why: "most of a recovery is paid by the relayer, and a total hiding that makes it look free",
    },
];

describe("what the screen says", () => {
    it.each(REPORTS)("$file still shows “$phrase” — $why", ({ file, phrase }) => {
        const source = byPath.get(file);
        expect(source, `${file} is gone — update this test with it`).toBeDefined();
        expect(
            source!.text.includes(phrase),
            `“${phrase}” is no longer in ${file}`,
        ).toBe(true);
    });

    it("has no Explain toggle left to hide anything behind", () => {
        // The split this file used to police. Status and actions are all that render now, so a
        // reintroduced `<Explain>` would be copy that only some readers ever see — and every
        // assertion above would silently start passing for text nobody is shown.
        const violations = ui.filter((file) => /<Explain>|ExplainProvider|useExplain/.test(file.text));
        expect(violations.map((file) => file.path)).toEqual([]);
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
