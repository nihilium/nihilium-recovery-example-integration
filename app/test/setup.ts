// IndexedDB, for the storage conformance suites. Node has none, and jsdom/happy-dom do not ship one
// either — so the stores are tested against a real implementation of the API rather than a mock of
// this repo's own making.
import "fake-indexeddb/auto";
