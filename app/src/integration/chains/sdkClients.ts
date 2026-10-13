/**
 * Two copies of viem, while the SDK is linked from a sibling checkout.
 *
 * `file:` links resolve to real paths, so the SDK's settlement packages import *their* viem and this
 * app imports its own. The two are the same version and the objects are plain, but TypeScript cannot
 * prove two copies of viem's deeply generic `Client` type equal, and refuses the assignment. These
 * casts say so once, at the one boundary where a client crosses from this app into the SDK.
 *
 * **To replace:** delete this file the day the SDK installs from npm — one copy, no casts.
 * **Assumes:** both copies are the same viem version. `npm install` pins the app's to the SDK's.
 */
import type { SmartAccount } from "viem/account-abstraction";
import type { PublicClient, WalletClient } from "viem";
import type { Erc7579RecoveryModuleOptions, eoaExecutor } from "@nihilium/recovery-settlement-evm";

type SdkPublicClient = Erc7579RecoveryModuleOptions["client"];
type SdkWalletClient = Parameters<typeof eoaExecutor>[0]["walletClient"];

export function asSdkPublicClient(client: PublicClient): SdkPublicClient {
    return client as unknown as SdkPublicClient;
}

export function asSdkWalletClient(client: WalletClient): SdkWalletClient {
    return client as unknown as SdkWalletClient;
}

/** The other direction: an account the SDK built, handed to this app's permissionless client. */
export function asAppSmartAccount(account: unknown): SmartAccount {
    return account as SmartAccount;
}
