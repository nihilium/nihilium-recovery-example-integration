import type { ChainModule } from "../integration/chains/types.js";
import type { VaultRecord } from "../integration/recovery/vaultRecords.js";
import { Icon } from "./icons.js";
import { ProtectionDot } from "./ProtectionBadge.js";
import { protectionOf } from "./protection.js";

export function WalletSwitcher({
    chains,
    activeId,
    vaultFor,
    walletId,
    onSelect,
}: {
    chains: ChainModule[];
    activeId: string;
    /**
     * Per chain *and* per wallet: a vault covers what `addChain()` covered, for the wallet it was
     * sealed against. Switching seeds changes the wallet, and a dot that ignored that would show
     * the previous seed's protection on the new one.
     *
     * Keyed on the wallet rather than an address, because one vault spans chains whose protected
     * accounts are different kinds of thing — a smart account here, a program PDA on Solana. An
     * address can only identify a vault on the chain it was sealed from.
     */
    vaultFor: (chainId: string, walletId: string | undefined) => VaultRecord | null;
    /** The wallet on screen. See `VaultRecord.walletId`. */
    walletId: string;
    onSelect: (id: string) => void;
}) {
    return (
        <div className="wallet-strip" role="tablist" aria-label="Chains">
            {chains.map((chain) => (
                <button
                    key={chain.id}
                    type="button"
                    role="tab"
                    className="wallet-tab"
                    aria-selected={chain.id === activeId}
                    onClick={() => onSelect(chain.id)}
                >
                    <Icon name={chain.icon} className="wallet-tab__icon" />
                    {chain.label}
                    <ProtectionDot state={protectionOf(vaultFor(chain.id, walletId), chain.id)} />
                </button>
            ))}
        </div>
    );
}
