/**
 * The key a recovery produced, as rows.
 *
 * A wallet that says "recovered" and shows nothing is asking to be taken on trust. This is the thing
 * that came out of the ceremony, so it is shown: the curve, the public half, the address the module
 * compares against, and — behind one click — the private half.
 *
 * The private key is here because this demo runs in `rawKey` mode and its mnemonic is printed on the
 * front page; showing it makes *"the key is assembled"* a thing you can look at rather than a claim
 * to believe. It is behind a Reveal because a key on screen ends up in screenshots and shoulder
 * views, and a demo is exactly where someone records their screen.
 */
import { useState } from "react";
import type { KeyAlgorithm } from "@nihilium/recovery-core";
import { AddressChip } from "./AddressChip.js";
import { Explain } from "./Explain.js";

export function RecoveredKey({
    algorithm,
    publicKeyHex,
    address,
    material,
    matchesVault,
    contacted,
    untouched,
}: {
    algorithm: KeyAlgorithm;
    publicKeyHex: string;
    /** The chain-native address form, where the chain has one. */
    address: string | null;
    /** `null` once the dialog has dropped it, or in capability mode. */
    material: Uint8Array | null;
    matchesVault: boolean;
    contacted: readonly number[];
    untouched: readonly number[];
}) {
    const [revealed, setRevealed] = useState(false);

    return (
        <div className="stack">
            <dl className="rows">
                <dt>algorithm</dt>
                <dd>{algorithm}</dd>

                <dt>public key</dt>
                <dd>
                    <AddressChip value={publicKeyHex} display={truncate(publicKeyHex)} />
                </dd>

                {address !== null && (
                    <>
                        <dt>address</dt>
                        <dd>
                            <AddressChip value={address} display={truncate(address)} />
                        </dd>
                    </>
                )}

                <dt>private key</dt>
                <dd>
                    {material === null ? (
                        <span className="muted">dropped</span>
                    ) : revealed ? (
                        <AddressChip value={toHex(material)} display={truncate(toHex(material))} />
                    ) : (
                        <button type="button" className="linkish" onClick={() => setRevealed(true)}>
                            Reveal
                        </button>
                    )}
                </dd>

                <dt>matches</dt>
                <dd className="rows__prose">
                    {matchesVault ? (
                        <>✓ the key this vault registered</>
                    ) : (
                        // Unreachable in practice — `assertRecoveredKeyMatches` throws first — and
                        // rendered anyway, because the one failure this must never show as a tick is
                        // the one nothing else in the stack can detect.
                        <strong>✗ not the key this vault registered</strong>
                    )}
                </dd>

                <dt>contacted</dt>
                <dd>{contacted.map((i) => `#${i}`).join(", ") || "—"}</dd>

                <dt>not contacted</dt>
                <dd>{untouched.map((i) => `#${i}`).join(", ") || "—"}</dd>
            </dl>

            <Explain>
                <p>
                    The guardians under <em>not contacted</em> were never asked — their share was not
                    requested and no email reached them. That is the property a k-of-n buys: not a
                    vote, an absence.
                </p>
                <p>
                    This key is held in the clear for as long as this dialog is open, because the
                    on-chain handover cannot be signed without it. A production wallet should take the
                    scoped capability instead and let it zeroize.
                </p>
            </Explain>
        </div>
    );
}

function truncate(hex: string): string {
    return hex.length <= 22 ? hex : `${hex.slice(0, 10)}…${hex.slice(-8)}`;
}

function toHex(bytes: Uint8Array): string {
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
