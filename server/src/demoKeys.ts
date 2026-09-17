/**
 * Where the demo's role keys come from when `.env` does not supply them.
 *
 * Every role below is supposed to be a *different party*. In production they are: the pause key
 * belongs to whoever investigates, the abort key sits offline, the resume quorum is several people,
 * and the relayer is a service. This demo has none of those, so it derives all of them from the
 * same public test mnemonic at distinct paths — which keeps the addresses stable across restarts
 * (fund them once) and keeps the repo clone-and-run.
 *
 * **What that costs, stated rather than hidden:** keys derived from one published seed share a
 * failure domain completely. Separation here is structural — separate keys, separate routes,
 * separate signers — and demonstrates the *shape* of the design, not its security. The boot banner
 * says so every time the server starts, and `.env` overrides every one of them.
 *
 * This file is demo-shaped, so it lives outside `roles/`: a role receives its key as a parameter
 * and never learns where it came from (CLAUDE.md -> The copy line).
 */
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { bytesToHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

/** The Hardhat/Anvil default, matching `app/src/demo/mnemonic.ts`. */
const DEMO_MNEMONIC = "test test test test test test test test test test test junk";

/**
 * Deliberately off the wallet's own path (`m/44'/60'/0'/0/*`), so a role key can never collide with
 * an account the demo wallet is showing. `1'` is this repo's private coin-type for "not a wallet".
 */
const ROLE_PATH = (index: number) => `m/44'/60'/1'/0/${index}`;

export type RoleName = "relayer" | "pause" | "abort" | `resume-${number}`;

export interface RoleKey {
    name: RoleName;
    privateKey: Hex;
    /** True when the key came from `.env` rather than the published demo seed. */
    supplied: boolean;
}

function derive(index: number): Hex {
    const master = HDKey.fromMasterSeed(mnemonicToSeedSync(DEMO_MNEMONIC));
    const child = master.derive(ROLE_PATH(index));
    if (child.privateKey === null) throw new Error(`No private key at ${ROLE_PATH(index)}`);
    return bytesToHex(child.privateKey);
}

/** `supplied` wins; the derived key is the fallback, never a default that hides a missing one. */
export function roleKey(name: RoleName, supplied: string | undefined, index: number): RoleKey {
    if (supplied !== undefined && supplied !== "") {
        if (!/^0x[0-9a-fA-F]{64}$/.test(supplied)) {
            throw new Error(`${name}: not a 32-byte hex private key (got ${supplied.length} chars)`);
        }
        return { name, privateKey: supplied as Hex, supplied: true };
    }
    return { name, privateKey: derive(index), supplied: false };
}

export function addressOf(key: RoleKey): Hex {
    return privateKeyToAccount(key.privateKey).address;
}
