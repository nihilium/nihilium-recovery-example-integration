import type { ChainModule } from "../integration/chains/types.js";
import type { VaultRecord } from "../integration/recovery/vaultRecords.js";
import { Icon } from "./icons.js";
import { ProtectionDot } from "./ProtectionBadge.js";
import { protectionOf } from "./protection.js";
import { Tooltip } from "./Tooltip.js";

/**
 * A chain this build cannot settle yet. The tab stays visible — a chain that is simply absent reads
 * as a bug — but a disabled control with nothing beside it reads as a bug too, so the hold tooltip
 * states the fact.
 */
const COMING_SOON: Record<string, string> = {
    "zcash-testnet": "No settlement program yet — coming soon",
};

/** The pointer must hold this long before the status opens; a tooltip firing on the way past is a flicker. */
const HOLD_MS = 700;

export function WalletSwitcher({
    chains,
    activeId,
    vaultFor,
    walletId,
    disabledIds,
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
    /** Chains whose tab renders disabled; the reason lives in `COMING_SOON`, not here. */
    disabledIds?: ReadonlySet<string>;
    onSelect: (id: string) => void;
}) {
    return (
        <div className="wallet-strip" role="tablist" aria-label="Chains">
            {chains.map((chain) => {
                const comingSoon = COMING_SOON[chain.id];
                const disabled = comingSoon !== undefined || (disabledIds?.has(chain.id) ?? false);
                const tab = (
                    <button
                        key={chain.id}
                        type="button"
                        role="tab"
                        className="wallet-tab"
                        aria-selected={chain.id === activeId}
                        disabled={disabled}
                        onClick={() => onSelect(chain.id)}
                    >
                        <Icon name={chain.icon} className="wallet-tab__icon" />
                        {chain.label}
                        <ProtectionDot state={protectionOf(vaultFor(chain.id, walletId), chain.id)} />
                    </button>
                );
                if (comingSoon === undefined) return tab;
                // `as="div"` because the tab is already a button — and a disabled one fires no
                // pointer events, so the Tooltip's wrapper span is what the hold timer listens to.
                return (
                    <Tooltip
                        key={chain.id}
                        as="div"
                        label={`${chain.label}: ${comingSoon}`}
                        delay={HOLD_MS}
                        panel={comingSoon}
                    >
                        {tab}
                    </Tooltip>
                );
            })}
        </div>
    );
}
