/**
 * `IconName` -> component. The registry under `integration/chains/` names an icon as a *string*,
 * because a React component may not cross the copy line (CLAUDE.md -> The copy line). This is where
 * that name becomes a component, and it is the only place that mapping exists.
 */
import { icons } from "./ds.js";

export type IconName = keyof typeof icons;

export function Icon({ name, className }: { name: IconName; className?: string }) {
    const Mark = icons[name];
    return <Mark className={className} aria-hidden="true" />;
}
