/**
 * What the picker offers beyond what `registry.ts` wires.
 *
 * The SDK ships three condition adapters that fit this app's shape, and this demo has integrated
 * two: the email quorum and the fused email-and-passport gate. Listing only those would teach that
 * they are the whole surface; listing the third greyed, with the reason attached, teaches the actual
 * state of play and tells a reader exactly what integrating it would take.
 *
 * **To replace:** all of it. A real wallet picks one method from its own configuration and shows no
 * picker at all — the choice here exists because the choice is the lesson.
 * **Assumes:** an entry here never resolves through `MethodRegistry.get(id)`. `registry.ts` builds
 * the available offers from the methods it actually constructed, so the two cannot drift.
 */
import type { MethodOffer } from "./types.js";

export const ZKPASSPORT_METHOD_ID = "zkpassport-quorum";

/**
 * The method this demo has not wired, and why.
 *
 * Everything a passport-only gate needs to *run* now exists here: `passport/zkPassportProver.ts`
 * drives the scan, and the recovery dialog renders its QR code. What is missing is a subject kind
 * for `@nihilium/recovery-condition-zkpassport` — whose seal records no identity by default, so its
 * recovery asks for the name and date of birth again — and one line in `registry.ts`.
 */
export const UNWIRED_OFFERS: readonly MethodOffer[] = [
    {
        id: ZKPASSPORT_METHOD_ID,
        label: "Passport only",
        icon: "DocumentCheck",
        blurb: "Recover with a passport's name and date of birth.",
        available: false,
        unavailable: "Not available in this demo.",
    },
];
