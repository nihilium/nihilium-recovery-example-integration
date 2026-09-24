/**
 * What the picker offers, wired or not.
 *
 * The SDK ships three condition adapters that fit this app's shape, and this demo has integrated
 * one. Listing only that one would teach that it is the whole surface; listing all three with the
 * unwired ones greyed and the reason attached teaches the actual state of play, and tells a reader
 * exactly what integrating the other two would take.
 *
 * **To replace:** all of it. A real wallet picks one method from its own configuration and shows no
 * picker at all — the choice here exists because the choice is the lesson.
 * **Assumes:** an entry marked `available` resolves through `MethodRegistry.get(id)`. `registry.ts`
 * builds this list from the methods it actually constructed, so the two cannot drift.
 */
import type { MethodOffer } from "./types.js";

export const ZKPASSPORT_METHOD_ID = "zkpassport-quorum";
export const EMAIL_ZKPASSPORT_METHOD_ID = "email-zkpassport-quorum";

/**
 * The two methods this demo has not wired, and precisely why.
 *
 * Both adapters are real and both *seal* from typed fields alone — a passport condition is a
 * commitment to a name and an exact date of birth, and committing needs no scan. It is **recovery**
 * that needs the ZKPassport browser SDK, a QR code and a physical passport, and a method that can be
 * sealed but never opened is worse than one that is absent. So they are shown, and refused.
 */
export const UNWIRED_OFFERS: readonly MethodOffer[] = [
    // Why neither is wired: recovering needs the ZKPassport browser SDK, a QR scan and a physical
    // passport, none of which this demo drives. `@nihilium/recovery-condition-zkemail-zkpassport` and
    // `@nihilium/recovery-condition-zkpassport` are real and would seal from these fields — sealing
    // a gate that can never be opened is the outcome this list exists to prevent.
    {
        id: EMAIL_ZKPASSPORT_METHOD_ID,
        label: "Email and passport",
        icon: "ShieldCheck",
        blurb: "Each guardian proves an inbox and a passport.",
        available: false,
        unavailable: "Not available in this demo.",
    },
    {
        id: ZKPASSPORT_METHOD_ID,
        label: "Passport only",
        icon: "DocumentCheck",
        blurb: "Recover with a passport's name and date of birth.",
        available: false,
        unavailable: "Not available in this demo.",
    },
];
