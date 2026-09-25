/**
 * One passport scan, as a recovery asks for it: a QR code for a phone, the same link to open on the
 * phone itself, where the request has got to, and a fresh request when this one is dead.
 *
 * It renders a `SubjectPrompt` and nothing else. The request, its status and the retry all come from
 * `integration/conditions/subjects/emailPassport.ts`; this file draws them.
 */
import QRCode from "react-qr-code";
import type { SubjectPrompt } from "../integration/conditions/types.js";
import { AddressChip } from "./AddressChip.js";
import { Button, StatusMessage, TextLink } from "./ds.js";

export function PassportScan({ prompt }: { prompt: SubjectPrompt }) {
    const link = prompt.link;
    return (
        <div className="passport-scan">
            <span className="field__label">{prompt.title}</span>
            <span className="muted">{prompt.detail}</span>

            {link !== undefined && (
                <>
                    {/* White behind the code whatever the surface: scanners need the contrast. */}
                    <div className="passport-scan__qr">
                        <QRCode value={link.url} size={200} />
                    </div>
                    <div className="row">
                        <TextLink href={link.url} external>
                            {link.label}
                        </TextLink>
                        <AddressChip value={link.url} display={shorten(link.url)} />
                    </div>
                </>
            )}

            {prompt.error !== undefined && <StatusMessage tone="error">{prompt.error}</StatusMessage>}

            {prompt.retry !== undefined && (
                <div className="row">
                    <Button variant="ghost" onClick={prompt.retry}>
                        New request
                    </Button>
                </div>
            )}
        </div>
    );
}

function shorten(url: string): string {
    return url.length <= 40 ? url : `${url.slice(0, 28)}…${url.slice(-8)}`;
}
