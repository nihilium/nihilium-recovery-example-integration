/**
 * The "this is a demo" line. On every screen, never dismissible.
 *
 * It names the three things a reader could otherwise get wrong: the seed is public, the money is
 * testnet, and recovery covers loss rather than theft.
 */
import { DEMO_MNEMONIC_WARNING } from "../demo/mnemonic.js";
import type { RecoveryMode } from "../demo/env.js";

export function DemoBanner({ mode }: { mode: RecoveryMode }) {
    return (
        <div className="demo-banner" role="note">
            <span className="demo-banner__tag">Demo</span>
            <span className="demo-banner__text">
                Example integration of the Nihilium Recovery SDK — not a wallet. {DEMO_MNEMONIC_WARNING}{" "}
                Recovery here restores access an owner <em>lost</em>; it does not defend a wallet
                whose seed someone else holds.{" "}
                {mode === "live"
                    ? "Live mode: identity ceremonies are real, paid, and take minutes."
                    : "Simulated identity ceremony: offline and free. Every other part of the SDK is real."}
            </span>
        </div>
    );
}
