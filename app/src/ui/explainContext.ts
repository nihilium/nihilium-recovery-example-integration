/**
 * The Explain toggle's state, kept out of the component file so fast refresh stays happy.
 *
 * The preference persists, because a reader who turned the explanations on is reading, and having
 * to turn them back on after every reload is its own small hostility. Every `localStorage` access is
 * wrapped: it throws in a private window and in anything that blocks site data, and a demo that
 * fails to render over a preference would be absurd.
 */
import { createContext, useContext } from "react";

export const EXPLAIN_KEY = "nihilium-demo.explain";

export interface ExplainState {
    on: boolean;
    toggle: () => void;
}

export const ExplainContext = createContext<ExplainState>({ on: false, toggle: () => undefined });

export function useExplain(): ExplainState {
    return useContext(ExplainContext);
}

export function readExplain(): boolean {
    try {
        return window.localStorage.getItem(EXPLAIN_KEY) === "on";
    } catch {
        return false;
    }
}

export function writeExplain(on: boolean): void {
    try {
        window.localStorage.setItem(EXPLAIN_KEY, on ? "on" : "off");
    } catch {
        /* the toggle still works for this session */
    }
}
