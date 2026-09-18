/**
 * The server's half of the copy line, plus the two separations that are easy to erode.
 *
 * `roles/**` is meant to be liftable: each role takes its configuration and its logger as
 * parameters, so the same directory drops into another Express app without dragging this one's
 * environment with it. And the record host must never become reachable from the demo directory —
 * the whole point of that role's existence is that the SDK refuses to be it.
 */
import { describe, expect, it } from "vitest";
import { readSources } from "./helpers/sources.js";

const roles = readSources("src/roles");
const all = readSources("src");

describe("the server's copy line", () => {
    it("keeps the host's config, logger and banner out of roles/", () => {
        const violations = roles.flatMap((file) =>
            file.imports
                .filter((specifier) => /(^|\/)(config|log|boot)(\.js)?$/.test(specifier))
                .map((specifier) => `${file.path} -> ${specifier}`),
        );
        expect(violations, "a role receives what it needs; it never reaches for the host's").toEqual([]);
    });

    it("lets only the entrypoint read the config", () => {
        const violations = all
            .filter((file) => !file.path.endsWith("src/index.ts") && !file.path.endsWith("src/config.ts"))
            .flatMap((file) =>
                file.text
                    .split("\n")
                    .filter((line) => /from\s+["']\.{1,2}\/config(\.js)?["']/.test(line))
                    // A type-only import is a shape, not a dependency on the environment.
                    .filter((line) => !line.includes("import type"))
                    .map((line) => `${file.path}: ${line.trim()}`),
            );
        expect(violations).toEqual([]);
    });

    it("keeps the record host and the demo directory apart, in both directions", () => {
        const edges = roles.flatMap((file) => {
            const inRecords = file.path.includes("/roles/records/");
            const inDirectory = file.path.includes("/roles/demo-directory/");
            if (!inRecords && !inDirectory) return [];
            const forbidden = inRecords ? "demo-directory" : "records";
            return file.imports
                .filter((specifier) => specifier.includes(`/${forbidden}/`) || specifier.includes(`../${forbidden}`))
                .map((specifier) => `${file.path} -> ${specifier}`);
        });
        expect(
            edges,
            "the SDK's record host has no listing route on purpose; the directory is that thing, and " +
                "the two must stay visibly separate piles",
        ).toEqual([]);
    });

    it("opens every role file with what it does, what to replace and what it assumes", () => {
        const missing = roles
            .filter((file) => {
                const match = /^\s*\/\*\*([\s\S]*?)\*\//.exec(file.text);
                return match === null || !/replace|assum/i.test(match[1] as string);
            })
            .map((file) => file.path);
        expect(missing).toEqual([]);
    });

    it("is actually looking at this server", () => {
        // Guards the suite itself: if `readSources` ever stops finding the tree, every rule above
        // passes over an empty list and the boundary silently stops existing.
        expect(all.length).toBeGreaterThan(0);
    });
});
