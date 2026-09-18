/**
 * The shape every chain in this demo satisfies. Nothing outside these modules branches on a chain
 * id — a caller that needs to know "does this chain have a pause button?" asks
 * `settlement.capabilities()`, and a caller that needs "is this balance real?" reads
 * `balance.source`.
 *
 * Adding a chain is one file next door plus one line in `registry.ts`.
 *
 * **To replace:** nothing, if these are the fields your app needs. This is the contract, and a
 * method or a UI that branches on a chain id instead of asking through it is the thing it exists to
 * prevent. **Assumes:** the caller pins `namespace` and `tier` once and never recomputes them.
 */
import type { KeyAdapter, PublicKey, Signature, Tier } from "@nihilium/recovery-core";
import type { SettlementBinding } from "../recovery/settlement/types.js";

/** Matches `ui/icons.tsx`. A *name*, not a component: React may not cross the copy line. */
export type IconName =
    | "ShieldCheck"
    | "Key"
    | "LockClosed"
    | "Clock"
    | "UserGroup"
    | "DocumentCheck";

export interface ChainModule {
    readonly id: string;
    readonly label: string;
    readonly icon: IconName;

    /**
     * CAIP-2, and permanent. This string is an HKDF input (§11): every recovery key the SDK derives
     * for this chain depends on it byte for byte, and nothing in the SDK will notice if it changes —
     * the recovery simply yields a different key. Pin it here, never recompute it from a chain
     * object at runtime.
     */
    readonly namespace: string;

    /** Decides which veto capabilities can exist here at all (§5). */
    readonly tier: Tier;

    /** The SDK's adapter for this curve, or one written in this repo (see `zcash/keyAdapter.ts`). */
    readonly keyAdapter: KeyAdapter;

    /**
     * Always a list. Account-model chains return one entry; UTXO chains return several, and callers
     * iterate rather than asking which kind this is.
     */
    deriveAccounts(seed: Uint8Array): Promise<DerivedAccount[]>;

    formatAddress(address: string, style?: "full" | "short"): string;

    /** `null` where there is no explorer — a simulated chain returns null and the UI renders text. */
    explorerUrl(ref: ExplorerRef): string | null;

    balanceOf(address: string): Promise<Balance>;

    /** `null` until a chain has somewhere to register a recovery key. */
    readonly settlement: SettlementBinding | null;
}

export type ExplorerRef = { kind: "address"; value: string } | { kind: "tx"; value: string };

export interface Balance {
    raw: bigint;
    decimals: number;
    symbol: string;
    /**
     * Where the number came from. This travels with the value on purpose: a component cannot render
     * a made-up balance without also holding the field that says it is made up.
     */
    source: "chain" | "simulated";
}

export interface DerivedAccount {
    /**
     * Goes verbatim into `ChainContext.accountId`. The SDK compares it as a raw string and feeds it
     * to the KDF, so case and formatting are part of the key: `0xAbC…` and `0xabc…` derive different
     * recovery keys.
     */
    accountId: string;
    /** What the user sees. Differs from `accountId` where an EOA fronts a smart account. */
    address: string;
    label: string;
    derivationPath: string;
    index: number;
    signer: AccountSigner;
}

export interface AccountSigner {
    address: string;
    publicKey: PublicKey;
    sign(payload: Uint8Array): Promise<Signature>;
    /**
     * The demo seed is public, and viem's account helpers want bytes rather than a signer — so this
     * exists, named the way the SDK names its own escape hatches
     * (`openAppend_DO_NOT_USE_IN_PRODUCTION`) so that nobody copies it into a wallet by accident.
     */
    exportPrivateKeyHex_DEMO_ONLY(): string;
}

export interface ChainRegistry {
    all(): ChainModule[];
    get(id: string): ChainModule | undefined;
    /** Throws rather than returning undefined: a missing chain is a programming error, not a state. */
    require(id: string): ChainModule;
}
