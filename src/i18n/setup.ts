import * as fs from "fs/promises"
import * as path from "path"
import * as vscode from "vscode"
import i18next from "i18next"
import { logger } from "../shared/logger"

// Build translations object
const translations: Record<string, Record<string, UnsafeAny>> = {}

// Determine if running in test environment
const isTestEnv = process.env.NODE_ENV === "test"

/**
 * Asynchronously load all translation files from the locales directory.
 * Replaces the previous synchronous fs.readdirSync/readFileSync calls
 * to avoid blocking the extension host main thread during activation.
 */
async function loadTranslations(): Promise<void> {
	if (isTestEnv) {
		return
	}

	try {
		const localesDir = path.join(__dirname, "i18n", "locales")

		try {
			// Find all language directories
			const languageDirs = await fs.readdir(localesDir, { withFileTypes: true })

			const languages = languageDirs
				.filter(
					(dirent: { isDirectory: () => boolean; name: string }) =>
						dirent.isDirectory() && !dirent.name.startsWith("."),
				)
				.map((dirent: { name: string }) => dirent.name)

			// Process each language
			await Promise.all(
				languages.map(async (language: string) => {
					const langPath = path.join(localesDir, language)

					// Find all JSON files in the language directory
					const files = await fs.readdir(langPath, { withFileTypes: true })
					const jsonFiles = files
						.filter(
							(dirent: { isFile: () => boolean; name: string }) =>
								dirent.isFile() && dirent.name.endsWith(".json") && !dirent.name.startsWith("."),
						)
						.map((dirent: { name: string }) => dirent.name)

					// Initialize language in translations object
					if (!translations[language]) {
						translations[language] = {}
					}

					// Process each namespace file
					await Promise.all(
						jsonFiles.map(async (file: string) => {
							const namespace = path.basename(file, ".json")
							const filePath = path.join(langPath, file)

							try {
								// Read and parse the JSON file asynchronously
								const content = await fs.readFile(filePath, "utf8")
								translations[language]![namespace] = JSON.parse(content)
							} catch (error) {
								logger.error("i18n", `Error loading translation file ${filePath}:`, error)
								// Notify user that translations may be incomplete
								// eslint-disable-next-line @typescript-eslint/prefer-optional-chain
								if (typeof vscode !== "undefined" && vscode.window) {
									vscode.window.showWarningMessage(
										`Failed to load translation: ${path.basename(filePath)}. Falling back to English for this namespace.`,
									)
								}
							}
						}),
					)
				}),
			)

			logger.info("i18n", `Loaded translations for languages: ${Object.keys(translations).join(", ")}`)
		} catch (dirError) {
			logger.error("i18n", `Error processing directory ${localesDir}:`, dirError)
		}
	} catch (error) {
		logger.error("i18n", "Error loading translations:", error)
	}
}

// Start loading translations immediately; callers should await `translationsReady` before use
const translationsReady: Promise<void> = loadTranslations()

// Initialize i18next with configuration
const isDevMode = process.env.NODE_ENV === "development"

void translationsReady.then(() =>
	i18next.init({
		lng: "en",
		fallbackLng: "en",
		debug: false,
		resources: translations,
		parseMissingKeyHandler: isDevMode ? (key: string) => `[MISSING] ${key}` : undefined,
		interpolation: {
			escapeValue: false,
		},
	}),
)

export { translationsReady }
export default i18next
