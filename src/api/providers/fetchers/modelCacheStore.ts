/**
 * Shared model cache store injection point.
 *
 * The api/providers/fetchers/ layer needs a `globalStorageUri.fsPath` to
 * locate the on-disk model cache directory. Importing `ContextProxy`
 * directly would couple the api layer to the VS Code extension context,
 * so callers (e.g. extension.ts) inject a store that satisfies this
 * minimal duck-typed interface.
 */
import type { IModelCacheStore } from "@njust-ai/core/storage"

let cacheStore: IModelCacheStore | undefined

/**
 * Inject the cache store. Call once during extension activation, after
 * ContextProxy has been initialized. Pass undefined to clear (mainly for
 * tests).
 */
export function setModelCacheStore(store: IModelCacheStore | undefined): void {
	cacheStore = store
}

/**
 * Returns the currently-injected store, or undefined if no caller has
 * injected one yet. Cache writers should treat undefined as "no-op"
 * rather than throwing — keeping the api layer safe to import from
 * tests or contexts where no host application is attached.
 */
export function getModelCacheStore(): IModelCacheStore | undefined {
	return cacheStore
}
