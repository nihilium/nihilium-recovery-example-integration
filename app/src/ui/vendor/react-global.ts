// Hands the vendored design-system bundle the React it expects.
//
// Two things about that bundle force the shape of this file:
//
// 1. Its React shim reads `window.React` at module-evaluation time. ES modules evaluate in import
//    order, depth first, so this assignment only lands in time if it happens in a *separate module
//    imported before* the bundle — `import` declarations hoist above everything else, so two
//    statements in one file would not work. See `../ds.ts` for the import order that matters.
//
// 2. The shim then MUTATES what it was given: `module.exports = R; module.exports.jsx = …;
//    module.exports.Fragment = R.Fragment;`. It was written for the UMD React global, which is a
//    plain writable object. `import * as React` yields an ES module namespace whose properties are
//    getter-only, so assigning to it throws
//    `Cannot set property Fragment of #<Object> which has only a getter` and the page renders
//    nothing. Handing over a shallow copy gives the shim something it may write to, and costs
//    nothing: it only ever reads `createElement`, `Fragment` and the hooks back off it.
import * as React from "react";

(globalThis as unknown as { React: unknown }).React = { ...React };
