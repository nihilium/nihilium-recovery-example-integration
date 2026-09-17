import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        // node, not jsdom: the conformance suites need IndexedDB, and jsdom/happy-dom do not ship it.
        // `fake-indexeddb/auto` installs a real implementation over the global scope instead.
        environment: "node",
        setupFiles: ["./test/setup.ts"],
        include: ["test/**/*.test.ts"],
    },
});
