/**
 * Creates `app/.env.local` and `server/.env` on first install, with matching random secrets.
 *
 * Two of this demo's values have to agree across the two halves — the record host's append
 * credential and the watchtower's registration credential — and they are capabilities, not
 * settings. Shipping them as constants in `.env.example` would mean every clone of this repo shares
 * a write credential for every other clone's record host, which is a strange thing for a repo about
 * custody to do. So they are generated here, once, per machine.
 *
 * **The pair is the unit, not the file.** Deleting one of the two files and re-running used to mint
 * fresh secrets for it while the survivor kept the old ones — two files that each look fine and
 * disagree, which surfaces much later as a 403 from the record host. So an existing value always
 * wins: a missing file is rebuilt from whatever its counterpart already holds, and generation only
 * happens for a secret that exists in neither. Existing files are never modified.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));

/** One shared secret, under the name each side calls it. */
const SHARED = [
    { name: "RECORD_APPEND_SECRET", app: "VITE_RECORD_APPEND_SECRET", server: "RECORD_APPEND_SECRET" },
    { name: "WATCH_REGISTER_SECRET", app: "VITE_WATCH_REGISTER_SECRET", server: "WATCH_REGISTER_SECRET" },
];

const targets = {
    app: { file: resolve(repo, "app", ".env.local"), example: resolve(repo, "app", ".env.example") },
    server: { file: resolve(repo, "server", ".env"), example: resolve(repo, "server", ".env.example") },
};

function readEnvFile(file) {
    if (!existsSync(file)) return {};
    const values = {};
    for (const line of readFileSync(file, "utf8").split("\n")) {
        const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
        if (match && match[2].trim() !== "") values[match[1]] = match[2].trim();
    }
    return values;
}

const existing = { app: readEnvFile(targets.app.file), server: readEnvFile(targets.server.file) };

// An existing value wins, whichever side holds it. Only a secret nobody has is generated.
const adopted = [];
const secrets = {};
for (const secret of SHARED) {
    const fromApp = existing.app[secret.app];
    const fromServer = existing.server[secret.server];
    if (fromApp !== undefined && fromServer !== undefined && fromApp !== fromServer) {
        console.error(
            `\n${secret.name} differs between app/.env.local and server/.env. Appends will be ` +
                "refused until they match; fix one by hand.\n",
        );
    }
    secrets[secret.name] = fromApp ?? fromServer ?? randomBytes(16).toString("hex");
    if (fromApp === undefined || fromServer === undefined) {
        if (fromApp !== undefined || fromServer !== undefined) adopted.push(secret.name);
    }
}

/**
 * Written from `.env.example` so the generated file keeps its comments — the explanation of what a
 * key is for belongs next to the key, not only in the example nobody opens twice.
 */
function fromExample(exampleFile, values) {
    return readFileSync(exampleFile, "utf8")
        .split("\n")
        .map((line) => {
            const key = /^([A-Z0-9_]+)=/.exec(line)?.[1];
            return key !== undefined && key in values ? `${key}=${values[key]}` : line;
        })
        .join("\n");
}

const written = [];
for (const [side, target] of Object.entries(targets)) {
    if (existsSync(target.file)) continue;
    const values = Object.fromEntries(
        SHARED.map((secret) => [secret[side], secrets[secret.name]]),
    );
    writeFileSync(target.file, fromExample(target.example, values), { mode: 0o600 });
    written.push(relative(repo, target.file));
}

if (written.length > 0) {
    console.log(`\nWrote ${written.join(" and ")}.`);
    console.log(
        adopted.length > 0
            ? `Kept ${adopted.join(" and ")} from the file that already existed, so both halves agree.\n`
            : "Generated a fresh pair of demo secrets; both halves agree.\n",
    );
}
