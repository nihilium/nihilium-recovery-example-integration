/**
 * Creates `app/.env.local` and `server/.env` on first install, with matching random secrets.
 *
 * Two of this demo's values have to agree across the two halves — the record host's append
 * credential and the watchtower's registration credential — and they are capabilities, not
 * settings. Shipping them as constants in `.env.example` would mean every clone of this repo shares
 * a write credential for every other clone's record host, which is a strange thing for a repo about
 * custody to do. So they are generated here, once, per machine.
 *
 * **`ROLE_MNEMONIC` is generated too, and for a sharper reason.** It used to default to the published
 * Hardhat phrase. Those addresses are derivable by anyone, so strangers fund them, sweep them, and
 * occasionally repurpose them — the Solana account that phrase derives is now somebody else's
 * durable nonce account, which is what made `create_vault` fail with `Transfer: 'from' must not
 * carry data`. Role keys hold gas and veto authority; they should be this machine's.
 *
 * **The pair is the unit, not the file.** Deleting one of the two files and re-running used to mint
 * fresh secrets for it while the survivor kept the old ones — two files that each look fine and
 * disagree, which surfaces much later as a 403 from the record host. So an existing value always
 * wins: a missing file is rebuilt from whatever its counterpart already holds, and generation only
 * happens for a secret that exists in neither. Existing files are never modified.
 */
import { randomBytes } from "node:crypto";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));

/** One shared secret, under the name each side calls it. */
const SHARED = [
    { name: "RECORD_APPEND_SECRET", app: "VITE_RECORD_APPEND_SECRET", server: "RECORD_APPEND_SECRET" },
    { name: "WATCH_REGISTER_SECRET", app: "VITE_WATCH_REGISTER_SECRET", server: "WATCH_REGISTER_SECRET" },
];

/**
 * Server-only values that must exist and must not be shared between clones.
 *
 * Unlike `SHARED`, these have no counterpart in the app — nothing in a browser may hold a role key.
 */
const SERVER_ONLY = [
    { name: "ROLE_MNEMONIC", generate: () => generateMnemonic(wordlist, 128) },
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
 * Fill a key that is present but empty, in a file that already exists.
 *
 * The rule elsewhere is that existing files are never modified, and it stays: an empty key is not a
 * value, and a clone that predates `ROLE_MNEMONIC` would otherwise start against a phrase the whole
 * internet can derive. A key with anything in it is left exactly alone.
 */
function fillEmpty(file, values) {
    const before = readFileSync(file, "utf8");
    let filled = [];
    const after = before
        .split("\n")
        .map((line) => {
            const match = /^([A-Z0-9_]+)=\s*$/.exec(line.trim());
            const key = match?.[1];
            if (key === undefined || !(key in values)) return line;
            filled.push(key);
            return `${key}=${values[key]}`;
        })
        .join("\n");
    if (filled.length > 0) writeFileSync(file, after, { mode: 0o600 });
    return filled;
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

// Server-only values: adopted from the file when it holds one, minted when it does not.
const serverValues = {};
for (const entry of SERVER_ONLY) {
    serverValues[entry.name] = existing.server[entry.name] ?? entry.generate();
}

const written = [];
for (const [side, target] of Object.entries(targets)) {
    if (existsSync(target.file)) continue;
    const values = Object.fromEntries(
        SHARED.map((secret) => [secret[side], secrets[secret.name]]),
    );
    if (side === "server") Object.assign(values, serverValues);
    writeFileSync(target.file, fromExample(target.example, values), { mode: 0o600 });
    written.push(relative(repo, target.file));
}

// An existing server file may predate these keys, or hold them empty.
const filled = existsSync(targets.server.file) && !written.includes(relative(repo, targets.server.file))
    ? fillEmpty(targets.server.file, serverValues)
    : [];
if (filled.length > 0) {
    console.log(
        `\nFilled ${filled.join(" and ")} in ${relative(repo, targets.server.file)} — it was ` +
            "empty, which meant falling back to a phrase anyone can derive.\n",
    );
}

if (written.length > 0) {
    console.log(`\nWrote ${written.join(" and ")}.`);
    console.log(
        adopted.length > 0
            ? `Kept ${adopted.join(" and ")} from the file that already existed, so both halves agree.\n`
            : "Generated a fresh pair of demo secrets; both halves agree.\n",
    );
}
