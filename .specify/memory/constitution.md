# NJUST_AI Constitution

## Core Principles

### I. Extension-First Architecture
All features serve the VS Code extension as the primary product surface. Shared logic lives in `packages/`, the extension core in `src/`, and the React webview in `webview-ui/`. Changes must respect the monorepo boundary: never introduce circular dependencies between packages.

### II. Provider Abstraction
AI provider integrations (`src/api/providers/`) must be stateless and conform to the unified provider interface. Adding a new model or provider must not require changes to the core task loop or UI layer.

### III. Multi-Language Support
The extension supports multiple programming languages with first-class Cangjie (`.cj`) language support. Language-specific features (LSP, formatters, linters) are encapsulated in `src/services/` and must not leak into generic extension code.

### IV. Spec-Driven Development
Significant features and architectural changes must follow the Specify -> Plan -> Tasks -> Implement workflow. Specifications live in `.specify/specs/` and serve as the source of truth for what gets built. Specs capture user intent; plans capture technical decisions; tasks capture actionable work items.

### V. Quality Gates
- TypeScript strict mode is enforced across all packages
- ESLint and Prettier formatting are mandatory (pnpm lint / pnpm format)
- Vitest is the test framework; tests live alongside source files
- Pre-commit hooks validate linting and type checking

## Technology Stack

- **Runtime**: Node.js 20.19.2, pnpm 10.8.1
- **Build**: Turbo for monorepo orchestration, esbuild for extension bundling, Vite for webview
- **Language**: TypeScript (strict), React for webview UI
- **Extension**: VS Code API ^1.93.0
- **Cangjie Toolchain**: cjpm, cjc, cjfmt, cjlint, cjdb

## Development Workflow

- Use Architect mode for planning (auto-follows Specify -> Plan -> Tasks)
- Use Code / Cangjie Dev mode for implementation (auto-reads task lists)
- Slash commands `/speckit.*` available for manual phase control
- All specs and plans are living documents -- update them as requirements evolve
- The SettingsView pattern (AGENTS.md) must be followed: inputs bind to `cachedState`, not live state

## Governance

This constitution guides AI agents and human developers working in this repository. Amendments require team review and documentation. The constitution is referenced automatically during the Plan phase to validate technical decisions.

**Version**: 1.0.0 | **Ratified**: 2026-03-23 | **Last Amended**: 2026-03-23
