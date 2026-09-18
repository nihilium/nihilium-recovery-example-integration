/**
 * What the user does with the seal once it exists: one row, three controls.
 *
 * The greyed-out button is the point of it. Mailing a seal to a guardian's address is the affordance
 * a wallet is most tempted to build, and `checkSealPlacement` in the SDK is the function that says
 * why not — so the tooltip is its sentence, not ours, and it is on the button whether or not the
 * Explain toggle is on. Everything around it explains rather than reports, so it moved inside
 * `<Explain>`.
 */
import { checkSealPlacement } from "@nihilium/recovery-core";
import type { GateRecord } from "../integration/conditions/types.js";
import type { SealFile } from "../integration/recovery/sealFile.js";
import type { VaultRecord } from "../integration/recovery/vaultRecords.js";
import { Button } from "./ds.js";
import { downloadSeal } from "./downloadSeal.js";
import { Explain } from "./Explain.js";
import { Notice } from "./Notice.js";
import { AddressChip } from "./AddressChip.js";

function collisions(gate: GateRecord): { label: string; reason: string }[] {
    return gate.subjects.flatMap((subject) => {
        const domain = subject.placementDomain;
        if (domain === undefined) return [];
        // Both arguments are the same domain deliberately: *if* the seal were mailed there, that
        // mailbox would be both the store and the identity factor — which is the case the §12 check
        // exists to name.
        const reason = checkSealPlacement(domain, domain);
        return reason === undefined ? [] : [{ label: subject.publicLabel, reason }];
    });
}

export function SealRow({ vault, sealFile }: { vault: VaultRecord; sealFile: SealFile | null }) {
    const blocked = collisions(vault.gate);
    const survivesOne = vault.gate.threshold >= 2;

    return (
        <div className="stack">
            <div className="row">
                <span className="field__label">Seal file</span>

                <Button
                    onClick={() => sealFile !== null && downloadSeal(vault, sealFile)}
                    disabled={sealFile === null}
                >
                    Download
                </Button>

                <span className="seal-card__disabled" title={blocked[0]?.reason ?? ""}>
                    <Button variant="ghost" disabled>
                        Mail me the seal
                    </Button>
                </span>

                <span className="muted">Record id</span>
                <AddressChip value={vault.recordId} display={vault.recordId} />
            </div>

            {sealFile === null && (
                <Notice>
                    This browser holds the seal but not the file — it was handed over once, at seal
                    time.
                </Notice>
            )}

            <Explain>
                <p>
                    One file, and the only artifact you must keep. Whoever holds it may <em>attempt</em>{" "}
                    a recovery — the identity gate and the on-chain veto are what stand in the way.
                    Losing it loses the recovery; the encrypted records are the opposite and should be
                    copied everywhere.
                </p>
                <p>
                    <strong>Mail me the seal</strong> is disabled for two reasons, and both are worth
                    reading:
                </p>
                <ul className="reasons">
                    {blocked.length > 0 && (
                        <li>
                            <span className="mono">{blocked[0]!.reason}</span>
                            <br />
                            {survivesOne ? (
                                <>
                                    At {vault.gate.threshold} of {vault.gate.subjectCount} that is not
                                    instantly fatal — it degrades the gate from “any{" "}
                                    {vault.gate.threshold} of {vault.gate.subjectCount}” to “that
                                    mailbox, plus any {vault.gate.threshold - 1} other”.
                                </>
                            ) : (
                                <>
                                    At 1 of 1 it is fatal: that mailbox would hold the seal and be the
                                    whole gate.
                                </>
                            )}
                        </li>
                    )}
                    <li>
                        This demo has no mail sender, and will not grow one. Neither reason is used to
                        hide the other.
                    </li>
                </ul>
                <p>
                    The record id is a meaningless lookup handle that yields ciphertext and nothing
                    else, so it is safe to email. That it may be mailed while the seal may not{" "}
                    <em>is</em> the two-domain rule, in one row.
                </p>
            </Explain>
        </div>
    );
}
