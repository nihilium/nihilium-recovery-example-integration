/**
 * Fails `npm install` early, with an instruction instead of a resolver error.
 *
 * The SDK's packages are not on npm yet — the services, the probes, the settlement adapters, the
 * orchestration package and the on-chain bindings, which live in a git submodule. They are consumed
 * through `file:../recovery-sdk/...` links, so a missing sibling checkout (or an uninitialised
 * submodule) fails deep inside npm's resolver with a path nobody can act on.
 *
 * Delete this file the day those packages publish; it exists only to describe a temporary shape.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const sdk = resolve(repo, "..", "recovery-sdk");

const problems = [];
if (!existsSync(sdk)) {
    problems.push([
        `No recovery-sdk checkout at ${sdk}`,
        "    git clone git@github.com:nihilium/recovery-sdk.git ../recovery-sdk",
    ]);
} else {
    // The submodule carries the deployed module's ABI and address book.
    if (!existsSync(join(sdk, "onchain", "evm", "package.json"))) {
        problems.push([
            "The onchain/ submodule is not initialised",
            "    git -C ../recovery-sdk submodule update --init --recursive",
        ]);
    }
    // `file:` deps are consumed as built output: these packages ship dist/, they do not build here.
    for (const pkg of [
        "packages/service",
        "packages/watchtower",
        "packages/relayer",
        "packages/sdk",
        "packages/adapters/watchtower-evm",
        "packages/adapters/watchtower-nihilium",
        "packages/adapters/settlement-evm",
        "packages/adapters/settlement-solana",
        "packages/adapters/storage-indexeddb",
        "packages/adapters/passport-zkpassport",
        "onchain/evm",
        "onchain/solana",
    ]) {
        if (existsSync(join(sdk, pkg)) && !existsSync(join(sdk, pkg, "dist", "index.js"))) {
            problems.push([
                `${pkg} has no dist/`,
                "    npm --prefix ../recovery-sdk install && npm --prefix ../recovery-sdk run build",
            ]);
            break;
        }
    }
}

if (problems.length > 0) {
    console.error("\nThis demo links the unpublished SDK packages and the on-chain bindings from a");
    console.error("sibling checkout. See CLAUDE.md -> Conventions -> Dependencies.\n");
    for (const [what, how] of problems) console.error(`  ${what}\n${how}\n`);
    process.exit(1);
}
