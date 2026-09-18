/**
 * Runs each subject's preflight check while the user is still typing, and answers one question for
 * the setup form: may this gate be sealed at all?
 *
 * Ported in spirit from `../keyless-recovery/src/recovery/useEmailDomainChecks.ts` and
 * `../forgot-my-password-ui`, with the same reasoning and one difference: it is not email-shaped.
 * It calls `SubjectKind.preflight`, so a passport kind that has something to check gets the same
 * debounce, cache and blocking behaviour for free, and a kind with nothing to check declares no
 * `preflight` and this hook does nothing.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { PreflightVerdict, Subject, SubjectKind } from "../integration/conditions/types.js";

/** Long enough that a typed address is not checked letter by letter, short enough to feel live. */
const DEBOUNCE_MS = 500;

const CHECKING: PreflightVerdict = {
    status: "checking",
    code: "checking",
    message: "Checking the registry…",
};

export interface DomainChecks {
    /** Keyed by the subject's position in the form, not by its index in a gate that does not exist yet. */
    verdicts: Record<number, PreflightVerdict>;
    /**
     * True while anything is `checking` or `blocking`.
     *
     * `checking` is included so a fast typist cannot beat the request to the button. A registry
     * outage (`warning`) is deliberately **not** included: a failed check is not evidence about a
     * domain, and blocking on one teaches people to click through the block.
     */
    blocking: boolean;
    /** Drops a cached answer and asks again — what "check again" does after registering a domain. */
    recheck(position: number): void;
}

export function useEmailDomainChecks(
    kind: SubjectKind,
    subjects: readonly (Subject | null)[],
): DomainChecks {
    const [verdicts, setVerdicts] = useState<Record<number, PreflightVerdict>>({});

    /**
     * Cached per *domain*, which pays off more than per address: a five-guardian set is routinely
     * five addresses at two or three domains, so editing a local part costs no request at all.
     */
    const cache = useRef(new Map<string, PreflightVerdict>());
    const [nonce, setNonce] = useState(0);

    // A string, because `subjects` is rebuilt on every keystroke and depending on the array itself
    // re-runs the effect on every render — which cancels the debounce timer in its own cleanup
    // before it can ever fire, so nothing is checked and every field sits at `checking` forever.
    // (It did exactly that, once.)
    const key = subjects.map((subject) => subject?.id ?? "").join("\n");

    // Read by the effect below, which must not *depend* on the array. Effects run in declaration
    // order within a commit, so this one has already stored the set that produced the current key.
    const latest = useRef(subjects);
    useEffect(() => {
        latest.current = subjects;
    });

    useEffect(() => {
        if (kind.preflight === undefined) return;
        const subjectsNow = latest.current;

        const controller = new AbortController();
        let live = true;

        const cacheKeyFor = (subject: Subject): string => subject.placementDomain ?? subject.id;

        // Paint what is already known immediately, and `checking` for the rest, so the button state
        // is honest during the debounce window rather than briefly claiming the gate is sealable.
        setVerdicts(() => {
            const next: Record<number, PreflightVerdict> = {};
            subjectsNow.forEach((subject, position) => {
                if (subject === null) return;
                // Stale positions are dropped rather than carried: a corrected typo must not leave
                // the old verdict on screen.
                next[position] = cache.current.get(cacheKeyFor(subject)) ?? CHECKING;
            });
            return next;
        });

        const timer = setTimeout(() => {
            subjectsNow.forEach((subject, position) => {
                if (subject === null) return;
                const cacheKey = cacheKeyFor(subject);
                if (cache.current.has(cacheKey)) return;

                void kind.preflight?.(subject, controller.signal).then((verdict) => {
                    if (!live) return;
                    // An outage is not cached: a transient failure should not stick to the domain
                    // for the rest of the session.
                    if (verdict.status !== "warning" && verdict.status !== "unknown") {
                        cache.current.set(cacheKey, verdict);
                    }
                    setVerdicts((prev) => ({ ...prev, [position]: verdict }));
                });
            });
        }, DEBOUNCE_MS);

        return () => {
            live = false;
            controller.abort();
            clearTimeout(timer);
        };
    }, [kind, key, nonce]);

    const recheck = useCallback(
        (position: number) => {
            const subject = subjects[position];
            if (subject === undefined || subject === null) return;
            cache.current.delete(subject.placementDomain ?? subject.id);
            setNonce((previous) => previous + 1);
        },
        [subjects],
    );

    const blocking = Object.values(verdicts).some(
        (verdict) => verdict.status === "blocking" || verdict.status === "checking",
    );

    return { verdicts, blocking, recheck };
}
