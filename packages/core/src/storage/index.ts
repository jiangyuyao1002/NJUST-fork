/**
 * Storage abstraction for model cache modules.
 *
 * The api/providers/fetchers/ layer needs a `globalStorageUri.fsPath` to
 * locate the on-disk model cache directory. Importing `ContextProxy`
 * directly would couple the api layer to the VS Code extension context,
 * so callers (e.g. extension.ts) inject a store that satisfies this
 * minimal duck-typed interface.
 */
export interface IModelCacheStore {
	globalStorageUri: { fsPath: string }
}
