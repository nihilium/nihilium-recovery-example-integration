/**
 * The copy line, enforced.
 *
 * CLAUDE.md says everything under `src/integration/**` must be liftable into another codebase with
 * a single copy. That is a property nobody can hold in their head while writing a component, so it
 * is a test — modelled on the SDK's own `packages/core/test/boundaries.test.ts`, which pins its
 * dependency rules the same way.
 */
import { describe, expect, it } from "vitest";
import { readSources } from "./helpers/sources.js";

const integration = readSources("src/integration");

/** Files that may import React. A hook wrapping integration logic is the only legitimate case. */
const REACT_ALLOWLIST: readonly string[] = [];

/**
 * Node-only by resolution, or node-only in fact. `storage-local` is the trap: its exports map says
 * `default`, so a bundler resolves it happily and then breaks on `node:fs` at runtime.
 */
const NODE_ONLY_PACKAGES = [
    "@nihilium/recovery-storage-local",
    "@nihilium/recovery-service",
    "@nihilium/recovery-watchtower",
];

describe("the copy line", () => {
    it("has files to check", () => {
        // A boundary test that silently passes over an empty directory is the CI form of a rule
        // nobody is following.
        expect(integration.length).toBeGreaterThan(0);
    });

    it("never imports the demo, the UI or the scenarios", () => {
        const violations = integration.flatMap((file) =>
            file.imports
                .filter((specifier) => /(^|\/)(demo|ui|scenarios)\//.test(specifier))
                .map((specifier) => `${file.path} -> ${specifier}`),
        );
        expect(violations, "anything demo-shaped arrives as a parameter").toEqual([]);
    });

    it("imports React only where an allowlisted hook does", () => {
        const violations = integration
            .filter((file) => !REACT_ALLOWLIST.includes(file.path))
            .flatMap((file) =>
                file.imports
                    .filter((specifier) => specifier === "react" || specifier.startsWith("react/"))
                    .map((specifier) => `${file.path} -> ${specifier}`),
            );
        expect(violations, "plain functions, so a Vue or Node caller can use the same file").toEqual([]);
    });

    it("imports no node builtin anywhere in the browser bundle", () => {
        // `tsconfig.app.json` now includes the `node` types, because the Solana bindings are written
        // against `Buffer` and there is no browser-typed alternative. That made `fs`, `path` and
        // friends type-check inside app code, so the guard moved here — where it can check what is
        // actually imported rather than what happens to be declared.
        const all = readSources("src");
        const violations = all.flatMap((file) =>
            file.imports
                .filter((specifier) => specifier.startsWith("node:"))
                .map((specifier) => `${file.path} -> ${specifier}`),
        );
        expect(violations, "a node builtin in the browser bundle breaks at runtime, not at build").toEqual([]);
    });

    it("keeps node-only SDK packages out of the browser bundle", () => {
        const all = readSources("src");
        const violations = all.flatMap((file) =>
            file.imports
                .filter((specifier) => NODE_ONLY_PACKAGES.some((pkg) => specifier.startsWith(pkg)))
                .map((specifier) => `${file.path} -> ${specifier}`),
        );
        expect(violations, "the server holds these; a browser import breaks at runtime").toEqual([]);
    });

    it("opens every file with what it does, what to replace and what it assumes", () => {
        const missing = integration
            .filter((file) => {
                // The whole leading block, not a fixed slice: the headers worth having are long, and
                // a truncating check would fail exactly the files that explain themselves best.
                const match = /^\s*\/\*\*([\s\S]*?)\*\//.exec(file.text);
                if (match === null) return true;
                // Not a word count: the header has to answer the two questions a copier asks.
                return !/replace|assum/i.test(match[1] as string);
            })
            .map((file) => file.path);
        expect(missing, "a copyable file says what to change and what it takes for granted").toEqual([]);
    });
});
