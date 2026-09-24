/**
 * The "this is a demo" line. On every screen, never dismissible.
 *
 * One sentence, because a four-sentence banner is one nobody reads twice. The sentence that stays is
 * the one with a cost attached: the ceremony is live and sealing spends money.
 *
 * The reset lives here rather than in a settings page because it belongs to the demo, not to the
 * wallet — a wallet has no reset button, and losing the device is the reset. This app has no
 * migration paths on purpose (a seal is bearer material, records are append-only, and a handover row
 * is the only surviving record of an intent whose key was destroyed), so starting over is the only
 * honest escape from a wedged state, and it should be one visible control rather than a trip through
 * browser site settings.
 */
export function DemoBanner({
    ceremonyReady,
    onReset,
}: {
    ceremonyReady: boolean;
    onReset: () => void;
}) {
    return (
        <div className="demo-banner" role="note">
            <span className="demo-banner__tag">Demo</span>
            <span className="demo-banner__text">
                {ceremonyReady ? (
                    <>
                        <strong>Live</strong> ceremony · sealing is paid · recovery emails your
                        guardians
                    </>
                ) : (
                    <strong>The live ceremony is not configured. Set VITE_NIHILIUM_API_KEY in app/.env.local.</strong>
                )}

            </span>
            <button type="button" className="linkish demo-banner__reset" onClick={onReset}>
                Reset
            </button>
        </div>
    );
}
