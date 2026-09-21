/**
 * Kernel's ERC-7579 install envelopes, which are not the same envelope twice.
 *
 * Kernel does not forward `installModule`'s `initData` to the module untouched. It reads:
 *
 *     hook (20 bytes, packed) ++ abi.encode(bytes installData, bytes hookData)
 *
 * and only `installData` reaches the module's `onInstall`. Handing a module its own init data
 * directly makes Kernel take the first 20 bytes as a hook address and misparse the rest, which
 * reverts during simulation with empty data — the famously unhelpful `reason: 0x`. Other ERC-7579
 * accounts (Nexus, Safe7579) take init data as-is, so this wrapping is Kernel's alone.
 *
 * **The executor and the validator take different envelopes**, and that is the part worth reading
 * twice. A validator's has a third element: a 4-byte selector trailer. Kernel gates every *non-root*
 * validator on `allowedSelectors[vId][selector]`, and the only other way to set that bit is an
 * "enable mode" UserOp co-signed by the account's current root validator — which is exactly the key
 * a recovery assumes is gone. Install the recovered owner's validator without the trailer and it is
 * permanently unusable: the recovery succeeds on-chain and the account stays unreachable.
 *
 * **To replace:** nothing, for a Kernel account. For Nexus or Safe7579, drop the wrapping and pass
 * the module's init data straight through.
 * **Assumes:** Kernel v3.x's `installModule`, which calls `_setSelector` only when a 4-byte
 * `selectorData` trailer is present. `evm.ts` builds version `0.3.3`; a golden-vector test pins the
 * bytes so a Kernel upgrade fails the suite rather than a transaction.
 */
import {
    encodeAbiParameters,
    encodeFunctionData,
    encodePacked,
    zeroAddress,
    type Address,
    type Hex,
} from "viem";
import { ModuleType } from "@nihilium/recovery-onchain-evm";
import { gradualVetoConfigAbi, type SolidityVetoConfig } from "./vetoConfig.js";

/**
 * Rhinestone's OwnableValidator on Sepolia.
 *
 * A recovery has to install a validator the account is **not already using**: ERC-7579 validators
 * reject a second `onInstall` for the same account, and Kernel's own ECDSA validator is typically
 * already the root. OwnableValidator at threshold 1 takes a plain 65-byte ECDSA signature — the same
 * shape Kernel's root validator uses — so `permissionless` signs for it with no custom code.
 */
export const OWNABLE_VALIDATOR_ADDRESS: Address = "0x2483DA3A338895199E5e538530213157e931Bf06";

/** Kernel's own `execute(bytes32,bytes)`. See the header for why this trailer is load-bearing. */
const KERNEL_EXECUTE_SELECTOR: Hex = "0xe9ae5c53";

/** The generic ERC-7579 account surface. Not the module's ABI — this one is the account's. */
export const erc7579AccountAbi = [
    {
        type: "function",
        name: "installModule",
        inputs: [
            { name: "moduleTypeId", type: "uint256" },
            { name: "module", type: "address" },
            { name: "initData", type: "bytes" },
        ],
        outputs: [],
        stateMutability: "nonpayable",
    },
    {
        type: "function",
        name: "uninstallModule",
        inputs: [
            { name: "moduleTypeId", type: "uint256" },
            { name: "module", type: "address" },
            { name: "deInitData", type: "bytes" },
        ],
        outputs: [],
        stateMutability: "nonpayable",
    },
] as const;

/** Two elements: what an executor install takes. `zeroAddress` is "no hook". */
export function wrapExecutorInitDataForKernel(moduleInitData: Hex): Hex {
    return encodePacked(
        ["address", "bytes"],
        [
            zeroAddress,
            encodeAbiParameters([{ type: "bytes" }, { type: "bytes" }], [moduleInitData, "0x"]),
        ],
    );
}

/** Three elements: the validator envelope, whose trailer grants the selector. */
export function wrapValidatorInitDataForKernel(moduleInitData: Hex): Hex {
    return encodePacked(
        ["address", "bytes"],
        [
            zeroAddress,
            encodeAbiParameters(
                [{ type: "bytes" }, { type: "bytes" }, { type: "bytes" }],
                [moduleInitData, "0x", KERNEL_EXECUTE_SELECTOR],
            ),
        ],
    );
}

/** `abi.encode(address recoveryOwner, GradualVeto.Config veto)` — what `onInstall` decodes. */
export function recoveryModuleInitData(
    recoveryOwner: Address,
    veto: SolidityVetoConfig,
): Hex {
    return encodeAbiParameters(
        [{ type: "address" }, gradualVetoConfigAbi],
        [recoveryOwner, { ...veto, resumeMembers: [...veto.resumeMembers] }],
    );
}

/** What the account calls on itself to install the recovery executor. */
export function installModuleCalldata(
    moduleAddress: Address,
    recoveryOwner: Address,
    veto: SolidityVetoConfig,
): Hex {
    return encodeFunctionData({
        abi: erc7579AccountAbi,
        functionName: "installModule",
        args: [
            BigInt(ModuleType.EXECUTOR),
            moduleAddress,
            wrapExecutorInitDataForKernel(recoveryModuleInitData(recoveryOwner, veto)),
        ],
    });
}

/** Kernel passes `deInitData` through untouched, and `onUninstall` ignores it. */
export function uninstallModuleCalldata(moduleAddress: Address): Hex {
    return encodeFunctionData({
        abi: erc7579AccountAbi,
        functionName: "uninstallModule",
        args: [BigInt(ModuleType.EXECUTOR), moduleAddress, "0x"],
    });
}

/**
 * The validator configuration a recovery installs, as the `Intent`'s `newValidatorInitData`.
 *
 * Threshold 1 with the recovered owner as sole owner: the recovery hands control to one key, and
 * dressing that up as a quorum would be describing a property the construction does not have.
 */
export function recoveryValidatorInitData(newOwner: Address): Hex {
    const ownableInit = encodeAbiParameters(
        [{ type: "uint256" }, { type: "address[]" }],
        [1n, [newOwner]],
    );
    return wrapValidatorInitDataForKernel(ownableInit);
}
