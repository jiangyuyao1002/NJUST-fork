import { getBundledCangjieCorpusPath } from "../../../utils/bundledCangjieCorpus"

export function resolveBundledCangjieCorpusPath(extensionPath: string | undefined): string | null {
	return getBundledCangjieCorpusPath(extensionPath)
}

/**
 * Resolve the Cangjie documentation/corpus base used for prompt context.
 * Only the extension-bundled tree is used; workspace fallbacks stay disabled.
 */
export function resolveCangjieDocsBasePath(extensionPath?: string): string | null {
	return resolveBundledCangjieCorpusPath(extensionPath)
}
