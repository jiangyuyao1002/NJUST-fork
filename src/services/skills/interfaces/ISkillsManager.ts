import type * as vscode from "vscode"
import type { SkillMetadata, SkillContent } from "../../../shared/skills"
import type { ModeConfig } from "@njust-ai/types"

/**
 * Host interface required by SkillsManager.
 * Kept minimal to allow easy mocking in tests.
 */
export interface ISkillsManagerHost {
	readonly cwd?: string
	readonly context?: vscode.ExtensionContext
	readonly customModesManager?: {
		getCustomModes(): Promise<ModeConfig[]>
	}
}

/**
 * Public surface of SkillsManager.
 */
export interface ISkillsManager extends vscode.Disposable {
	initialize(): Promise<void>
	discoverSkills(): Promise<void>
	getSkill(name: string, source?: "global" | "project", mode?: string): SkillMetadata | undefined
	getAllSkills(): SkillMetadata[]
	getSkillsForMode(mode: string): SkillMetadata[]
	getSkillsMetadata(): SkillMetadata[]
	getSkillContent(name: string, currentMode?: string): Promise<SkillContent | null>
	preloadSkills(names: string[], currentMode?: string): Promise<Array<{ name: string; content: string }>>
	findSkillByNameAndSource(name: string, source: "global" | "project"): SkillMetadata | undefined
	createSkill(name: string, source: "global" | "project", description: string, modeSlugs?: string[]): Promise<string>
	deleteSkill(name: string, source: "global" | "project", mode?: string): Promise<void>
	moveSkill(
		name: string,
		source: "global" | "project",
		currentMode: string | undefined,
		newMode: string | undefined,
	): Promise<void>
	updateSkillModes(name: string, source: "global" | "project", newModeSlugs?: string[]): Promise<void>
}
