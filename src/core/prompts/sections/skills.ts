import type { SkillsManager } from "../../../services/skills/SkillsManager"

type SkillsManagerLike = Pick<SkillsManager, "getSkillsForMode">

const CANGJIE_CJPM_SKILL = "cangjie-cjpm"
const CANGJIE_SKILLS_PLAN_SKILL = "skills-enhancement-plan"

function selectCangjieScenarioSkills(triggerText: string | undefined): Set<string> {
	const selected = new Set<string>()
	const text = (triggerText ?? "").toLowerCase()
	// Keyword regex for user-intent matching — Chinese keywords intentionally included
	// to match Cangjie compiler error output and provide context to the LLM.
	if (
		/\bcjpm\b|\bcjc\b|\bcjfmt\b|\bcjlint\b|\bcjdb\b|\bcjprof\b|build|compile|run|test|package|workspace|toml|构建|编译|运行|测试|包|工作区/.test(
			text,
		)
	) {
		selected.add(CANGJIE_CJPM_SKILL)
	}
	if (/skill|能力|技能|学习|规划|评估|训练|提升|plan|learn|evaluation|framework/.test(text)) {
		selected.add(CANGJIE_SKILLS_PLAN_SKILL)
	}
	return selected
}

/**
 * Drop markdown table rows in Cangjie mode custom instructions that cite skills not present in the workspace.
 * Matches cells like **`skill-name`** in `| ... | ... |` rows.
 */
export function filterCangjieSkillRoutingRows(markdown: string, discoveredSkillNames: Set<string>): string {
	const lines = markdown.split("\n")
	const out: string[] = []
	for (const line of lines) {
		if (line.includes("|") && line.includes("**`")) {
			const m = line.match(/\*\*`([^`]+)`\*\*/)
			if (m) {
				const id = m[1]!.trim()
				if (!discoveredSkillNames.has(id)) continue
			}
		}
		out.push(line)
	}
	return out.join("\n")
}

/**
 * Generate the skills section for the system prompt.
 * Only includes skills relevant to the current mode.
 * Format matches the modes section style.
 *
 * @param skillsManager - The SkillsManager instance
 * @param currentMode - The current mode slug (e.g., 'code', 'architect')
 */
// eslint-disable-next-line @typescript-eslint/require-await
export async function getSkillsSection(
	skillsManager: SkillsManagerLike | undefined,
	currentMode: string | undefined,
	triggerText?: string,
): Promise<string> {
	if (!skillsManager || !currentMode) return ""

	// Get skills filtered by current mode (with override resolution)
	let skills = skillsManager.getSkillsForMode(currentMode)
	if (currentMode === "cangjie") {
		const selected = selectCangjieScenarioSkills(triggerText)
		skills = skills.filter((skill) => {
			if (skill.name === CANGJIE_CJPM_SKILL || skill.name === CANGJIE_SKILLS_PLAN_SKILL) {
				return selected.has(skill.name)
			}
			return true
		})
	}
	if (skills.length === 0) return ""

	const skillsListing = skills
		.map((skill) => {
			return `### ${skill.name}\n- **Description:** ${skill.description}\n- **Location:** ${skill.path}`
		})
		.join("\n\n")

	const cangjieTieBreakNote = ""

	return `====

## Available Skills

${skillsListing}

## Mandatory Skill Check

REQUIRED PRECONDITION

Before producing ANY user-facing response, you MUST perform a skill applicability check.

Step 1: Skill Evaluation
- Evaluate the user's request against ALL available skill descriptions above.
- Determine whether at least one skill clearly and unambiguously applies.

Step 2: Branching Decision

### When A Skill Applies
- Select EXACTLY ONE skill per turn.
- Disambiguation: when multiple skills match, pick the one whose description most precisely covers the user's primary intent. If the mode's customInstructions contain a skill routing table, follow it.
- Cross-turn loading: if the request spans two skills, load the highest-priority one now and note the secondary skill for a follow-up turn.
- Use the skill tool to load the selected skill by name.
- Load the skill's instructions fully into context BEFORE continuing.
- Follow the skill instructions precisely.
- Do NOT respond outside the skill-defined flow.

### When No Skill Applies
- Proceed with a normal response.
- Do NOT load any SKILL.md files.

CONSTRAINTS:
- Do NOT load every skill up front.
- Load skills ONLY after a skill is selected.
- Do NOT reload a skill whose instructions already appear in this conversation.
- Do NOT skip this check.
- FAILURE to perform this check is an error.

## Linked File Handling
- When a skill is loaded, ONLY the skill instructions are present.
- Files linked from the skill are NOT loaded automatically.
- The model MUST explicitly decide to read a linked file based on task relevance.
- Do NOT assume the contents of linked files unless they have been explicitly read.
- Prefer reading the minimum necessary linked file.
- Avoid reading multiple linked files unless required.
- Treat linked files as progressive disclosure, not mandatory context.

## Context Notes
- The skill list is already filtered for the current mode: "${currentMode}".
- Mode-specific skills may come from skills-${currentMode}/ with project-level overrides taking precedence over global skills.${cangjieTieBreakNote}

## Internal Verification
This section is for internal control only.
Do NOT include this section in user-facing output.

After completing the evaluation, internally confirm: \`skill_check_completed: true | false\`
`
}
