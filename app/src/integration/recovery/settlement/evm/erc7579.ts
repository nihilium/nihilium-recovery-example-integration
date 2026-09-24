/**
 * The ERC-7579 install calls, and the one asymmetry Safe7579 puts in them.
 *
 * `installModule`'s `initData` reaches the module's `onInstall` **untouched** — Safe7579's
 * `_installValidator` and `_installExecutor` both literally return the bytes they were handed. So
 * this file is the plain standard surface, which is the version worth copying.
 *
 * **`uninstallModule` is the exception, and it is the expensive one.** Safe7579 keeps its modules in
 * a sentinel-linked list and decodes `deInitData` as:
 *
 *     abi.encode(address prev, bytes moduleDeInitData)
 *
 * where `prev` is the entry *pointing at* the module being removed. Pass `0x` — which is what a
 * Kernel account wants — and the list pop reverts. Rotation is uninstall-then-install in a single
 * UserOp, so that revert arrives after the gas is spent and leaves the account exactly as it was,
 * with a linked-list error that names nothing in this repo.
 *
 * That asymmetry is per account implementation and it inverts between them: **Kernel wraps install
 * data and passes de-init data through; Safe7579 does the opposite.** Kernel's envelope is
 * `hook ++ abi.encode(installData, hookData)`, with a fourth 4-byte selector element for validators
 * to satisfy `allowedSelectors`. None of that applies here, and re-adding it would make the module
 * misparse its own init data. Check the account before trusting either shape.
 *
 * **To replace:** nothing, for any account that follows the standard. For Kernel, re-add the
 * wrapping; for an account with no sentinel list, `prev` is ignored and `executorPrev` can go.
 * **Assumes:** Safe7579 v1.0.0's `getExecutorsPaginated`, reachable on the Safe's own address
 * because the call lands on the adapter installed as its fallback handler. A golden-vector test
 * pins the bytes so an account change fails the suite rather than a transaction.
 */
import {
    encodeAbiParameters,
    encodeFunctionData,
    getAddress,
    type Address,
    type Hex,
    type PublicClient,
} from "viem";
import { ModuleType } from "@nihilium/recovery-onchain-evm";
import { gradualVetoConfigAbi, type SolidityVetoConfig } from "./vetoConfig.js";

/**
 * Rhinestone's OwnableValidator on Sepolia.
 *
 * A recovery has to install a validator the account is **not already using**: ERC-7579 validators
 * reject a second `onInstall` for the same account. A fresh Safe here runs no validator at all — it
 * validates UserOps against its owners — so this one is free, and at threshold 1 it takes a plain
 * 65-byte ECDSA signature, which is what a recovered key can produce with no custom code.
 */
export const OWNABLE_VALIDATOR_ADDRESS: Address = "0x2483DA3A338895199E5e538530213157e931Bf06";

/** The head of a sentinel-linked list. `prev` for whatever was installed first. */
export const SENTINEL: Address = "0x0000000000000000000000000000000000000001";

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
    {
        type: "function",
        name: "getExecutorsPaginated",
        inputs: [
            { name: "cursor", type: "address" },
            { name: "pageSize", type: "uint256" },
        ],
        outputs: [
            { name: "array", type: "address[]" },
            { name: "next", type: "address" },
        ],
        stateMutability: "view",
    },
] as const;

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
            // Straight through. See the header for what happens if this is wrapped.
            recoveryModuleInitData(recoveryOwner, veto),
        ],
    });
}

/**
 * `prev` is required and must be read, not guessed.
 *
 * `moduleDeInitData` is empty because `onUninstall` ignores it; the wrapper exists for the list pop
 * alone.
 */
export function uninstallModuleCalldata(moduleAddress: Address, prev: Address): Hex {
    return encodeFunctionData({
        abi: erc7579AccountAbi,
        functionName: "uninstallModule",
        args: [
            BigInt(ModuleType.EXECUTOR),
            moduleAddress,
            encodeAbiParameters([{ type: "address" }, { type: "bytes" }], [prev, "0x"]),
        ],
    });
}

/** How many entries to pull per page. A demo account has one executor; this is room to be wrong. */
const PAGE_SIZE = 32n;

/**
 * The entry pointing at `module` in the account's executor list.
 *
 * Throws rather than falling back to `SENTINEL` when the module is absent. A default here would be
 * indistinguishable from "it is installed first" and would send a UserOp that reverts inside the
 * account — spending the gas to learn what one `eth_call` already knew.
 */
export async function executorPrev(
    client: PublicClient,
    account: Address,
    module: Address,
): Promise<Address> {
    const target = getAddress(module);
    let cursor: Address = SENTINEL;
    let prev: Address = SENTINEL;

    // Bounded rather than `while (true)`: a malformed list would otherwise spin forever against a
    // node that is answering perfectly well.
    for (let page = 0; page < 8; page += 1) {
        const [entries, next] = await client.readContract({
            address: account,
            abi: erc7579AccountAbi,
            functionName: "getExecutorsPaginated",
            args: [cursor, PAGE_SIZE],
        });

        for (const entry of entries) {
            if (getAddress(entry) === target) return prev;
            prev = getAddress(entry);
        }

        if (entries.length === 0 || next === SENTINEL || next === cursor) break;
        cursor = next;
    }

    throw new Error(
        `Module ${module} is not in ${account}'s executor list. Install it instead of replacing it.`,
    );
}

/**
 * The validator configuration a recovery installs, as the `Intent`'s `newValidatorInitData`.
 *
 * Threshold 1 with the recovered owner as sole owner: the recovery hands control to one key, and
 * dressing that up as a quorum would be describing a property the construction does not have.
 */
export function recoveryValidatorInitData(newOwner: Address): Hex {
    return encodeAbiParameters([{ type: "uint256" }, { type: "address[]" }], [1n, [newOwner]]);
}
