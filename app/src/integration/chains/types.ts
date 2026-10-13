/**
 * The shape every chain in this demo satisfies: the SDK's `ChainBinding`, plus what a wallet UI needs.
 *
 * Nothing outside these modules branches on a chain id — a caller that needs "does this chain have a
 * pause button?" asks `settlement.capabilities()`. Adding a chain is one file next door plus one line
 * in `registry.ts`.
 *
 * **To replace:** nothing, if these are the fields your app needs. **Assumes:** the caller pins
 * `namespace` and `tier` once and never recomputes them — both are KDF inputs.
 */
import type { AccountExecutor, KeyAdapter, PublicKey, SettlementAdapter, Signature } from "@nihilium/recovery-core";
import type { ChainBinding } from "@nihilium/recovery-sdk";

/** A *name*, not a component: React may not cross the copy line. `ui/icons.tsx` resolves every one. */
export type IconName =
    | "ShieldCheck"
    | "Key"
    | "LockClosed"
    | "Clock"
    | "UserGroup"
    | "DocumentCheck"
    | "ethereum"
    | "solana"
    | "zcash"
    | "arbitrum";

export interface ChainModule extends ChainBinding {
    /** The chain, as a user names it: "Ethereum", not "EVM · Sepolia". */
    readonly label: string;
    /** Which network of that chain this build talks to — "Sepolia", "Devnet". */
    readonly network: string;
    /** What recovery protects on this chain, as a user would name it: "Safe smart account". */
    readonly accountKind: string;
    readonly icon: IconName;
    readonly keyAdapter: KeyAdapter;
    /** The SDK's adapter for this chain's construction, or `null` where this build has none. */
    readonly settlement: SettlementAdapter | null;

    /** Always a list. Account-model chains return one entry; UTXO chains return several. */
    deriveAccounts(seed: Uint8Array): Promise<DerivedAccount[]>;
    formatAddress(address: string, style?: "full" | "short"): string;
    /** This chain's address for a recovered public key, or `null` where the concept does not apply. */
    addressOf(publicKey: PublicKey): string | null;
    isValidAddress(value: string): boolean;
    /** `null` where there is no explorer. */
    explorerUrl(ref: ExplorerRef): string | null;
    balanceOf(address: string): Promise<Balance>;

    /** Moving value out as the current owner. `null` on a chain this demo has not wired. */
    readonly send: SendCapability | null;
    /**
     * Moving value out of a **recovered** account as its new owner — the step that makes a recovery
     * true. A wallet concern, not the SDK's: it is ordinary use of the account by whoever controls
     * it now. `null` where the chain has no settlement.
     */
    readonly sweep: SweepCapability | null;
}

export interface SendRequest {
    from: DerivedAccount;
    to: string;
    /** Base units, the same unit as `Balance.raw`. Never a float. */
    amount: bigint;
    onProgress?(message: string): void;
}

export interface SendReceipt {
    hash: string;
    explorerUrl: string | null;
    fidelity: "onchain" | "simulated";
}

export interface SendCapability {
    /** What must stay behind, in base units, so the operation can pay for itself. Zero where something else pays. */
    reserve(): bigint;
    send(request: SendRequest): Promise<SendReceipt>;
}

export interface SweepRequest {
    /** The recovered account: `ChainContext.accountId`. */
    accountId: string;
    /** The key that created the account, where the account is not that key. Solana's vault creator. */
    signerAddress?: string | undefined;
    to: string;
    /** The key the recovery handed control to. Demo-only as bytes; a real wallet holds a signer. */
    newOwnerPrivateKeyHex: string;
    /** `null` sweeps everything the account holds, less whatever it must keep back. */
    amount: bigint | null;
    onProgress?(message: string): void;
}

export interface SweepCapability {
    sweep(request: SweepRequest): Promise<{ hash: string; moved: bigint }>;
}

export type ExplorerRef = { kind: "address"; value: string } | { kind: "tx"; value: string };

export interface Balance {
    raw: bigint;
    decimals: number;
    symbol: string;
    /** Where the number came from. Travels with the value so a made-up balance cannot render without saying so. */
    source: "chain" | "simulated";
}

export interface DerivedAccount {
    /** Goes verbatim into `ChainContext.accountId`. Case and formatting are part of the key. */
    accountId: string;
    /** What the user sees and sends to. Differs from `accountId` where the two are not one account. */
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
     * The **account** as the SDK drives it: the Safe through its bundler client on Sepolia, the EOA
     * on Arbitrum, the owner keypair with a fee payer on Solana. What `protect` registers with.
     */
    executor(): Promise<AccountExecutor>;
    /**
     * The **key** as a plain sender: what signs and pays for a sender-gated call such as `abort`.
     * The same thing as `executor()` everywhere the account is its own key.
     */
    keyExecutor(): Promise<AccountExecutor>;
    /**
     * The demo seed is public, and the sweep helpers want bytes rather than a signer — so this
     * exists, named the way the SDK names its own escape hatches so nobody copies it into a wallet.
     */
    exportPrivateKeyHex_DEMO_ONLY(): string;
}

export interface ChainRegistry {
    all(): ChainModule[];
    get(id: string): ChainModule | undefined;
    /** Throws rather than returning undefined: a missing chain is a programming error. */
    require(id: string): ChainModule;
}
