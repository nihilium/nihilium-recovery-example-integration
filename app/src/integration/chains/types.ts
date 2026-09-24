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

/**
 * A *name*, not a component: React may not cross the copy line.
 *
 * The first six are the design system's Heroicons, for anything conceptual. The lowercase three are
 * the chains' own marks — a chain tab showing a generic shield says nothing about which chain it is,
 * and the design system is not the place for brand logos it does not own. `ui/icons.tsx` resolves
 * every one of these and fails to compile if it misses one.
 */
export type IconName =
    | "ShieldCheck"
    | "Key"
    | "LockClosed"
    | "Clock"
    | "UserGroup"
    | "DocumentCheck"
    | "ethereum"
    | "solana"
    | "zcash";

export interface ChainModule {
    readonly id: string;
    /** The chain, as a user names it: "Ethereum", not "EVM · Sepolia". */
    readonly label: string;
    /**
     * Which network of that chain this build talks to — "Sepolia", "Devnet". Kept apart from `label`
     * so the page can say *Ethereum* everywhere and name the testnet once, where networks are shown.
     */
    readonly network: string;
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

    /**
     * This chain's address for a recovered public key, or `null` where the concept does not apply.
     *
     * On the chain module because only it knows: the curve does not determine the encoding. Zcash
     * and EVM are both secp256k1 and share no address format, so branching on `algorithm` would
     * produce a confident, wrong string rather than an error.
     *
     * A recovery hands back bytes. Without this, a wallet can show the user a public key and nothing
     * they can look up — which is what `RecoveredKey` did, with `address` hardcoded to `null`.
     */
    addressOfPublicKey(publicKey: PublicKey): string | null;

    /**
     * Whether this chain would accept `value` as a destination.
     *
     * On the chain module because only it knows: an EVM regex rejects every base58 address, and a
     * form that hard-codes one is a form that silently cannot send on any other chain. That is
     * exactly what happened — `SendDialog` tested `/^0x[0-9a-fA-F]{40}$/` and the Send button never
     * enabled on Solana.
     */
    isValidAddress(value: string): boolean;

    /** `null` where there is no explorer — a simulated chain returns null and the UI renders text. */
    explorerUrl(ref: ExplorerRef): string | null;

    balanceOf(address: string): Promise<Balance>;

    /** `null` until a chain has somewhere to register a recovery key. */
    readonly settlement: SettlementBinding | null;

    /**
     * Moving value out. `null` on a chain this demo has not wired, which is most of them.
     *
     * It sits on the chain module rather than in a component because every chain answers it
     * differently — a UserOp here, a system-program transfer on Solana, a UTXO spend on Zcash — and
     * a send form that knew which was which would be a form that has to grow a branch per chain.
     */
    readonly send: SendCapability | null;
}

export interface SendRequest {
    from: DerivedAccount;
    to: string;
    /** Base units, the same unit as `Balance.raw` — wei here, lamports there. Never a float. */
    amount: bigint;
    onProgress?(message: string): void;
}

export interface SendReceipt {
    hash: string;
    explorerUrl: string | null;
    /** `simulated` where nothing left a chain. Travels with the receipt so a badge cannot be forgotten. */
    fidelity: "onchain" | "simulated";
}

export interface SendCapability {
    /**
     * What must stay behind, in base units.
     *
     * An account that pays for its own transaction cannot send everything it holds: the operation is
     * rejected for insufficient funds *during validation*, after the user has been told the amount
     * was fine. Subtracting a reserve is the difference between a "Max" button that works and one
     * that fails every time. Zero where something else pays the fee.
     */
    reserve(): bigint;
    send(request: SendRequest): Promise<SendReceipt>;
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
    /**
     * What the user sees and sends to. Differs from `accountId` where the two are not one account.
     *
     * On EVM they are the same — the smart account is both. On Solana `accountId` is the vault the
     * program acts on and this is the account holding its lamports; nothing can move value out of
     * the former, so it is never the address offered for copying.
     */
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
