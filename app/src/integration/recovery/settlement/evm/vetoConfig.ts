/**
 * The one place the veto configuration crosses between TypeScript and Solidity.
 *
 * The SDK's `VetoConfig` is nested — `resumeQuorum: { members, threshold }` — and
 * `GradualVeto.Config` is flat, with `resumeMembers` and `resumeThreshold` as sibling fields. ABI
 * encoding is **positional**, so a drift in field order or type here does not fail to compile and
 * does not throw: it produces calldata the module decodes into a different, valid-looking config.
 * That is why there is exactly one mapper and a golden-vector test pinning it, and why the tuple
 * below is written out rather than derived from anything.
 *
 * The same class of bug already bit this module once: the v1 to v2 change moved the clock from block
 * heights to wall-clock seconds while `timelockSeconds` stayed a `uint64` and kept encoding fine.
 * A units change is invisible to a type checker.
 *
 * **What this demo's config assumes, and a copier must decide for themselves:**
 * - `pauseAuthority` and the whole `resumeQuorum` are the **provider's** keys, held by this repo's
 *   server. Three server keys are plural in key material only; the SDK describes the resume quorum
 *   as "slow, plural, independent guardians" and one operator holding all of it is weaker than the
 *   shape suggests. `validateVetoConfig` cannot see this, because the keys genuinely differ.
 * - `abortAuthority` is the wallet's **own active EOA**, which the SDK calls the natural default:
 *   the common case for abort is not a rogue Nihilium at all, it is someone opening a recovery
 *   while the owner still has access, and the obvious party to stop that is whoever holds the key.
 *   Being seed-derived is explicitly fine — provenance is not what makes a key a backstop, sitting
 *   outside Nihilium's control is. The one hard rule is that it must **not be seal-gated**, which
 *   `validateVetoConfig` checks and this config declares against.
 *
 * A separate offline key would be *stronger*, because it survives losing the owner key and so still
 * answers a rogue Nihilium during a genuine recovery. That is a tradeoff for a holder to make, not
 * a constraint to impose — so this file neither requires one nor validates against one.
 *
 * **To replace:** `demoVetoConfig`, all of it. The tuple and the mapper are protocol; the key
 * assignment is a product decision and this one is a demo's.
 * **Assumes:** `GradualVeto.Config` in `../recovery-sdk/onchain/evm/src/GradualVeto.sol` still has
 * these six fields in this order. Any change there must be mirrored here by hand.
 */
import { validateVetoConfig } from "@nihilium/recovery-veto";
import type { Authority, VetoConfig } from "@nihilium/recovery-core";

/** Mirrors `GradualVeto.Config`. Positional — see the header before touching it. */
export const gradualVetoConfigAbi = {
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

/** The flat shape the contract takes. `bigint` for both clocks: they are `uint64` on-chain. */
export interface SolidityVetoConfig {
    pauseAuthority: `0x${string}`;
    abortAuthority: `0x${string}`;
    resumeMembers: readonly `0x${string}`[];
    resumeThreshold: number;
    timelockSeconds: bigint;
    pauseCeilingSeconds: bigint;
}

function addressOf(authority: Authority): `0x${string}` {
    // The SDK's `Authority.id` is namespace-scoped; on EVM it is the address itself.
    if (!/^0x[0-9a-fA-F]{40}$/.test(authority.id)) {
        throw new Error(
            `Veto authority "${authority.id}" is not an EVM address. A veto config for ` +
                `${authority.namespace} cannot be encoded for an eip155 module.`,
        );
    }
    return authority.id as `0x${string}`;
}

/** Nested (SDK) to flat (Solidity). The only direction that produces calldata. */
export function toSolidityVetoConfig(config: VetoConfig): SolidityVetoConfig {
    return {
        pauseAuthority: addressOf(config.pauseAuthority),
        abortAuthority: addressOf(config.abortAuthority),
        resumeMembers: config.resumeQuorum.members.map(addressOf),
        resumeThreshold: config.resumeQuorum.threshold,
        timelockSeconds: BigInt(config.timelockSeconds),
        pauseCeilingSeconds: BigInt(config.pauseCeilingSeconds),
    };
}

/** Flat to nested, for reading `configOf()` back and comparing it field by field. */
export function fromSolidityVetoConfig(
    config: SolidityVetoConfig,
    namespace: string,
): VetoConfig {
    const authority = (id: string): Authority => ({ namespace, id });
    return {
        pauseAuthority: authority(config.pauseAuthority),
        abortAuthority: authority(config.abortAuthority),
        resumeQuorum: {
            members: config.resumeMembers.map(authority),
            threshold: config.resumeThreshold,
        },
        timelockSeconds: Number(config.timelockSeconds),
        pauseCeilingSeconds: Number(config.pauseCeilingSeconds),
    };
}

export interface DemoVetoInputs {
    namespace: string;
    pauseAuthority: string;
    resumeMembers: readonly string[];
    resumeThreshold: number;
    /** The wallet's own EOA. See the header for what choosing it costs. */
    abortAuthority: string;
    timelockSeconds: number;
    pauseCeilingSeconds: number;
}

export function demoVetoConfig(inputs: DemoVetoInputs): VetoConfig {
    const authority = (id: string): Authority => ({ namespace: inputs.namespace, id });
    return {
        pauseAuthority: authority(inputs.pauseAuthority),
        abortAuthority: authority(inputs.abortAuthority),
        resumeQuorum: {
            members: inputs.resumeMembers.map(authority),
            threshold: inputs.resumeThreshold,
        },
        timelockSeconds: inputs.timelockSeconds,
        pauseCeilingSeconds: inputs.pauseCeilingSeconds,
    };
}

/**
 * Validate before registering. Nothing else will.
 *
 * `@nihilium/recovery-veto` is wired to nothing in the SDK — `validateVetoConfig` runs only if a
 * caller runs it, and it is the §6.1 independence check the chain cannot make. The contract has no
 * idea whether the pause authority also sits in the resume quorum; it will encode and install that
 * config happily.
 *
 * The context is declared rather than withheld, which is the point. `sealGated: []` says none of
 * these authorities is gated behind the seal — true here, and the one property §7 still requires of
 * an abort key. `conditionSurface: []` says nothing reachable by forging the identity gate can also
 * resume: the guardians are email addresses and the resume members are server keys, disjoint by
 * construction. Passing `{}` would make both checks silently unrunnable.
 */
export function validateDemoVetoConfig(config: VetoConfig): VetoConfig {
    return validateVetoConfig(config, {
        sealGated: [],
        conditionSurface: [],
    });
}

/**
 * Solana refuses a resume quorum larger than this; EVM has no equivalent ceiling.
 *
 * A resume carries k detached signatures inside Solana's 1232-byte transaction limit, about 110
 * bytes each, so a larger quorum is a pause that could never be lifted and registration refuses it.
 * Checked here because a gate is chosen once and may later cover both chains — a 9-member quorum
 * would seal perfectly well on EVM and be unregistrable the moment Solana joined the vault.
 */
export const MAX_RESUME_MEMBERS_SOLANA = 8;

export function assertResumeQuorumPortable(config: VetoConfig): void {
    const members = config.resumeQuorum.members.length;
    if (members > MAX_RESUME_MEMBERS_SOLANA) {
        throw new Error(
            `A resume quorum of ${members} cannot be registered on Solana, which caps it at ` +
                `${MAX_RESUME_MEMBERS_SOLANA}: k detached signatures have to fit in one 1232-byte ` +
                "transaction. It would seal and install on EVM and then be unregistrable the moment " +
                "a Solana chain joined this vault.",
        );
    }
}
