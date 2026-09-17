import type { ChainModule } from "../integration/chains/types.js";
import { Icon } from "./icons.js";

export function WalletSwitcher({
    chains,
    activeId,
    onSelect,
}: {
    chains: ChainModule[];
    activeId: string;
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
                </button>
            ))}
        </div>
    );
}
