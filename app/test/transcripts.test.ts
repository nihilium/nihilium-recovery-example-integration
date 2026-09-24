/**
 * A transcript belongs to an operation, not to the app.
 *
 * `FlowState` held one `log` array that sealing, adding a chain and recovering all appended to, and
 * only sealing ever cleared it. So a seal's lines were still on screen when the recover dialog
 * opened, and `addChain`'s lines — which had no renderer of their own — appeared inside whichever
 * dialog opened next. That is not untidiness: a transcript is a report of what an operation did, so
 * a line from a different one is the screen attributing work to something that did not do it.
 *
 * These read the sources rather than rendering, because the failure is structural — a component
 * reaching for the wrong channel — and the suite has no DOM.
 */
import { describe, expect, it } from "vitest";
import { readSources } from "./helpers/sources.js";

const sources = readSources("src");
const byPath = new Map(sources.map((file) => [file.path, file]));

function text(path: string): string {
    const file = byPath.get(path);
    expect(file, `${path} is gone — update this test with it`).toBeDefined();
    return file!.text;
}

describe("transcripts are per operation", () => {
    it("leaves the flow no single shared array to append to", () => {
        // Scoped to the *flow*. `useSettlement` and `useRecoveryChain` each own a `log`, and that is
        // correct — they are separate operations with separate lifetimes. The bug was one array
        // inside `FlowState` that three operations shared.
        const flow = text("src/demo/useRecoveryFlow.ts");
        expect(flow).toContain("logs: Record<LogChannel, string[]>");
        expect(flow, "FlowState must not carry a bare `log`").not.toMatch(/^\s+log: string\[\];$/m);

        // And nothing may render it, which is how it was seen in the first place.
        const renderers = sources
            .filter((file) => file.text.includes("flow.state.log."))
            .map((file) => file.path);
        expect(renderers).toEqual([]);
    });

    it("gives every channel exactly one renderer, and the right one", () => {
        expect(text("src/ui/SealDialog.tsx")).toContain("flow.state.logs.seal");
        expect(text("src/ui/RecoverDialog.tsx")).toContain("state.logs.recover");
        // No `addChain` channel any more. Adding a chain is not an operation a user starts — it is
        // the first half of protecting one — so its lines belong to the settlement transcript,
        // beside the transaction they precede, rather than to a channel of their own.
        expect(text("src/ui/WalletCard.tsx")).toContain("settlement.state.log");
    });

    it("never renders another operation's channel", () => {
        // The exact bug: the recover dialog showing what the seal did.
        expect(text("src/ui/RecoverDialog.tsx")).not.toContain("logs.seal");

        expect(text("src/ui/SealDialog.tsx")).not.toContain("logs.recover");

        expect(text("src/ui/RecoveryCard.tsx")).not.toContain("logs.seal");
        expect(text("src/ui/RecoveryCard.tsx")).not.toContain("logs.recover");
    });

    it("clears its own channel when an operation starts, and only its own", () => {
        const flow = text("src/demo/useRecoveryFlow.ts");
        // Each operation resets the channel it is about to write. `addChain` never cleared
        // anything, which is how its lines survived into the next dialog — and it has no channel at
        // all now, because adding a chain is the first half of protecting one rather than an
        // operation a user starts.
        for (const channel of ["seal: []", "recover: []"]) {
            expect(flow, `no reset for ${channel}`).toContain(channel);
        }
    });

    it("keeps each operation's hook on its own transcript", () => {
        // These were always separate; the test pins it so a later "let's unify the log" does not
        // quietly recreate the problem one layer up. `useRecoveryChain` used to be on this list and
        // is gone: it drove initiate and execute for the chain on screen, which `submitAll` already
        // does for every chain — so its only remaining effect was a second attempt the module
        // refuses with `AttemptInFlight`.
        expect(text("src/demo/useSettlement.ts")).toContain("log: string[]");
        expect(text("src/demo/useProtectAll.ts")).toContain("log: readonly string[]");
        expect(text("src/ui/WalletCard.tsx")).toContain("settlement.state.log");
        expect(text("src/ui/ProtectAllDialog.tsx")).toContain("lines={log}");
    });
});
