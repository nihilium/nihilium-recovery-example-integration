/**
 * Reads this app's own source tree, so the boundary tests can assert on imports.
 *
 * Deliberately a regex over specifiers rather than an AST: the rules being enforced are about which
 * *files* may name which *modules*, and a 30-line reader that anyone can audit is worth more here
 * than a parser dependency. It over-matches only inside strings and comments, which is the safe
 * direction — a false positive is a conversation, a false negative is a boundary that quietly stopped
 * existing.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "..");

export interface SourceFile {
    /** Repo-relative, POSIX separators — what a failure message should print. */
    path: string;
    absolute: string;
    text: string;
    /** Every `from "x"`, `import("x")` and `require("x")` specifier, in source order. */
    imports: string[];
}

const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["']([^"']+)["']/g;

export function readSources(dir: string, extensions = [".ts", ".tsx"]): SourceFile[] {
    const base = resolve(ROOT, dir);
    const out: SourceFile[] = [];

    const walk = (current: string): void => {
        let entries: string[];
        try {
            entries = readdirSync(current);
        } catch {
            return; // A directory a milestone has not created yet is not a violation.
        }
        for (const entry of entries) {
            const path = join(current, entry);
            if (statSync(path).isDirectory()) {
                if (entry === "node_modules" || entry === "vendor" || entry === "dist") continue;
                walk(path);
                continue;
            }
            if (!extensions.some((ext) => entry.endsWith(ext))) continue;
            const text = readFileSync(path, "utf8");
            out.push({
                path: relative(ROOT, path).replaceAll("\\", "/"),
                absolute: path,
                text,
                imports: [...text.matchAll(SPECIFIER)].map((match) => match[1] as string),
            });
        }
    };

    walk(base);
    return out;
}
