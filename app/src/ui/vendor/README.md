# Vendored: the Nihilium design system

`_ds_bundle.js` and `_ds_bundle.css` are copied verbatim from the `nihilium-design-system` skill
(`~/.claude/skills/nihilium-design-system/assets/`). They are **not edited here** — to update, copy
them again.

They are vendored rather than installed because `@nihilium/ds` is not published to npm. The day it
is, this directory is deleted and `ds.ts` becomes a re-export of the package. Nothing else in the
app should need to change: `ds.ts` is the only file that knows where the components come from.

`_ds_bundle.js` is an IIFE that reads `window.React` at evaluation time and assigns
`window.NihiliumDS` — see `../ds.ts` for why that forces a two-module import order.
