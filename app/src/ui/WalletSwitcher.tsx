import type { ChainModule } from "../integration/chains/types.js";
import type { VaultRecord } from "../integration/recovery/vaultRecords.js";
import { Icon } from "./icons.js";
import { ProtectionDot } from "./ProtectionBadge.js";
import { protectionOf } from "./protection.js";

export function WalletSwitcher({
    chains,
    activeId,
    vaultFor,
    onSelect,
}: {
    chains: ChainModule[];
    activeId: string;
    /** Per chain: a vault covers what `addChain()` covered, so the dots differ across these tabs. */
    vaultFor: (chainId: string) => VaultRecord | null;
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
                    <ProtectionDot state={protectionOf(vaultFor(chain.id), chain.id)} />
                </button>
            ))}
        </div>
    );
}
