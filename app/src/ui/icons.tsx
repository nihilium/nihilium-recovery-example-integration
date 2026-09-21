/**
 * `IconName` -> component. The registry under `integration/chains/` names an icon as a *string*,
 * because a React component may not cross the copy line (CLAUDE.md -> The copy line). This is where
 * that name becomes a component, and it is the only place that mapping exists.
 *
 * Two sources feed it: the design system's six Heroicons, for anything conceptual, and the chains'
 * own marks in `chainLogos.tsx`, for the chains. The design system will not be growing chain logos —
 * those belong to the chains rather than to Nihilium.
 *
 * `IconName` is imported from the integration side rather than derived from the map below, which is
 * the direction that catches drift: the union is the contract, and a missing entry here is a type
 * error rather than a mark that silently fails to render.
 */
import type { IconName } from "../integration/chains/types.js";
import { icons as dsIcons } from "./ds.js";
import { EthereumMark, SolanaMark, ZcashMark } from "./chainLogos.js";

const marks: Record<IconName, React.ComponentType<{ className?: string }>> = {
    ...dsIcons,
    ethereum: EthereumMark,
    solana: SolanaMark,
    zcash: ZcashMark,
};

export type { IconName };

export function Icon({ name, className }: { name: IconName; className?: string }) {
    const Mark = marks[name];
    return <Mark className={className} aria-hidden="true" />;
}
