/**
 * Account recovery, at rest: a collapsed bar saying what the gate is and whether anything is
 * watching it, and one button that changes it.
 *
 * Closed by default once a gate exists. Setting recovery up is a thing you do twice in a wallet's
 * life, so the expanded form — who the guardians are, the seal file — is detail you open when you
 * want it, not the shape of the page.
 *
 * What is deliberately *not* here is whether the account is protected on-chain. That is a fact about
 * the account, it already has a badge on the wallet card, and repeating it here made the gate look
 * like it was the thing that was half-finished. The gate is finished; the chain is the other half.
 *
 * Recovering is not here either — losing a wallet is a thing that happens to a wallet, so the way in
 * is on the wallet card. The only route back into the setup form is **Replace guardians**, which
 * buys a whole new ceremony, because that is what changing a gate costs.
 */
import { useState } from "react";
import type { DerivedAccount } from "../integration/chains/types.js";
import type { MethodRegistry } from "../integration/conditions/types.js";
import type { RecoveryFlow } from "../demo/useRecoveryFlow.js";
import { Button, Card, Heading, StatusMessage } from "./ds.js";
import { downloadSeal } from "./downloadSeal.js";
import { Explain } from "./Explain.js";
import { HealthBadge } from "./HealthBadge.js";
import { healthOf } from "./recoveryHealth.js";
import { Notice } from "./Notice.js";
import { SealDialog } from "./SealDialog.js";

export function RecoveryCard({
    flow,
    methods,
    methodError,
    account,
}: {
    flow: RecoveryFlow;
    /** Null when the live ceremony is not configured — there is deliberately no free fallback. */
    methods: MethodRegistry | null;
    methodError: string | null;
    account: DerivedAccount | undefined;
}) {
    const [sealing, setSealing] = useState(false);

    const vault = flow.active;
    const method = vault === null ? null : (methods?.get(vault.gate.methodId) ?? null);
    const gate = vault !== null && method !== null ? method.describeGate(vault.gate) : null;
    const health = healthOf(vault, flow.state.phase === "recovering");

    const dialog = methods !== null && sealing && (
        // Mounted only while open: a dialog that unmounts is a dialog whose wizard state cannot
        // survive into the next run, which is one class of bug not to have.
        <SealDialog
            open={sealing}
            onClose={() => setSealing(false)}
            flow={flow}
            methods={methods}
            // Passed even when spent. A new gate does not undo a recovery, but leaving the old row
            // behind would give this account two vaults and let `vaultFor` pick whichever came
            // first — so the replacement still discards it.
            replacing={vault}
        />
    );

    const failure = flow.state.error !== null && !sealing && (
        <StatusMessage tone="error">{flow.state.error}</StatusMessage>
    );

    // Nothing sealed yet: no disclosure, because collapsing the one call to action behind a triangle
    // would hide the only thing there is to do.
    if (vault === null) {
        return (
            <Card padding="md">
                <div className="stack">
                    <Heading level={3}>Account recovery</Heading>
                    {methods === null ? (
                        <StatusMessage tone="error">
                            {methodError ?? "The live ceremony is not configured."}
                        </StatusMessage>
                    ) : (
                        <>
                            <p>Name a few people you trust. Any two of them can get you back in.</p>
                            <div className="row">
                                <Button onClick={() => setSealing(true)} disabled={account === undefined}>
                                    Set up recovery
                                </Button>
                                {account === undefined && (
                                    <span className="muted">Deriving the account…</span>
                                )}
                            </div>
                        </>
                    )}
                    {failure}
                </div>
                {dialog}
            </Card>
        );
    }

    return (
        <Card padding="md">
            <details className="disclosure">
                <summary>
                    <span className="disclosure__marker" aria-hidden="true" />
                    <Heading level={3}>Account recovery</Heading>
                    {/* The gate on the bar, so the closed card still answers "what protects this?" */}
                    <span className="muted">{gate?.headline ?? vault.gate.summary}</span>
                    {health !== null && (
                        <span className="disclosure__spacer">
                            <HealthBadge state={health} />
                        </span>
                    )}
                </summary>

                <div className="stack disclosure__body">
                    {gate !== null && <p className="muted">{gate.survives}</p>}

                    <ul className="reasons">
                        {gate?.slots.map((slot) => (
                            <li key={slot.index}>
                                {slot.index}. {slot.label}
                            </li>
                        ))}
                    </ul>

                    {vault.spent !== null && <Notice tone="caution">{vault.spent.reason}</Notice>}

                    <div className="card-foot">
                        <span className="muted">
                            Seal file:{" "}
                            {flow.state.sealFile === null ? (
                                // Reported, not hidden: this browser holds the seal but not the
                                // file, and only the copy on disk can recover elsewhere.
                                <span>handed over at seal time</span>
                            ) : (
                                // `TextLink` takes an href and nothing else, and this is an action
                                // rather than a destination — so a button wearing a link's clothes,
                                // which is the accessible way round.
                                <button
                                    type="button"
                                    className="linkish"
                                    onClick={() => {
                                        if (flow.state.sealFile !== null) {
                                            downloadSeal(vault, flow.state.sealFile);
                                        }
                                    }}
                                >
                                    Download
                                </button>
                            )}
                        </span>
                        <Button variant="ghost" onClick={() => setSealing(true)}>
                            {vault.spent === null ? "Replace guardians" : "Set up a new gate"}
                        </Button>
                    </div>

                    <Explain>
                        {vault.spent === null ? (
                            <p>
                                {health === "unwatched"
                                    ? "Nothing is monitoring this vault yet, because this demo has not built the watchtower role — server/src/roles/ is empty. A watchtower registration is what turns “no recovery has started” from a guess into an observation; until one exists the badge above says only that nobody in this browser has started one."
                                    : "The badge above reports what this app knows about attempts on this vault."}
                            </p>
                        ) : (
                            <p>
                                A new gate on this account does not undo the recovery. It decrypted
                                every record, so the root secret is known to whoever ran it, and a fresh
                                set of guardians would be guarding a key someone else already has. The
                                real answer is a new account, and moving what is in this one to it — the
                                new gate below only stops this browser holding a spent seal.
                            </p>
                        )}
                        <p>
                            Replacing guardians buys a whole new set of seals under a new vault id. The
                            old gate keeps working until the new one finishes, and is discarded only
                            once it has.
                        </p>
                    </Explain>
                </div>
            </details>

            {/* Outside the disclosure: a failure the user cannot see because the card is closed is a
                failure they will not act on. */}
            {failure}
            {dialog}
        </Card>
    );
}
