/**
 * The ERC-7579 install encodings, pinned.
 *
 * These are the highest-consequence bytes in the repo and the least likely to fail loudly. ABI
 * encoding is positional, so swapping two fields of the veto config compiles, encodes, sends, and
 * installs a different-but-valid configuration.
 *
 * So the test works three ways, and each catches something the others do not:
 *
 * 1. **A decode that spells the tuple out again, here.** Reordering the fields in `vetoConfig.ts`
 *    then fails with the wrong *value* in a named field, which says what broke.
 * 2. **Frozen hashes of the whole calldata.** Catches anything outside the decoded region — the
 *    selector, the uninstall wrapper, a stray envelope.
 * 3. **Structural assertions.** The install data must reach `onInstall` untouched and the uninstall
 *    data must not, because that asymmetry is the part a reader is most likely to "fix". A previous
 *    version of this repo targeted Kernel, which wants the opposite of both.
 */
import { describe, expect, it } from "vitest";
import { decodeAbiParameters, keccak256, toFunctionSelector, type Address, type Hex } from "viem";
import { ModuleType } from "@nihilium/recovery-onchain-evm";
import {
    executorPrev,
    installModuleCalldata,
    recoveryModuleInitData,
    recoveryValidatorInitData,
    uninstallModuleCalldata,
    OWNABLE_VALIDATOR_ADDRESS,
    SENTINEL,
} from "../../src/integration/recovery/settlement/evm/erc7579.js";
import { validatorNonceKey } from "../../src/integration/recovery/settlement/evm/recoveredOwner.js";
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
    install: "0x11b8aba55bf1bd1a2b4663b2d9b1127114a49c8324a07c39df4a4b4f3e5f3710",
    validatorInit: "0xd5caefd3b660a9127f6dd88f1dce81b97bad2aea0b312908e362c3b9a0b6df1e",
} as const;

/** The envelope this repo used to send. Must not reappear. */
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

describe("the install envelope", () => {
    it("hands the module its own init data, byte for byte", () => {
        const data = installModuleCalldata(MODULE, RECOVERY_OWNER, VETO);
        const [, , initData] = decodeAbiParameters(
            [{ type: "uint256" }, { type: "address" }, { type: "bytes" }],
            `0x${data.slice(10)}` as Hex,
        );
        // Safe7579 returns these bytes to `onInstall` untouched. Wrapping them — a packed hook
        // address, an abi.encode pair — makes the module abi.decode a hook as its recovery owner.
        expect(initData).toBe(recoveryModuleInitData(RECOVERY_OWNER, VETO));
    });

    it("carries no Kernel selector trailer, on either module type", () => {
        // Kernel gates non-root validators on `allowedSelectors` and needs this; Safe7579 does not,
        // and would pass the extra bytes straight to `onInstall`.
        expect(installModuleCalldata(MODULE, RECOVERY_OWNER, VETO)).not.toContain(
            KERNEL_EXECUTE_SELECTOR,
        );
        expect(recoveryValidatorInitData(RECOVERY_OWNER)).not.toContain(KERNEL_EXECUTE_SELECTOR);
    });

    it("installs OwnableValidator with the recovered owner alone, at threshold 1", () => {
        const [threshold, owners] = decodeAbiParameters(
            [{ type: "uint256" }, { type: "address[]" }],
            recoveryValidatorInitData(RECOVERY_OWNER),
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

    it("wraps deInitData with the list predecessor", () => {
        const data = uninstallModuleCalldata(MODULE, SENTINEL);
        expect(data.slice(0, 10)).toBe(
            toFunctionSelector("uninstallModule(uint256,address,bytes)"),
        );
        const [typeId, module, deInit] = decodeAbiParameters(
            [{ type: "uint256" }, { type: "address" }, { type: "bytes" }],
            `0x${data.slice(10)}` as Hex,
        );
        expect(typeId).toBe(BigInt(ModuleType.EXECUTOR));
        expect(module).toBe(MODULE);

        // The one place Safe7579 does *not* pass bytes through. `0x` here — which is what Kernel
        // wants — reverts the sentinel-list pop, and rotation is one UserOp, so it takes the
        // install down with it after the gas is spent.
        const [prev, moduleDeInit] = decodeAbiParameters(
            [{ type: "address" }, { type: "bytes" }],
            deInit,
        );
        expect(prev).toBe(SENTINEL);
        expect(moduleDeInit).toBe("0x");
    });

    it("matches the frozen encoding", () => {
        expect(keccak256(installModuleCalldata(MODULE, RECOVERY_OWNER, VETO))).toBe(FROZEN.install);
    });

    it("targets Rhinestone's OwnableValidator on Sepolia", () => {
        // A recovery must install a validator the account is not already using. A fresh Safe runs
        // none at all — it validates against its owners — so this one is always free.
        expect(OWNABLE_VALIDATOR_ADDRESS).toBe("0x2483DA3A338895199E5e538530213157e931Bf06");
    });
});

describe("executorPrev", () => {
    /** A stand-in for the account, answering `getExecutorsPaginated` from a fixed list. */
    function reader(pages: { entries: Address[]; next: Address }[]) {
        let call = 0;
        return {
            readContract: async () => {
                const page = pages[call] ?? { entries: [], next: SENTINEL };
                call += 1;
                return [page.entries, page.next];
            },
        } as never;
    }

    const OTHER = "0x7777777777777777777777777777777777777777" as Address;

    it("returns the sentinel when the module is installed first", async () => {
        const prev = await executorPrev(reader([{ entries: [MODULE], next: SENTINEL }]), MODULE, MODULE);
        expect(prev).toBe(SENTINEL);
    });

    it("returns the preceding entry", async () => {
        const prev = await executorPrev(
            reader([{ entries: [OTHER, MODULE], next: SENTINEL }]),
            MODULE,
            MODULE,
        );
        expect(prev).toBe(OTHER);
    });

    it("carries the predecessor across a page boundary", async () => {
        const prev = await executorPrev(
            reader([
                { entries: [OTHER], next: OTHER },
                { entries: [MODULE], next: SENTINEL },
            ]),
            MODULE,
            MODULE,
        );
        expect(prev).toBe(OTHER);
    });

    it("throws rather than guessing when the module is absent", async () => {
        // The failure this prevents: defaulting to SENTINEL sends a UserOp that reverts inside the
        // account, which costs the gas to learn what one eth_call already knew.
        await expect(
            executorPrev(reader([{ entries: [OTHER], next: SENTINEL }]), MODULE, MODULE),
        ).rejects.toThrow(/not in .* executor list/);
    });
});

describe("the validator nonce key", () => {
    it("puts the validator in the top 160 bits of the key", () => {
        // Safe7579 reads `validator := shr(96, nonce)` and `nonce = key << 64`, so the address has
        // to be right-padded into 24 bytes. A wrong key is not an error: the account falls back to
        // checking the *Safe owners'* signature — the key the recovery assumes is lost — and the
        // rejection reads as a signing bug.
        const key = validatorNonceKey(OWNABLE_VALIDATOR_ADDRESS);
        const nonce = key << 64n;
        expect(`0x${(nonce >> 96n).toString(16).padStart(40, "0")}`).toBe(
            OWNABLE_VALIDATOR_ADDRESS.toLowerCase(),
        );
    });
});
