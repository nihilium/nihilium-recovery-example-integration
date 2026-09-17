/**
 * The one file that knows where the design system comes from.
 *
 * `@nihilium/ds` is not published, so the skill's browser bundle is vendored under `vendor/` and
 * reached through the global it assigns. Everything else imports the components from here, so the
 * day the package ships this file becomes `export * from "@nihilium/ds"` and nothing else moves.
 *
 * The import order below is load-bearing and not alphabetical: `react-global` must evaluate before
 * `_ds_bundle`, which reads `window.React` as it runs. See `vendor/react-global.ts`.
 */
import "./vendor/react-global.js";
import "./vendor/_ds_bundle.js";
import "./vendor/_ds_bundle.css";

import type { NihiliumDS } from "./ds-types.js";

const ds = (globalThis as unknown as { NihiliumDS?: NihiliumDS }).NihiliumDS;

if (ds === undefined) {
    // Reaching here means the bundle evaluated without publishing its global — almost always an
    // import-order change in this file. Failing loudly beats rendering unstyled components.
    throw new Error(
        "The Nihilium design-system bundle did not publish window.NihiliumDS. " +
            "Check that ./vendor/react-global.js is still imported before ./vendor/_ds_bundle.js.",
    );
}

export const {
    Button,
    Card,
    CardGrid,
    Checkbox,
    FeatureCard,
    Heading,
    Hero,
    Page,
    Section,
    StatusMessage,
    SubscribeForm,
    TextInput,
    TextLink,
    TopBar,
} = ds;

export const icons = {
    ShieldCheck: ds.ShieldCheckIcon,
    Key: ds.KeyIcon,
    LockClosed: ds.LockClosedIcon,
    Clock: ds.ClockIcon,
    UserGroup: ds.UserGroupIcon,
    DocumentCheck: ds.DocumentCheckIcon,
} as const;

export type * from "./ds-types.js";
