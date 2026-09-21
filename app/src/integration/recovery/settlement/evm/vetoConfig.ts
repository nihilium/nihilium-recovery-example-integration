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
 * - `abortAuthority` is the wallet's **own active EOA**, so an owner who still holds their keys can
 *   kill a recovery started against them. It is therefore seed-derived, which §7 says an abort key
 *   must not be: in the true-seed-loss case it is gone exactly when it would be needed. This build
 *   does not declare `seedDerived` to the validator, so that check does not fire — a deliberate
 *   choice, and `reviewVetoConfig` still reports the check as *unverified* rather than passed.
 *
 * **To replace:** `demoVetoConfig`, all of it. The tuple and the mapper are protocol; the key
 * assignment is a product decision and this one is a demo's.
 * **Assumes:** `GradualVeto.Config` in `../recovery-sdk/onchain/evm/src/GradualVeto.sol` still has
 * these six fields in this order. Any change there must be mirrored here by hand.
 */
import { reviewVetoConfig } from "@nihilium/recovery-veto";
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

export interface VetoConfigReview {
    ok: boolean;
    error?: string;
    /** Checks that could not be *made*, which is not the same as checks that passed. */
    unverified: readonly string[];
}

/**
 * `reviewVetoConfig`, not `validateVetoConfig`.
 *
 * The throwing form reports the first problem and stops; a setup screen wants all of them at once,
 * plus the ones it could not test. The `unverified` list is load-bearing here rather than
 * incidental: this config deliberately withholds `seedDerived`, so §7 on the abort key comes back
 * unverified every time, and that line is meant to be read.
 */
export function reviewDemoVetoConfig(config: VetoConfig): VetoConfigReview {
    return reviewVetoConfig(config);
}
