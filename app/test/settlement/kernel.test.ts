/**
 * The Kernel install envelopes, pinned.
 *
 * These encodings are the highest-consequence bytes in the repo and the least likely to fail loudly.
 * ABI encoding is positional, so swapping two fields of the veto config compiles, encodes, sends,
 * and installs a different-but-valid configuration. Kernel's envelope is worse: get it wrong and the
 * transaction reverts with empty data, which reads as a node problem rather than a bug here.
 *
 * So the test works three ways, and each catches something the others do not:
 *
 * 1. **A decode that spells the tuple out again, here.** Reordering the fields in `vetoConfig.ts`
 *    then fails with the wrong *value* in a named field, which says what broke.
 * 2. **Frozen hashes of the whole calldata.** Catches anything outside the decoded region — the
 *    envelope, the selector, the hook slot.
 * 3. **Structural assertions.** The selector trailer must be in the validator envelope and must not
 *    be in the executor's, because that asymmetry is the part a reader is most likely to "fix".
 */
import { describe, expect, it } from "vitest";
import { decodeAbiParameters, keccak256, toFunctionSelector, type Hex } from "viem";
import { ModuleType } from "@nihilium/recovery-onchain-evm";
import {
    installModuleCalldata,
    recoveryModuleInitData,
    recoveryValidatorInitData,
    uninstallModuleCalldata,
    wrapExecutorInitDataForKernel,
    OWNABLE_VALIDATOR_ADDRESS,
} from "../../src/integration/recovery/settlement/evm/kernel.js";
import { MODULE, RECOVERY_OWNER, RESUME, PAUSE, ABORT, VETO } from "./vectors.js";

/**
 * Written out again rather than imported from the source, on purpose. Importing the same constant
 * the encoder uses would make a reorder invisible: both sides would move together.
 */
const VETO_TUPLE = {
    type: "tuple",
    components: [
        { name: "pauseAuthority", type: "address" },
        { name: "abortAuthority", type: "address" },
        { name: "resumeMembers", type: "address[]" },
        { name: "resumeThreshold", type: "uint8" },
        { name: "timelockSeconds", type: "uint64" },
        { name: "pauseCeilingSeconds", type: "uint64" },
    ],
} as const;

/** Frozen. A change to any of these is a change to what gets sent to Sepolia. */
const FROZEN = {
    moduleInit: "0x88627a048863e66dbad7d04eeffe3d67cd15707f8e915db82d69bdfde470b851",
    install: "0x313c8d61733a51262b1cfda1eddee1c10e12f296f0a86bc6216b1ffcdb952145",
    validatorInit: "0x5533c0dfd253eff6f3ca9053ade6d3c06fb36e9e8ca701aa2f57ec2bfe79cda0",
} as const;

const KERNEL_EXECUTE_SELECTOR = "e9ae5c53";

describe("the recovery module's init data", () => {
    it("encodes the owner and every veto field, in the contract's order", () => {
        const [owner, veto] = decodeAbiParameters(
            [{ type: "address" }, VETO_TUPLE],
            recoveryModuleInitData(RECOVERY_OWNER, VETO),
        );

        expect(owner).toBe(RECOVERY_OWNER);
        expect(veto.pauseAuthority).toBe(PAUSE);
        expect(veto.abortAuthority).toBe(ABORT);
        expect(veto.resumeMembers).toEqual([...RESUME]);
        expect(veto.resumeThreshold).toBe(2);
        // Seconds, not blocks. The v1 -> v2 clock change kept this a uint64 and kept encoding fine
        // while its meaning changed, which is exactly the drift a type checker cannot see.
        expect(veto.timelockSeconds).toBe(120n);
        expect(veto.pauseCeilingSeconds).toBe(3600n);
    });

    it("matches the frozen encoding", () => {
        expect(keccak256(recoveryModuleInitData(RECOVERY_OWNER, VETO))).toBe(FROZEN.moduleInit);
    });
});

describe("Kernel's envelopes", () => {
    it("puts a zero hook in the first 20 bytes of an executor install", () => {
        const wrapped = wrapExecutorInitDataForKernel(recoveryModuleInitData(RECOVERY_OWNER, VETO));
        // Without this, Kernel reads the module's own first 20 bytes as a hook address and reverts
        // during simulation with empty data.
        expect(wrapped.slice(0, 42)).toBe(`0x${"00".repeat(20)}`);
    });

    it("grants the execute selector to the validator, and only to the validator", () => {
        const validator = recoveryValidatorInitData(RECOVERY_OWNER);
        const executor = wrapExecutorInitDataForKernel(recoveryModuleInitData(RECOVERY_OWNER, VETO));

        // Without the trailer a non-root validator is permanently unusable: the only other way to
        // set `allowedSelectors` is a UserOp co-signed by the root validator, which is the key a
        // recovery assumes is gone.
        expect(validator).toContain(KERNEL_EXECUTE_SELECTOR);
        // And it does not belong on the executor — a different envelope, not an oversight.
        expect(executor).not.toContain(KERNEL_EXECUTE_SELECTOR);
    });

    it("installs OwnableValidator with the recovered owner alone, at threshold 1", () => {
        const [ownableInit] = decodeAbiParameters(
            [{ type: "bytes" }, { type: "bytes" }, { type: "bytes" }],
            // Skip the 20-byte packed hook to reach the abi-encoded body.
            `0x${recoveryValidatorInitData(RECOVERY_OWNER).slice(42)}` as Hex,
        );
        const [threshold, owners] = decodeAbiParameters(
            [{ type: "uint256" }, { type: "address[]" }],
            ownableInit,
        );
        expect(threshold).toBe(1n);
        expect(owners).toEqual([RECOVERY_OWNER]);
    });

    it("matches the frozen encoding", () => {
        expect(keccak256(recoveryValidatorInitData(RECOVERY_OWNER))).toBe(FROZEN.validatorInit);
    });
});

describe("the account calls", () => {
    it("installs the module as an executor", () => {
        const data = installModuleCalldata(MODULE, RECOVERY_OWNER, VETO);
        expect(data.slice(0, 10)).toBe(
            toFunctionSelector("installModule(uint256,address,bytes)"),
        );

        const [typeId, module] = decodeAbiParameters(
            [{ type: "uint256" }, { type: "address" }, { type: "bytes" }],
            `0x${data.slice(10)}` as Hex,
        );
        // An executor, never a validator: the module executes the rotation, it does not validate
        // UserOps. `isModuleType` on the contract agrees, and would revert otherwise.
        expect(typeId).toBe(BigInt(ModuleType.EXECUTOR));
        expect(module).toBe(MODULE);
    });

    it("uninstalls with empty deInitData", () => {
        const data = uninstallModuleCalldata(MODULE);
        expect(data.slice(0, 10)).toBe(
            toFunctionSelector("uninstallModule(uint256,address,bytes)"),
        );
        const [typeId, module, deInit] = decodeAbiParameters(
            [{ type: "uint256" }, { type: "address" }, { type: "bytes" }],
            `0x${data.slice(10)}` as Hex,
        );
        expect(typeId).toBe(BigInt(ModuleType.EXECUTOR));
        expect(module).toBe(MODULE);
        // Kernel passes this through untouched and `onUninstall` ignores it.
        expect(deInit).toBe("0x");
    });

    it("matches the frozen encoding", () => {
        expect(keccak256(installModuleCalldata(MODULE, RECOVERY_OWNER, VETO))).toBe(FROZEN.install);
    });

    it("targets Rhinestone's OwnableValidator on Sepolia", () => {
        // A recovery must install a validator the account is not already using; Kernel's own ECDSA
        // validator is typically the root and rejects a second onInstall.
        expect(OWNABLE_VALIDATOR_ADDRESS).toBe("0x2483DA3A338895199E5e538530213157e931Bf06");
    });
});
