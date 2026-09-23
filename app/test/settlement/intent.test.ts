/**
 * The intent, which is the only thing a recovered key is ever asked to sign.
 *
 * Two properties are worth pinning. The first is the blast radius: an intent installs a validator
 * and nothing else, so no arrangement of these fields moves funds. The second is that the digest is
 * *read* from the module rather than computed — the deployed contract and the Solidity in the
 * sibling checkout report different `version()` strings, and that string is inside the EIP-712
 * domain separator, so a locally derived hash would sign a message the contract never saw.
 */
import { describe, expect, it, vi } from "vitest";
import { decodeAbiParameters, type Address, type Hex } from "viem";
import {
    buildIntent,
    intentDigest,
    DEFAULT_INTENT_TTL_SECONDS,
} from "../../src/integration/recovery/settlement/evm/intent.js";
import { OWNABLE_VALIDATOR_ADDRESS } from "../../src/integration/recovery/settlement/evm/erc7579.js";
import type { ModuleReader } from "../../src/integration/recovery/settlement/evm/reads.js";
import { MODULE, RECOVERY_OWNER } from "./vectors.js";

const ACCOUNT = "0x7777777777777777777777777777777777777777" as Address;
const FIXED_NOW = 1_800_000_000_000;

function build(overrides: Partial<Parameters<typeof buildIntent>[0]> = {}) {
    return buildIntent({
        account: ACCOUNT,
        newOwner: RECOVERY_OWNER,
        epoch: 3n,
        nonce: 7n,
        moduleAddress: MODULE,
        now: () => FIXED_NOW,
        ...overrides,
    });
}

describe("buildIntent", () => {
    it("carries the replay-protection fields the module checks", () => {
        const { solidity, intent } = build();
        expect(solidity.account).toBe(ACCOUNT);
        expect(solidity.epoch).toBe(3n);
        expect(solidity.nonce).toBe(7n);
        expect(intent.epoch).toBe(3);
        expect(intent.nonce).toBe(7n);
        expect(intent.module).toBe(MODULE);
    });

    it("installs OwnableValidator with the recovered owner, and authorises nothing else", () => {
        const { solidity } = build();
        expect(solidity.newValidator).toBe(OWNABLE_VALIDATOR_ADDRESS);

        // The whole payload, decoded: a validator config and no call, no target, no value. The
        // module's executeRecovery installs this and bumps the epoch — that is the entire reach of
        // a recovery signature. No envelope to peel: Safe7579 hands these bytes to `onInstall` as
        // they are.
        const [threshold, owners] = decodeAbiParameters(
            [{ type: "uint256" }, { type: "address[]" }],
            solidity.newValidatorInitData,
        );
        expect(threshold).toBe(1n);
        expect(owners).toEqual([RECOVERY_OWNER]);
    });

    it("expires a TTL after now, in seconds", () => {
        const { solidity } = build();
        expect(solidity.expiry).toBe(FIXED_NOW / 1000 + DEFAULT_INTENT_TTL_SECONDS);
    });

    it("keeps both shapes agreeing about the validator config", () => {
        const { intent, solidity } = build();
        const asHex = `0x${Array.from(intent.newOwnerConfig, (b) => b.toString(16).padStart(2, "0")).join("")}`;
        expect(asHex).toBe(solidity.newValidatorInitData);
    });

    it("refuses an expiry that would not fit uint48", () => {
        // Silently truncating makes a signature the module reads as long expired, which surfaces as
        // an unhelpful revert after the ceremony rather than here.
        expect(() => build({ ttlSeconds: 2 ** 48 })).toThrow(/uint48/);
    });

    it("refuses a non-positive TTL", () => {
        expect(() => build({ ttlSeconds: 0 })).toThrow(/future/);
    });
});

describe("the digest", () => {
    it("comes from the deployed module, not from local encoding", async () => {
        const hashIntent = vi.fn(async () => `0x${"ab".repeat(32)}` as Hex);
        const reader = { hashIntent } as unknown as ModuleReader;
        const { solidity } = build();

        expect(await intentDigest(reader, solidity)).toBe(`0x${"ab".repeat(32)}`);
        // The deployment answers version "2.0.0" and the checked-out Solidity answers "3.0.0"; the
        // version is inside the EIP-712 domain separator, so only the chain can say what to sign.
        expect(hashIntent).toHaveBeenCalledWith(solidity);
    });
});
