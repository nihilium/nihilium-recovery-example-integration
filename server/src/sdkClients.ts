/**
 * Two copies of viem, while the SDK is linked from a sibling checkout — see the app's copy of this
 * file. Delete it the day the SDK installs from npm.
 */
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
