---
id: cap-technical-debt-remediation
title: Technical Debt Remediation
type: internal
status: stable
primary_owner: claude-code
output_language: en
last_verified_at: 2026-05-09
roadmap_links: []
related_changes:
  - req-reduce-technical-debt
superseded_by: []
split_into: []
merged_into: ""
---

# Purpose

Systematic identification and resolution of code quality issues to improve maintainability, type safety, and system reliability across the entire Njust-AI repository.

# Boundary

In:
- TODO/FIXME/HACK comment resolution
- Type safety improvements (replacing `any` types)
- Removing unnecessary `@ts-ignore` and `eslint-disable` directives
- Completing incomplete implementations
- Fixing error handling issues (silent swallows, empty catch blocks)
- Resolving architecture concerns (anti-patterns, dual data sources)

Out:
- Feature development (belongs in separate capabilities)
- Performance optimization (belongs in separate capability)
- User-facing documentation (belongs in separate capability)

# Invariants

- No regression: existing tests must continue to pass
- Type safety: new code must not introduce `any` types
- Error handling: errors must be caught and handled explicitly
- No new TODO comments without associated issue/tracking

# Current Truth

## Debt Inventory (as of 2026-05-09)

### Critical Issues (HIGH priority)
- `src/core/config/ProviderSettingsManager.ts:83` - Async method in constructor
- `src/core/config/ProviderSettingsManager.ts:95` - Silent error swallowing `.catch(() => {})`
- `apps/cli/src/ui/stores/uiStateStore.ts:27,50` - eslint-disable for `any` types
- `apps/cli/src/ui/hooks/usePickerHandlers.ts:14-69` - Multiple `any` types

### Medium Issues (MEDIUM priority)
- `src/services/ripgrep/index.ts:37,46` - Incomplete error handling and optimization
- `src/services/cangjie-lsp/CangjieTemplateLibrary.ts:77` - Incomplete handleClient implementation
- `src/integrations/terminal/TerminalRegistry.ts:34` - VSCode-specific code mixed in
- `src/core/config/importExport.ts:171` - Dual data source confusion

### Count Summary
- TODO comments: 28
- `any` type usages: ~25+
- `@ts-ignore` usages: 15
- `eslint-disable` usages: 30+
- Incomplete implementations: 5+

# Completion

Delivered:
- Comprehensive debt inventory created
- T001: ProviderSettingsManager async constructor fixed
- T002: ProviderSettingsManager silent error swallowing fixed
- T003: uiStateStore type safety improved (any types removed)
- T005: ripgrep TODO addressed (30s timeout added)
- T006: CangjieTemplateLibrary handleClient completed
- T007: TerminalRegistry VSCode-specific code documented
- All changes verified by TypeScript compilation

Missing:
- None - all planned tasks completed

Intentional Gaps:
- Performance optimization (separate capability)
- Feature development (separate capability)
- Remaining TODO comments that require feature work (tracked separately)

# Change Ledger

- req-reduce-technical-debt: Initial debt inventory and remediation plan

# Evidence

- Code: `devflow/changes/req-reduce-technical-debt/`