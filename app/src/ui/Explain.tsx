/**
 * The switch between a product and a lesson.
 *
 * This repo's job is to teach an integration, and the way it did that was to print the lesson on the
 * screen — every card explaining itself at the same weight as the status it was reporting, until
 * neither read. So the teaching copy is still here, all of it, behind one toggle that is off by
 * default: at rest a card shows a heading, at most one sentence, its status and its actions.
 *
 * The rule for deciding which side a string belongs on is *reports* versus *teaches*. A verdict on a
 * guardian's domain, the price before a paid button, `spent.reason`, the `Demo` tag — those report,
 * and stay visible however the toggle is set. Why the two-domain rule exists, what a quorum survives,
 * why Solana's settlement is simulated — those teach, and live in here.
 */
import { useCallback, useMemo, useState } from "react";
import { ExplainContext, readExplain, useExplain, writeExplain } from "./explainContext.js";

export function ExplainProvider({ children }: { children: React.ReactNode }) {
    const [on, setOn] = useState(readExplain);

    const toggle = useCallback(() => {
        setOn((prev) => {
            writeExplain(!prev);
            return !prev;
        });
    }, []);

    const value = useMemo(() => ({ on, toggle }), [on, toggle]);

    return <ExplainContext.Provider value={value}>{children}</ExplainContext.Provider>;
}

/** Renders nothing at all when the toggle is off — not hidden, not collapsed, absent. */
export function Explain({ children }: { children: React.ReactNode }) {
    const { on } = useExplain();
    if (!on) return null;
    return <div className="explain">{children}</div>;
}
