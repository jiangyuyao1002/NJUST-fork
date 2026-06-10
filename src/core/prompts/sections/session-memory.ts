/**
 * Session Memory Prompt Section
 *
 * Injects previous session summaries into the system prompt,
 * enabling new sessions to inherit prior work context.
 */
import { loadSessionMemories, formatSessionMemoriesForPrompt } from "../../condense/sessionMemoryCompact"

/**
 * Build a prompt section containing summaries of recent work sessions.
 *
 * @param workspaceDir - The workspace root directory
 * @param tokenBudget - Maximum token budget for the section (default: 3000)
 * @returns Formatted prompt section string, or empty string if no memories exist
 */
export async function getSessionMemorySection(workspaceDir: string, tokenBudget: number = 3000): Promise<string> {
	const memories = await loadSessionMemories(workspaceDir, 3)
	if (memories.length === 0) return ""

	return (
		`\n\n## Previous Session Context\n\n` +
		`The following is a summary of recent work sessions in this workspace:\n\n` +
		formatSessionMemoriesForPrompt(memories, tokenBudget)
	)
}
