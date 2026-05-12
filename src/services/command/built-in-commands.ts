import { Command } from "./commands"

interface BuiltInCommandDefinition {
	name: string
	description: string
	argumentHint?: string
	content: string
}

const BUILT_IN_COMMANDS: Record<string, BuiltInCommandDefinition> = {
	"speckit-init": {
		name: "speckit-init",
		description: "Initialize Spec Kit in the current workspace",
		content: `<task>
Initialize Spec Kit spec-driven development workflow in the current workspace.
</task>

<steps>
1. Check if \`.specify/\` directory already exists in the workspace root.
   - If it exists, inform the user that Spec Kit is already initialized and show a summary of the current state.
   - If not, proceed with initialization.

2. Try to run \`specify init <project-name> --ai roo --script ps\` (where project-name is derived from the workspace folder name).
   - If the \`specify\` CLI is available, run it and handle the output.
   - If the CLI is not available, create the directory structure manually (see step 3).

3. Manual initialization (fallback when CLI is unavailable):
   Create the following directory structure:
   \`\`\`
   .specify/
   ├── memory/
   │   └── constitution.md    (project principles template)
   ├── scripts/               (empty, for future shell scripts)
   ├── templates/
   │   ├── spec-template.md   (feature spec template)
   │   ├── plan-template.md   (technical plan template)
   │   └── tasks-template.md  (task breakdown template)
   ├── specs/                  (where feature specs will be stored)
   └── init-options.json       ({"branch_numbering": "sequential", "script": "ps"})
   \`\`\`

4. Create reasonable default templates:
   - spec-template.md: sections for User Stories (P1/P2/P3), Functional Requirements, Key Entities, Success Criteria, Edge Cases
   - plan-template.md: sections for Technical Context, Architecture, Data Model, API Contracts
   - tasks-template.md: sections for phased task checklist with TaskID, Priority, and file paths

5. Inform the user that Spec Kit is ready and suggest using the Architect mode for their next feature.
</steps>`,
	},
	"speckit.specify": {
		name: "speckit.specify",
		description: "Create a feature specification from requirements",
		argumentHint: "<feature description>",
		content: `<task>
Create a feature specification (spec.md) based on the user's description.
</task>

<steps>
1. Determine the storage location:
   - If \`.specify/\` exists: create a new feature directory under \`.specify/specs/NNN-feature-name/\`
   - If not: use \`/plans/\` directory

2. If \`.specify/templates/spec-template.md\` exists, use it as the template. Otherwise use the default structure.

3. Generate spec.md containing:
   - **User Stories**: Prioritized (P1 = must-have, P2 = should-have, P3 = nice-to-have)
   - **Functional Requirements**: Numbered, specific, testable
   - **Key Entities**: Core data structures and their relationships
   - **Success Criteria**: Measurable outcomes
   - **Edge Cases**: Boundary conditions and error scenarios

4. Mark uncertain items as [NEEDS CLARIFICATION] and ask the user to resolve them (max 3-5 questions).

5. If \`.specify/memory/constitution.md\` exists, validate the spec against project principles.

6. Present the spec to the user for review and suggest running /speckit.plan next.
</steps>`,
	},
	"speckit.plan": {
		name: "speckit.plan",
		description: "Create a technical implementation plan from a specification",
		content: `<task>
Create a technical implementation plan (plan.md) based on an existing spec.md.
</task>

<steps>
1. Locate the active spec:
   - Check \`.specify/specs/\` for the most recent feature spec
   - If not found, check \`/plans/\` for spec.md
   - If no spec exists, inform the user and suggest running /speckit.specify first

2. If \`.specify/templates/plan-template.md\` exists, use it as the template.

3. Generate plan.md containing:
   - **Technical Context**: Relevant codebase areas, existing patterns to follow
   - **Architecture Design**: Component structure, data flow, integration points
   - **Data Model**: Entities, fields, relationships, migrations if needed
   - **API/Interface Contracts**: Endpoints, function signatures, type definitions
   - **Dependencies**: External libraries, internal packages to leverage
   - **Risk Assessment**: Technical risks and mitigation strategies

4. If \`.specify/memory/constitution.md\` exists, verify the plan complies with project principles. Flag any violations.

5. Present the plan to the user for review and suggest running /speckit.tasks next.
</steps>`,
	},
	"speckit.tasks": {
		name: "speckit.tasks",
		description: "Generate actionable task breakdown from a plan",
		content: `<task>
Generate an actionable task breakdown (tasks.md) based on spec.md and plan.md.
</task>

<steps>
1. Locate the active spec and plan:
   - Check \`.specify/specs/\` for the most recent feature directory
   - If not found, check \`/plans/\` for spec.md and plan.md
   - If plan.md doesn't exist, inform the user and suggest running /speckit.plan first

2. If \`.specify/templates/tasks-template.md\` exists, use it as the template.

3. Generate tasks.md with phased task breakdown:
   - **Phase 1 - Setup**: Project initialization, dependencies, configuration
   - **Phase 2 - Foundation**: Core data structures, base interfaces, utilities
   - **Phase 3+ - Features**: One phase per user story (P1 first, then P2, P3)
   - **Final Phase - Polish**: Cross-cutting concerns, documentation, cleanup

4. Each task must follow the format:
   \`- [ ] [T-NNN] [P1/P2/P3] Description (file: path/to/file.ts)\`

5. Include a dependency graph showing which tasks block others.

6. Present the task list to the user and suggest switching to Code or Cangjie Dev mode for implementation.
</steps>`,
	},
	"speckit.implement": {
		name: "speckit.implement",
		description: "Execute implementation following the task checklist",
		content: `<task>
Implement the feature by executing tasks from the task checklist.
</task>

<steps>
1. Locate the active tasks.md:
   - Check \`.specify/specs/\` for the most recent feature's tasks.md
   - If not found, check \`/plans/\` for tasks.md
   - If no tasks exist, inform the user and suggest running /speckit.tasks first

2. Parse the task checklist and identify incomplete items (unchecked \`[ ]\`).

3. Execute tasks in order, respecting the dependency graph:
   - For each task: implement the code change, run relevant tests
   - After completing a task, mark it \`[X]\` in tasks.md
   - If a task fails or needs clarification, pause and ask the user

4. If \`.specify/memory/constitution.md\` exists, ensure implementation follows project principles.

5. After all tasks are complete, provide a summary of what was implemented and suggest running /speckit.analyze for validation.
</steps>`,
	},
	"speckit.analyze": {
		name: "speckit.analyze",
		description: "Cross-artifact consistency and coverage analysis",
		content: `<task>
Analyze spec.md, plan.md, and tasks.md for consistency, coverage, and quality.
</task>

<steps>
1. Locate the active spec artifacts:
   - Check \`.specify/specs/\` for the most recent feature directory
   - If not found, check \`/plans/\`

2. Perform cross-artifact analysis:
   - **Coverage**: Every requirement in spec.md should have corresponding tasks
   - **Consistency**: plan.md architecture should align with task implementations
   - **Orphans**: Tasks without matching requirements, or requirements without tasks
   - **Terminology**: Consistent naming across all three documents
   - **Completeness**: No [NEEDS CLARIFICATION] items remaining unresolved

3. If \`.specify/memory/constitution.md\` exists, check for principle violations.

4. Output a findings table with severity levels (CRITICAL / HIGH / MEDIUM / LOW):
   - CRITICAL: Constitution violations, missing requirements coverage
   - HIGH: Inconsistencies between spec and plan
   - MEDIUM: Orphaned tasks, terminology drift
   - LOW: Style and formatting issues

5. Provide actionable recommendations for resolving each finding.
</steps>`,
	},
	init: {
		name: "init",
		description: "Analyze codebase and create concise AGENTS.md files for AI assistants",
		content: `<task>
Please analyze this codebase and create an AGENTS.md file containing:
1. Build/lint/test commands - especially for running a single test
2. Code style guidelines including imports, formatting, types, naming conventions, error handling, etc.
</task>

<initialization>
  <purpose>
    Create (or update) a concise AGENTS.md file that enables immediate productivity for AI assistants.
    Focus ONLY on project-specific, non-obvious information that you had to discover by reading files.
    
    CRITICAL: Only include information that is:
    - Non-obvious (couldn't be guessed from standard practices)
    - Project-specific (not generic to the framework/language)
    - Discovered by reading files (config files, code patterns, custom utilities)
    - Essential for avoiding mistakes or following project conventions
    
    Usage notes:
    - The file you create will be given to agentic coding agents (such as yourself) that operate in this repository
    - Keep the main AGENTS.md concise - aim for about 20 lines, but use more if the project complexity requires it
    - If there's already an AGENTS.md, improve it
    - If there are Claude Code rules (in CLAUDE.md), Cursor rules (in .cursor/rules/ or .cursorrules), or Copilot rules (in .github/copilot-instructions.md), make sure to include them
    - Be sure to prefix the file with: "# AGENTS.md\\n\\nThis file provides guidance to agents when working with code in this repository."
  </purpose>
  
  <todo_list_creation>
    If the update_todo_list tool is available, create a todo list with these focused analysis steps:
    
    1. Check for existing AGENTS.md files
       CRITICAL - Check these EXACT paths IN THE PROJECT ROOT:
       - AGENTS.md (in project root directory)
       - .njust_ai/rules-code/AGENTS.md (relative to project root)
       - .njust_ai/rules-debug/AGENTS.md (relative to project root)
       - .njust_ai/rules-ask/AGENTS.md (relative to project root)
       - .njust_ai/rules-architect/AGENTS.md (relative to project root)
       
       IMPORTANT: All paths are relative to the project/workspace root, NOT system root!
       
       If ANY of these exist:
       - Read them thoroughly
       - CRITICALLY EVALUATE: Remove ALL obvious information
       - DELETE entries that are standard practice or framework defaults
       - REMOVE anything that could be guessed without reading files
       - Only KEEP truly non-obvious, project-specific discoveries
       - Then add any new non-obvious patterns you discover
       
       Also check for other AI assistant rules:
       - .cursorrules, CLAUDE.md, .roorules
       - .cursor/rules/, .github/copilot-instructions.md
    
    2. Identify stack
       - Language, framework, build tools
       - Package manager and dependencies
    
    3. Extract commands
       - Build, test, lint, run
       - Critical directory-specific commands
    
    4. Map core architecture
       - Main components and flow
       - Key entry points
    
    5. Document critical patterns
       - Project-specific utilities (that you discovered by reading code)
       - Non-standard approaches (that differ from typical patterns)
       - Custom conventions (that aren't obvious from file structure)
    
    6. Extract code style
       - From config files only
       - Key conventions
    
    7. Testing specifics
       - Framework and run commands
       - Directory requirements
    
    8. Compile/Update AGENTS.md files
       - If files exist: AGGRESSIVELY clean them up
         * DELETE all obvious information (even if it was there before)
         * REMOVE standard practices, framework defaults, common patterns
         * STRIP OUT anything derivable from file structure or names
         * ONLY KEEP truly non-obvious discoveries
         * Then add newly discovered non-obvious patterns
         * Result should be SHORTER and MORE FOCUSED than before
       - If creating new: Follow the non-obvious-only principle
       - Create mode-specific files in .njust_ai/rules-*/ directories (IN PROJECT ROOT)
       
    Note: If update_todo_list is not available, proceed with the analysis workflow directly without creating a todo list.
  </todo_list_creation>
</initialization>

<analysis_workflow>
  Follow the comprehensive analysis workflow to:
  
  1. **Discovery Phase**:
     CRITICAL - First check for existing AGENTS.md files at these EXACT locations IN PROJECT ROOT:
     - AGENTS.md (in project/workspace root)
     - .njust_ai/rules-code/AGENTS.md (relative to project root)
     - .njust_ai/rules-debug/AGENTS.md (relative to project root)
     - .njust_ai/rules-ask/AGENTS.md (relative to project root)
     - .njust_ai/rules-architect/AGENTS.md (relative to project root)
     
     IMPORTANT: The .njust_ai folder should be created in the PROJECT ROOT, not system root!
     
     If found, perform CRITICAL analysis:
     - What information is OBVIOUS and must be DELETED?
     - What violates the non-obvious-only principle?
     - What would an experienced developer already know?
     - DELETE first, then consider what to add
     - The file should get SHORTER, not longer
     
     Also find other AI assistant rules and documentation
     
  2. **Project Identification**: Identify language, stack, and build system
  3. **Command Extraction**: Extract and verify essential commands
  4. **Architecture Mapping**: Create visual flow diagrams of core processes
  5. **Component Analysis**: Document key components and their interactions
  6. **Pattern Analysis**: Identify project-specific patterns and conventions
  7. **Code Style Extraction**: Extract formatting and naming conventions
  8. **Security & Performance**: Document critical patterns if relevant
  9. **Testing Discovery**: Understand testing setup and practices
  10. **Example Extraction**: Find real examples from the codebase
</analysis_workflow>

<output_structure>
  <main_file>
    Create or deeply improve AGENTS.md with ONLY non-obvious information:
    
    If AGENTS.md exists:
    - FIRST: Delete ALL obvious information
    - REMOVE: Standard commands, framework defaults, common patterns
    - STRIP: Anything that doesn't require file reading to know
    - EVALUATE: Each line - would an experienced dev be surprised?
    - If not surprised, DELETE IT
    - THEN: Add only truly non-obvious new discoveries
    - Goal: File should be SHORTER and MORE VALUABLE
    
    Content should include:
    - Header: "# AGENTS.md\\n\\nThis file provides guidance to agents when working with code in this repository."
    - Build/lint/test commands - ONLY if they differ from standard package.json scripts
    - Code style - ONLY project-specific rules not covered by linter configs
    - Custom utilities or patterns discovered by reading the code
    - Non-standard directory structures or file organizations
    - Project-specific conventions that violate typical practices
    - Critical gotchas that would cause errors if not followed
    
    EXCLUDE obvious information like:
    - Standard npm/yarn commands visible in package.json
    - Framework defaults (e.g., "React uses JSX")
    - Common patterns (e.g., "tests go in __tests__ folders")
    - Information derivable from file extensions or directory names
    
    Keep it concise (aim for ~20 lines, but expand as needed for complex projects).
    Include existing AI assistant rules from CLAUDE.md, Cursor rules (.cursor/rules/ or .cursorrules), or Copilot rules (.github/copilot-instructions.md).
  </main_file>
  
  <mode_specific_files>
    Create or deeply improve mode-specific AGENTS.md files IN THE PROJECT ROOT.
    
    CRITICAL: For each of these paths (RELATIVE TO PROJECT ROOT), check if the file exists FIRST:
    - .njust_ai/rules-code/AGENTS.md (create .roo in project root, not system root!)
    - .njust_ai/rules-debug/AGENTS.md (relative to project root)
    - .njust_ai/rules-ask/AGENTS.md (relative to project root)
    - .njust_ai/rules-architect/AGENTS.md (relative to project root)
    
    IMPORTANT: The .njust_ai directory must be created in the current project/workspace root directory,
    NOT at the system root (/) or home directory. All paths are relative to where the project is located.
    
    If files exist:
    - AGGRESSIVELY DELETE obvious information
    - Remove EVERYTHING that's standard practice
    - Strip out framework defaults and common patterns
    - Each remaining line must be surprising/non-obvious
    - Only then add new non-obvious discoveries
    - Files should become SHORTER, not longer
    
    Example structure (ALL IN PROJECT ROOT):
    \`\`\`
    project-root/
    ├── AGENTS.md                    # General project guidance
    ├── .njust_ai/                        # IN PROJECT ROOT, NOT SYSTEM ROOT!
    │   ├── rules-code/
    │   │   └── AGENTS.md           # Code mode specific instructions
    │   ├── rules-debug/
    │   │   └── AGENTS.md           # Debug mode specific instructions
    │   ├── rules-ask/
    │   │   └── AGENTS.md           # Ask mode specific instructions
    │   └── rules-architect/
    │       └── AGENTS.md           # Architect mode specific instructions
    ├── src/
    ├── package.json
    └── ... other project files
    \`\`\`
    
    .njust_ai/rules-code/AGENTS.md - ONLY non-obvious coding rules discovered by reading files:
    - Custom utilities that replace standard approaches
    - Non-standard patterns unique to this project
    - Hidden dependencies or coupling between components
    - Required import orders or naming conventions not enforced by linters
    
    Example of non-obvious rules worth documenting:
    \`\`\`
    # Project Coding Rules (Non-Obvious Only)
    - Always use safeWriteJson() from src/utils/ instead of JSON.stringify for file writes (prevents corruption)
    - API retry mechanism in src/api/providers/utils/ is mandatory (not optional as it appears)
    - Database queries MUST use the query builder in packages/evals/src/db/queries/ (raw SQL will fail)
    - Provider interface in packages/types/src/ has undocumented required methods
    - Test files must be in same directory as source for vitest to work (not in separate test folder)
    \`\`\`
    
    .njust_ai/rules-debug/AGENTS.md - ONLY non-obvious debugging discoveries:
    - Hidden log locations not mentioned in docs
    - Non-standard debugging tools or flags
    - Gotchas that cause silent failures
    - Required environment variables for debugging
    
    Example of non-obvious debug rules worth documenting:
    \`\`\`
    # Project Debug Rules (Non-Obvious Only)
    - Webview dev tools accessed via Command Palette > "Developer: Open Webview Developer Tools" (not F12)
    - IPC messages fail silently if not wrapped in try/catch in packages/ipc/src/
    - Production builds require NODE_ENV=production or certain features break without error
    - Database migrations must run from packages/evals/ directory, not root
    - Extension logs only visible in "Extension Host" output channel, not Debug Console
    \`\`\`
    
    .njust_ai/rules-ask/AGENTS.md - ONLY non-obvious documentation context:
    - Hidden or misnamed documentation
    - Counterintuitive code organization
    - Misleading folder names or structures
    - Important context not evident from file structure
    
    Example of non-obvious documentation rules worth documenting:
    \`\`\`
    # Project Documentation Rules (Non-Obvious Only)
    - "src/" contains VSCode extension code, not source for web apps (counterintuitive)
    - Provider examples in src/api/providers/ are the canonical reference (docs are outdated)
    - UI runs in VSCode webview with restrictions (no localStorage, limited APIs)
    - Package.json scripts must be run from specific directories, not root
    - Locales in root are for extension, webview-ui/src/i18n for UI (two separate systems)
    \`\`\`
    
    .njust_ai/rules-architect/AGENTS.md - ONLY non-obvious architectural constraints:
    - Hidden coupling between components
    - Undocumented architectural decisions
    - Non-standard patterns that must be followed
    - Performance bottlenecks discovered through investigation
    
    Example of non-obvious architecture rules worth documenting:
    \`\`\`
    # Project Architecture Rules (Non-Obvious Only)
    - Providers MUST be stateless - hidden caching layer assumes this
    - Webview and extension communicate through specific IPC channel patterns only
    - Database migrations cannot be rolled back - forward-only by design
    - React hooks required because external state libraries break webview isolation
    - Monorepo packages have circular dependency on types package (intentional)
    \`\`\`
  </mode_specific_files>
</output_structure>

<quality_criteria>
  - ONLY include non-obvious information discovered by reading files
  - Exclude anything that could be guessed from standard practices
  - Focus on gotchas, hidden requirements, and counterintuitive patterns
  - Include specific file paths when referencing custom utilities
  - Be extremely concise - if it's obvious, don't include it
  - Every line should prevent a potential mistake or confusion
  - Test: Would an experienced developer be surprised by this information?
  - If updating existing files: DELETE obvious info first, files should get SHORTER
  - Measure success: Is the file more concise and valuable than before?
</quality_criteria>

Remember: The goal is to create documentation that enables AI assistants to be immediately productive in this codebase, focusing on project-specific knowledge that isn't obvious from the code structure alone.`,
	},

	compact: {
		name: "compact",
		description: "Compress the current conversation to free up context window space",
		content: `<task>
Compress and summarize the current conversation history to free up context window space.

This command triggers an intelligent condensation of the conversation, preserving key decisions,
modified files, discovered patterns, and pending tasks while removing redundant content.
</task>

<instructions>
You are being asked to compact/condense the current conversation. Do the following:

1. Acknowledge that compaction has been requested
2. Summarize the key points of the conversation so far:
   - What files have been modified and why
   - What decisions were made
   - What tasks remain incomplete
   - Any important patterns or constraints discovered
3. Note that the system will automatically condense the conversation history after this response

Important: This is a user-initiated compaction request. The condensation engine will handle
the actual message history compression. Your role is to provide a clear summary of the current
state so that context is preserved even after compression.
</instructions>`,
	},
}

/**
 * Get all built-in commands as Command objects
 */
export async function getBuiltInCommands(): Promise<Command[]> {
	return Object.values(BUILT_IN_COMMANDS).map((cmd) => ({
		name: cmd.name,
		content: cmd.content,
		source: "built-in" as const,
		filePath: `<built-in:${cmd.name}>`,
		description: cmd.description,
		argumentHint: cmd.argumentHint,
	}))
}

/**
 * Get a specific built-in command by name
 */
export async function getBuiltInCommand(name: string): Promise<Command | undefined> {
	const cmd = BUILT_IN_COMMANDS[name]
	if (!cmd) return undefined

	return {
		name: cmd.name,
		content: cmd.content,
		source: "built-in" as const,
		filePath: `<built-in:${name}>`,
		description: cmd.description,
		argumentHint: cmd.argumentHint,
	}
}

/**
 * Get names of all built-in commands
 */
export async function getBuiltInCommandNames(): Promise<string[]> {
	return Object.keys(BUILT_IN_COMMANDS)
}
