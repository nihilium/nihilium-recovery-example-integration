/**
 * The keys a recovery produced — one block per chain — and the count of ceremonies that bought them.
 *
 * A wallet that says "recovered" and shows nothing is asking to be taken on trust. This is the thing
 * that came out of the ceremony, so it is available: the curve, the public half, the address the
 * module compares against, and — behind one more click — the private half. All of it sits in a
 * closed "Raw recovered keys" fold under the one-line result, because once the handover is submitted
 * it is evidence rather than something to act on. A chain that failed stays outside the fold.
 *
 * The private key is here because this demo runs in `rawKey` mode and its mnemonic is printed on the
 * front page; showing it makes *"the key is assembled"* a thing you can look at rather than a claim
 * to believe. It is behind a Reveal because a key on screen ends up in screenshots and shoulder
 * views, and a demo is exactly where someone records their screen.
 *
 * **Plural, and the plurality is the lesson.** One vault covers many chains, so one ceremony returns
 * a key for each — and the ceremony count is printed beside them, because "two keys, one round of
 * email" is the claim this repo is built to make and a number is the only way to show it. A chain
 * that failed gets a row saying so rather than being dropped: a silently shorter list would read as
 * a vault that never held it.
 */
import { useState } from "react";
import type { RecoveredChainKey } from "../integration/recovery/recoverAll.js";
import { AddressChip } from "./AddressChip.js";
import { Heading, StatusMessage } from "./ds.js";

export function RecoveredKeys({
    keys,
    ceremonies,
    contacted,
    untouched,
}: {
    keys: readonly RecoveredChainKey[];
    /** How many rounds of guardian email this cost. One, for any number of chains. */
    ceremonies: number;
    contacted: readonly number[];
    untouched: readonly number[];
}) {
    const opened = keys.filter((key) => key.failure === null);
    const failed = keys.filter((key) => key.failure !== null);

    return (
        <div className="stack">
            {/* The count, and nothing after it. The clause that used to follow — that the
                guardians were asked once for the whole vault — is the lesson this screen teaches,
                not a fact about this run, and `docs/` is where it belongs. */}
            <StatusMessage tone="success">
                {opened.length} chain{opened.length === 1 ? "" : "s"} recovered from {ceremonies}{" "}
                ceremon{ceremonies === 1 ? "y" : "ies"}.
            </StatusMessage>

            {/* A failure is status, not evidence, so it stays out of the fold: hidden behind a click
                it would read as a vault that never covered that chain. */}
            {failed.map((key) => (
                <ChainKey key={key.chainId} entry={key} />
            ))}

            {/* Closed by default: the count above is the result, and what follows is the evidence
                for it. `<details>` for the same reason as the transcript fold — it brings the
                open state, the keyboard handling and the expanded/collapsed role with it. */}
            <details className="transcript-fold">
                <summary>
                    <span className="disclosure__marker" aria-hidden="true" />
                    Raw recovered keys
                </summary>
                <div className="stack">
                    {opened.map((key) => (
                        <ChainKey key={key.chainId} entry={key} />
                    ))}

                    <dl className="rows">
                        <dt>contacted</dt>
                        <dd>{contacted.map((i) => `#${i}`).join(", ") || "—"}</dd>

                        <dt>not contacted</dt>
                        <dd>{untouched.map((i) => `#${i}`).join(", ") || "—"}</dd>
                    </dl>
                </div>
            </details>
        </div>
    );
}

function ChainKey({ entry }: { entry: RecoveredChainKey }) {
    const [revealed, setRevealed] = useState(false);

    if (entry.failure !== null) {
        return (
            <div className="stack">
                <Heading level={4}>{entry.chainLabel}</Heading>
                {/* A row, not an omission. A chain quietly missing from this list would read as a
                    vault that never covered it — and the fix for that is a second paid ceremony. */}
                <StatusMessage tone="error">{entry.failure}</StatusMessage>
            </div>
        );
    }

    const material = entry.material;
    return (
        <div className="stack">
            <Heading level={4}>{entry.chainLabel}</Heading>
            <dl className="rows">
                <dt>algorithm</dt>
                <dd>{entry.chainRecord.algorithm}</dd>

                <dt>public key</dt>
                <dd>
                    <AddressChip
                        value={entry.publicKeyHex!}
                        display={truncate(entry.publicKeyHex!)}
                    />
                </dd>

                {entry.address !== null && (
                    <>
                        <dt>address</dt>
                        <dd>
                            <AddressChip value={entry.address} display={truncate(entry.address)} />
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
                {/* `assertRecoveredKeyMatches` throws before a mismatch could reach here, so this is
                    always a tick — and it is rendered because a wrong epoch is the one failure
                    nothing else in the stack can detect, and silence about it would be worse. */}
                <dd className="rows__prose">✓ the key this vault registered</dd>
            </dl>
        </div>
    );
}

function truncate(hex: string): string {
    return hex.length <= 22 ? hex : `${hex.slice(0, 10)}…${hex.slice(-8)}`;
}

function toHex(bytes: Uint8Array): string {
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
