/**
 * The on-chain half, as React state.
 *
 * Sealing produces a recovery key; this is what tells the chain about it. Until it runs, the badge
 * on the wallet reads "Sealed · not on-chain yet" and means it — the module has never heard of the
 * key, so nothing on Sepolia would honour a recovery.
 *
 * It reads the chain rather than remembering: `installed` and `recoveryOwner` come from `configOf()`
 * every time, because the account can be changed by anything holding its key and a cached answer
 * would be this app's belief rather than the chain's state. That is also what makes `stale`
 * detectable — a vault whose key the chain does not hold.
 */
import { useCallback, useEffect, useState } from "react";
import { createPublicClient, http, type Address, type Hex, type PublicClient } from "viem";
import { sepolia } from "viem/chains";
import { recoveryModuleAddress } from "@nihilium/recovery-onchain-evm";
import type { VetoState } from "@nihilium/recovery-core";
import { toEvmAddress } from "@nihilium/recovery-key-evm";
import type { ChainModule, DerivedAccount } from "../integration/chains/types.js";
import type { VaultRecord } from "../integration/recovery/vaultRecords.js";
import { protectAccount } from "../integration/recovery/settlement/evm/install.js";
import { createModuleReader } from "../integration/recovery/settlement/evm/reads.js";
import { isProtectedByVault } from "../integration/recovery/settlement/evm/preflight.js";
import type { SolidityVetoConfig } from "../integration/recovery/settlement/evm/vetoConfig.js";
import type { AppBindings } from "./bindings.js";

/** What the server's relayer role publishes: the operator's veto keys, not the account's. */
interface RelayerConfig {
    recoveryModuleAddress: Address;
    relayer: Address;
    pauseAuthority: Address;
    resumeMembers: Address[];
    resumeThreshold: number;
    timelockSeconds: number;
    pauseCeilingSeconds: number;
}

export interface OnChainState {
    installed: boolean;
    recoveryOwner: Address | null;
    /** True when the chain holds *this* vault's key. False with a vault present means `stale`. */
    matchesVault: boolean;
    /**
     * The module's view of any recovery attempt on this account: `null` when there is none.
     *
     * Read here rather than remembered, and read for *any* attempt rather than only this browser's —
     * polling `stateOf` is how a recovery somebody else submitted becomes visible at all. It is not
     * a substitute for a watchtower, which fires earlier and off-chain; see `recoveryHealth.ts`.
     */
    attempt: VetoState | null;
    /** Seconds accrued toward the timelock, as of the last checkpoint. */
    accruedSeconds: bigint;
    intentHash: Hex | null;
}

export interface SettlementState {
    phase: "idle" | "protecting" | "failed";
    onchain: OnChainState | null;
    error: string | null;
    log: string[];
    txHash: string | null;
}

const EMPTY: SettlementState = {
    phase: "idle",
    onchain: null,
    error: null,
    log: [],
    txHash: null,
};

export function useSettlement(
    bindings: AppBindings,
    chain: ChainModule,
    account: DerivedAccount | undefined,
    vault: VaultRecord | null,
) {
    const [state, setState] = useState<SettlementState>(EMPTY);
    const [nonce, setNonce] = useState(0);

    const evm = chain.id === "evm-sepolia";
    const chainRecord = vault?.chains.find((row) => row.chainId === chain.id) ?? null;
    const accountId = account?.accountId;

    const moduleAddress = evm
        ? (recoveryModuleAddress(bindings.env.chainId) as Address)
        : null;

    const reader = useCallback(() => {
        const client = createPublicClient({
            chain: sepolia,
            transport: http(bindings.env.sepoliaRpcUrl),
        }) as PublicClient;
        return createModuleReader(client, moduleAddress!, chain.namespace);
    }, [bindings.env.sepoliaRpcUrl, chain.namespace, moduleAddress]);

    // Re-read whenever the account, the vault or a completed write says the answer may have moved.
    useEffect(() => {
        // Nothing to read: not an EVM chain, or no account yet. `onchain` stays whatever it was
        // and is masked to null on the way out, rather than written here — a setState in an effect
        // just to say "nothing happened" is a render nobody needed.
        if (!evm || moduleAddress === null || accountId === undefined) return;
        let live = true;

        void (async () => {
            try {
                const module = reader();
                const installed = await module.isInitialized(accountId as Address);
                const config = installed ? await module.configOf(accountId as Address) : null;
                const attempt = installed ? await module.attemptOf(accountId as Address) : null;
                const matchesVault =
                    chainRecord === null || !installed
                        ? false
                        : await isProtectedByVault(
                              module,
                              accountId as Address,
                              chainRecord.recoveryPubKeyHex,
                          );
                if (!live) return;
                setState((prev) => ({
                    ...prev,
                    phase: "idle",
                    onchain: {
                        installed,
                        recoveryOwner: config?.recoveryOwner ?? null,
                        matchesVault,
                        attempt: attempt?.state ?? null,
                        accruedSeconds: attempt?.accruedSeconds ?? 0n,
                        intentHash: attempt?.intentHash ?? null,
                    },
                }));
            } catch (error) {
                // An unreadable chain is not an unprotected account, and must not render as one.
                if (!live) return;
                setState((prev) => ({ ...prev, phase: "failed", error: messageOf(error) }));
            }
        })();

        return () => {
            live = false;
        };
    }, [evm, moduleAddress, accountId, chainRecord, reader, nonce]);

    const note = useCallback((line: string) => {
        setState((prev) => ({ ...prev, log: [...prev.log, line] }));
    }, []);

    /**
     * Install the module, or replace what is installed.
     *
     * The veto authorities come from the server because they are the *operator's* keys; only
     * `abortAuthority` is decided here, and it is this wallet's own EOA — an owner who still holds
     * their key can kill a recovery started against them. That makes the abort key seed-derived,
     * which §7 says it should not be; see `settlement/evm/vetoConfig.ts` for what that costs.
     */
    const protect = useCallback(async () => {
        if (account === undefined || chainRecord === null || moduleAddress === null) return;
        setState((prev) => ({ ...prev, phase: "protecting", error: null, log: [], txHash: null }));

        try {
            const response = await fetch(`${bindings.env.serverUrl}/api/roles/relayer/config`);
            if (!response.ok) {
                throw new Error(
                    "The relayer is not reachable, so the veto authorities are unknown. Start it " +
                        "with `npm run dev:server`.",
                );
            }
            const config = (await response.json()) as RelayerConfig;

            const veto: SolidityVetoConfig = {
                pauseAuthority: config.pauseAuthority,
                // The wallet's own key. See the doc comment above.
                abortAuthority: account.signer.address as Address,
                resumeMembers: config.resumeMembers,
                resumeThreshold: config.resumeThreshold,
                timelockSeconds: BigInt(config.timelockSeconds),
                pauseCeilingSeconds: BigInt(config.pauseCeilingSeconds),
            };

            const recoveryOwner = recoveryOwnerAddress(chainRecord.recoveryPubKeyHex);
            note(`recoveryOwner ${recoveryOwner}`);

            const result = await protectAccount(
                {
                    rpcUrl: bindings.env.sepoliaRpcUrl,
                    bundlerUrl: bindings.env.bundlerUrl,
                    ownerPrivateKeyHex: account.signer.exportPrivateKeyHex_DEMO_ONLY(),
                    moduleAddress,
                },
                {
                    recoveryOwner,
                    veto,
                    // An install over an existing one reverts `AlreadyInstalled`, so a replacement
                    // has to uninstall first — in the same operation.
                    ...(state.onchain?.installed === true ? { replacing: true } : {}),
                    onProgress: note,
                },
            );

            setState((prev) => ({ ...prev, phase: "idle", txHash: result.transactionHash }));
            // Re-read rather than assume: the chain is the source of truth for what is installed.
            setNonce((n) => n + 1);
        } catch (error) {
            setState((prev) => ({ ...prev, phase: "failed", error: messageOf(error) }));
        }
    }, [account, bindings.env, chainRecord, moduleAddress, note, state.onchain]);

    return {
        // Masked rather than stored: switching to Solana must not leave Sepolia's answer on screen,
        // and switching back must not have thrown it away.
        state: evm ? state : { ...state, onchain: null },
        protect,
        supported: evm,
        refresh: () => setNonce((n) => n + 1),
    };
}

export type Settlement = ReturnType<typeof useSettlement>;

function recoveryOwnerAddress(hex: string): Address {
    // Kept in step with `preflight.ts`, which derives the same address for its owner check.
    const body = hex.startsWith("0x") ? hex.slice(2) : hex;
    const bytes = new Uint8Array(body.length / 2);
    for (let i = 0; i < bytes.length; i += 1) {
        bytes[i] = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16);
    }
    // The SDK's own `toEvmAddress`, the one used at derivation time: a second implementation
    // here would make a checksum difference look like a key mismatch.
    return toEvmAddress({ algorithm: "secp256k1", bytes }) as Address;
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
