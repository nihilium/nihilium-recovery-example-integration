/**
 * The IndexedDB database this demo has always used. Kept, rather than the SDK's default name, so a
 * vault sealed by an earlier build is still here: the SDK's stores create what is missing and drop
 * nothing. Its own file because `env.ts` reads `import.meta`, which the test project does not type.
 */
export const DEMO_DB_NAME = "nihilium-recovery-demo";
