import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Nothing here is a workaround. The SDK is browser-safe by construction — `core` reaches randomness
// through WebCrypto and declares its own fetch types rather than pulling in node builtins — so no
// buffer/process shim is needed. The one package that does import `node:fs`,
// `@nihilium/recovery-storage-local`, is deliberately absent from this project's dependencies and
// is caught by `test/boundaries.test.ts` if anyone adds it.
export default defineConfig({
    plugins: [react()],
    server: { port: 5173 },
});
