import { isLanguage } from "@njust-ai/types"

import type { SystemPromptSettings } from "../types"

import { LANGUAGES } from "../../../shared/language"

import { loadModeRules, loadGenericRules, loadAgentRulesIfEnabled, loadLearnedFixes } from "../services/RuleFileManager"

export async function addCustomInstructions(
	modeCustomInstructions: string,
	globalCustomInstructions: string,
	cwd: string,
	mode: string,
	options: {
		language?: string
		rooIgnoreInstructions?: string
		settings?: SystemPromptSettings
	} = {},
): Promise<string> {
	const sections = []

	// Get the enableSubfolderRules setting (default: false)
	const enableSubfolderRules = options.settings?.enableSubfolderRules ?? false

	// Load mode-specific rules if mode is provided
	let modeRuleContent = ""
	let usedRuleFile = ""

	if (mode) {
		const modeRules = await loadModeRules(cwd, mode, enableSubfolderRules)
		modeRuleContent = modeRules.modeRuleContent
		usedRuleFile = modeRules.usedRuleFile
	}

	// Add language preference if provided
	if (options.language) {
		const extraLanguageNames: Record<string, string> = {
			es: "Español",
		}
		const languageName = isLanguage(options.language)
			? LANGUAGES[options.language]
			: (extraLanguageNames[options.language] ?? options.language)
		sections.push(
			`Language Preference:\nYou should always speak and think in the "${languageName}" (${options.language}) language unless the user gives you instructions below to do otherwise.`,
		)
	}

	// Add global instructions first
	if (typeof globalCustomInstructions === "string" && globalCustomInstructions.trim()) {
		sections.push(`Global Instructions:\n${globalCustomInstructions.trim()}`)
	}

	// Add mode-specific instructions after
	if (typeof modeCustomInstructions === "string" && modeCustomInstructions.trim()) {
		sections.push(`Mode-specific Instructions:\n${modeCustomInstructions.trim()}`)
	}

	// Add rules - include both mode-specific and generic rules if they exist
	const rules = []

	// Add mode-specific rules first if they exist
	if (modeRuleContent?.trim()) {
		if (usedRuleFile.endsWith("directories")) {
			rules.push(modeRuleContent.trim())
		} else {
			rules.push(`# Rules from ${usedRuleFile}:\n${modeRuleContent}`)
		}
	}

	if (options.rooIgnoreInstructions) {
		rules.push(options.rooIgnoreInstructions)
	}

	// Add AGENTS.md content if enabled (default: true)
	// Load from root and optionally subdirectories with .njust_ai folders based on enableSubfolderRules setting
	if (options.settings?.useAgentRules !== false) {
		const agentRulesContent = await loadAgentRulesIfEnabled(cwd, enableSubfolderRules, true)
		if (agentRulesContent) {
			rules.push(agentRulesContent)
		}
	}

	// Add generic rules
	const genericRuleContent = await loadGenericRules(cwd, enableSubfolderRules)
	if (genericRuleContent) {
		rules.push(genericRuleContent)
	}

	if (rules.length > 0) {
		sections.push(`Rules:\n\n${rules.join("\n\n")}`)
	}

	// Load learned fixes for the current mode (accumulated error-fix patterns from past sessions)
	if (mode) {
		const learnedFixes = await loadLearnedFixes(cwd, mode)
		if (learnedFixes?.trim()) {
			sections.push(
				`Learned Fixes (accumulated error-fix patterns from past sessions — reference these to avoid repeating known mistakes):\n\n${learnedFixes.trim()}`,
			)
		}
	}

	const joinedSections = sections.join("\n\n")

	return joinedSections
		? `
====

USER'S CUSTOM INSTRUCTIONS

The following additional instructions are provided by the user, and should be followed to the best of your ability.

${joinedSections}
`
		: ""
}

// Re-export for backward compatibility with existing tests
export { loadRuleFiles } from "../services/RuleFileManager"
