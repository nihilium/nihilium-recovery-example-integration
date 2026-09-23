/**
 * The "this is a demo" line. On every screen, never dismissible.
 *
 * One sentence at rest, because a four-sentence banner is one nobody reads twice. The sentence that
 * stays is the one with a cost attached — the ceremony is live and sealing spends money. The rest
 * are true and worth knowing, so they are still here, behind the Explain toggle.
 */
import { SEED_WARNING } from "../demo/mnemonic.js";
import { Explain } from "./Explain.js";

export function DemoBanner({ ceremonyReady }: { ceremonyReady: boolean }) {
    return (
        <div className="demo-banner" role="note">
            <span className="demo-banner__tag">Demo</span>
            <span className="demo-banner__text">
                {ceremonyReady ? (
                    <>
                        The identity ceremony is <strong>live</strong>: sealing is paid, once per
                        guardian, and recovering emails real people and waits for them.
                    </>
                ) : (
                    <strong>The live ceremony is not configured, so nothing can be sealed yet.</strong>
                )}

                <Explain>
                    <p>
                        Example integration of the Nihilium Recovery SDK — not a wallet.{" "}
                        {SEED_WARNING}
                    </p>
                    <p>
                        Recovery here restores access an owner <em>lost</em>; it does not defend a
                        wallet whose seed someone else holds.
                    </p>
                </Explain>
            </span>
        </div>
    );
}
