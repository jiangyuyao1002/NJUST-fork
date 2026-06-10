/**
 * Common character mappings for normalization
 */
export const NORMALIZATION_MAPS = {
	// Smart quotes to regular quotes
	SMART_QUOTES: {
		"\u201C": '"', // Left double quote (U+201C)
		"\u201D": '"', // Right double quote (U+201D)
		"\u2018": "'", // Left single quote (U+2018)
		"\u2019": "'", // Right single quote (U+2019)
	},
	// Other typographic characters
	TYPOGRAPHIC: {
		"\u2026": "...", // Ellipsis
		"\u2014": "-", // Em dash
		"\u2013": "-", // En dash
		"\u00A0": " ", // Non-breaking space
	},
}

/**
 * Options for string normalization
 */
export interface NormalizeOptions {
	smartQuotes?: boolean // Replace smart quotes with straight quotes
	typographicChars?: boolean // Replace typographic characters
	extraWhitespace?: boolean // Collapse multiple whitespace to single space
	trim?: boolean // Trim whitespace from start and end
}

/**
 * Default options for normalization
 */
const DEFAULT_OPTIONS: NormalizeOptions = {
	smartQuotes: true,
	typographicChars: true,
	extraWhitespace: true,
	trim: true,
}

/**
 * Normalizes a string based on the specified options
 *
 * @param str The string to normalize
 * @param options Normalization options
 * @returns The normalized string
 */
// Pre-compiled combined regex for single-pass smart char normalization.
// Avoids O(n*m) per-char iterations across the string.
const SMART_CHAR_MAP: Record<string, string> = { ...NORMALIZATION_MAPS.SMART_QUOTES, ...NORMALIZATION_MAPS.TYPOGRAPHIC }
const SMART_CHAR_RE = new RegExp(`[${Object.keys(SMART_CHAR_MAP).join("")}]`, "g")

function _applySmartCharReplacement(text: string): string {
	return text.replace(SMART_CHAR_RE, (ch) => SMART_CHAR_MAP[ch] ?? ch)
}

export function normalizeString(str: string, options: NormalizeOptions = DEFAULT_OPTIONS): string {
	const opts = { ...DEFAULT_OPTIONS, ...options }
	let normalized = str

	// Replace smart quotes and typographic characters in a single pass
	if (opts.smartQuotes || opts.typographicChars) {
		const map: Record<string, string> = {}
		if (opts.smartQuotes) Object.assign(map, NORMALIZATION_MAPS.SMART_QUOTES)
		if (opts.typographicChars) Object.assign(map, NORMALIZATION_MAPS.TYPOGRAPHIC)
		const re = new RegExp(`[${Object.keys(map).join("")}]`, "g")
		normalized = normalized.replace(re, (ch) => map[ch] ?? ch)
	}

	// Normalize whitespace
	if (opts.extraWhitespace) {
		normalized = normalized.replace(/\s+/g, " ")
	}

	// Trim whitespace
	if (opts.trim) {
		normalized = normalized.trim()
	}

	return normalized
}

/**
 * Unescapes common HTML entities in a string
 *
 * @param text The string containing HTML entities to unescape
 * @returns The unescaped string with HTML entities converted to their literal characters
 */
const HTML_ENTITIES: Record<string, string> = {
	"&amp;": "&",
	"&lt;": "<",
	"&gt;": ">",
	"&quot;": '"',
	"&#39;": "'",
	"&#x27;": "'",
	"&apos;": "'",
	"&nbsp;": " ",
	"&#x2F;": "/",
	"&#91;": "[",
	"&#93;": "]",
	"&lsqb;": "[",
	"&rsqb;": "]",
	"&#x60;": "`",
	"&#96;": "`",
}

export function unescapeHtmlEntities(text: string): string {
	if (!text) return text
	return text.replace(/&(?:#[xX]?[\da-fA-F]+|\w+);/g, (match) => HTML_ENTITIES[match] ?? match)
}
