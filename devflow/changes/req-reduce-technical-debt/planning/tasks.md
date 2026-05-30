# TASKS - Technical Debt Remediation

## Plan Meta

- Requirement version: req-reduce-technical-debt.v1
- Design version: design.v1
- CC-Plan skill version: 3.7.6
- Output language: en
- Source roadmap item: None (direct requirement)
- Source roadmap version: N/A
- Roadmap sync status: No source RM
- Change meta: `devflow/changes/req-reduce-technical-debt/change-meta.json`

## Execution Handoff

- Canonical design: `devflow/changes/req-reduce-technical-debt/planning/design.md`
- Canonical change meta: `devflow/changes/req-reduce-technical-debt/change-meta.json`
- Execution mode: `single-path`
- Frozen decisions:
  - Fix in priority order (HIGH -> MEDIUM -> LOW)
  - Verify after each fix (tsc, lint, tests)
  - Each fix must be self-contained and minimal
- Capability specs: `devflow/specs/capabilities/technical-debt-remediation.md`
- Canonical language / terms: Technical debt, type safety, error handling, TODO comments
- PRD brief:
  - Problem statement: Codebase has accumulated technical debt reducing maintainability
  - Solution summary: Systematically resolve code quality issues in priority order
  - User stories covered: US-001 (type safety), US-002 (error handling)
  - Implementation decisions: Priority-ordered fixes, verify after each
  - Testing decisions: Run tsc, lint, tests after each fix
  - Out of scope: Feature development, performance optimization, user-facing docs
- Ambiguity gate: pass
- Source trust boundary: N/A (direct requirement)
- External conflicts: none
- Review loop: completed
- Read first: `devflow/specs/capabilities/technical-debt-remediation.md`, `planning/design.md`
- Commands to trust: `npx tsc --noEmit`, `npm run lint`, `npm test`
- Test framework source: Existing vitest setup (see CLAUDE.md)
- Test seam policy: N/A (refactoring, not new feature)
- Mock boundary policy: N/A
- Test shape policy: N/A
- Feedback loop ladder: automated test -> tsc -> lint
- TDD plan: Not applicable (refactoring existing code, not new feature)
- Tracer bullet plan: One fix at a time, verify each
- TDD exceptions: Refactoring existing code - verify via existing tests and compiler
- Regression tests: Required - all existing tests must pass after each fix
- Do not re-decide: Priority order, verification commands
- Parallel boundaries: Sequential - each fix should be verified before moving to next

## Implementation Surface Map

| Surface | Responsibility | Tasks | Coupling risk |
|---------|----------------|-------|---------------|
| ProviderSettingsManager | Fix async constructor, error handling | T001, T002 | Low - isolated file |
| CLI UI type safety | Remove any types, add proper interfaces | T003, T004 | Low - isolated files |
| ripgrep service | Complete error handling implementation | T005 | Low - isolated file |
| cangjie-lsp service | Complete handleClient implementation | T006 | Low - isolated file |
| TerminalRegistry | Extract VSCode-specific code | T007 | Low - isolated file |
| importExport config | Clarify data source responsibility | T008 | Low - isolated file |
| web-Njust-AI stats | Remove any types | T009 | Low - isolated file |
| TODO comments | Resolve in priority order | T010 | Low - various files |

## Tracer Bullet Map

| Slice | Observable behavior | Test approach | Verification |
|-------|---------------------|---------------|--------------|
| Slice 1 | ProviderSettingsManager async constructor fixed | Run tsc, verify no new errors | `npx tsc --noEmit` |
| Slice 2 | ProviderSettingsManager silent error swallowing fixed | Run tsc, verify no new errors | `npx tsc --noEmit` |
| Slice 3 | CLI UI type safety improved | Run tsc, lint, verify no errors | `npx tsc --noEmit && npm run lint` |
| Slice 4 | ripgrep error handling complete | Run tests, verify behavior | `npm test -- src/services/ripgrep` |
| Slice 5 | cangjie-lsp handleClient complete | Run tests, verify behavior | `npm test -- src/services/cangjie-lsp` |
| Slice 6 | TerminalRegistry VSCode code extracted | Run tsc, verify no errors | `npx tsc --noEmit` |
| Slice 7 | importExport data source clarified | Run tsc, verify no errors | `npx tsc --noEmit` |
| Slice 8 | web-Njust-AI type safety improved | Run tsc, verify no errors | `npx tsc --noEmit` |
| Slice 9 | TODO comments resolved | Run tsc, lint, tests | Full verification suite |

## Phase 1: HIGH Priority - ProviderSettingsManager

- [ ] T001 [IMPL] Fix async constructor in ProviderSettingsManager (dependsOn: none) `src/core/config/ProviderSettingsManager.ts`
  Goal: Remove async method from constructor, extract to separate initialization method.
  Files: `src/core/config/ProviderSettingsManager.ts`
  Read first: `design.md`, current ProviderSettingsManager.ts
  Verification: `npx tsc --noEmit`
  Evidence: TypeScript compilation passes, no regression in existing behavior
  Completion: Async initialization moved to separate method, constructor is sync

- [ ] T002 [IMPL] Fix silent error swallowing in ProviderSettingsManager (dependsOn: T001) `src/core/config/ProviderSettingsManager.ts`
  Goal: Replace `.catch(() => {})` with proper error logging and handling.
  Files: `src/core/config/ProviderSettingsManager.ts`
  Read first: `design.md`, T001 output
  Verification: `npx tsc --noEmit && npm run lint`
  Evidence: Errors are now logged, not silently swallowed
  Completion: All catch blocks handle errors appropriately

## Phase 2: HIGH Priority - CLI UI Type Safety

- [ ] T003 [IMPL] Fix type safety in uiStateStore (dependsOn: T002) `apps/cli/src/ui/stores/uiStateStore.ts`
  Goal: Remove eslint-disable for any types, add proper TypeScript interfaces.
  Files: `apps/cli/src/ui/stores/uiStateStore.ts`
  Read first: `design.md`
  Verification: `npx tsc --noEmit`
  Evidence: No more `any` types without explicit disable
  Completion: All types properly defined

- [ ] T004 [IMPL] Fix type safety in usePickerHandlers (dependsOn: T003) `apps/cli/src/ui/hooks/usePickerHandlers.ts`
  Goal: Remove any types, add proper interfaces for all parameters and return values.
  Files: `apps/cli/src/ui/hooks/usePickerHandlers.ts`
  Read first: `design.md`
  Verification: `npx tsc --noEmit`
  Evidence: No more `any` types in this file
  Completion: All types properly defined

## Phase 3: MEDIUM Priority - Incomplete Implementations

- [ ] T005 [IMPL] Complete error handling in ripgrep (dependsOn: T004) `src/services/ripgrep/index.ts`
  Goal: Implement proper error handling at line 37, add optimization at line 46 or remove TODO if not needed.
  Files: `src/services/ripgrep/index.ts`
  Read first: `design.md`, current ripgrep/index.ts
  Verification: `npm test -- src/services/ripgrep`
  Evidence: Error handling is now implemented or TODO is resolved appropriately
  Completion: Error handling implemented OR TODO justified with comment

- [ ] T006 [IMPL] Complete handleClient in CangjieTemplateLibrary (dependsOn: T005) `src/services/cangjie-lsp/CangjieTemplateLibrary.ts`
  Goal: Complete the incomplete handleClient implementation or properly handle the socket.
  Files: `src/services/cangjie-lsp/CangjieTemplateLibrary.ts`
  Read first: `design.md`, current CangjieTemplateLibrary.ts
  Verification: `npm test -- src/services/cangjie-lsp`
  Evidence: handleClient implementation complete
  Completion: Socket properly handled, not just closed

## Phase 4: MEDIUM Priority - Architecture Concerns

- [ ] T007 [IMPL] Extract VSCode-specific code in TerminalRegistry (dependsOn: T006) `src/integrations/terminal/TerminalRegistry.ts`
  Goal: Separate VSCode-specific initialization from portable logic.
  Files: `src/integrations/terminal/TerminalRegistry.ts`
  Read first: `design.md`, current TerminalRegistry.ts
  Verification: `npx tsc --noEmit`
  Evidence: VSCode-specific code isolated or documented
  Completion: VSCode code separated from portable logic

- [ ] T008 [IMPL] Clarify data source in importExport (dependsOn: T007) `src/core/config/importExport.ts`
  Goal: Resolve dual data source confusion - use ProviderSettingsManager as single source of truth.
  Files: `src/core/config/importExport.ts`
  Read first: `design.md`, current importExport.ts
  Verification: `npx tsc --noEmit`
  Evidence: Data source responsibility clarified
  Completion: Single source of truth for provider settings

## Phase 5: MEDIUM Priority - Web Njust-AI Code Type Safety

- [ ] T009 [IMPL] Fix type safety in stats.ts (dependsOn: T008) `apps/web-Njust-AI/src/lib/stats.ts`
  Goal: Remove eslint-disable for any types, add proper TypeScript interfaces.
  Files: `apps/web-Njust-AI/src/lib/stats.ts`
  Read first: `design.md`
  Verification: `npx tsc --noEmit`
  Evidence: No more `any` types without explicit disable
  Completion: All types properly defined

## Phase 6: LOW Priority - TODO Comments

- [ ] T010 [IMPL] Resolve TODO comments appropriately (dependsOn: T009) Various files
  Goal: Address TODO comments in priority order, either fix or justify with tracking issue.
  Files: See TODO inventory in `devflow/specs/capabilities/technical-debt-remediation.md`
  Read first: `design.md`, TODO inventory
  Verification: `npm run lint`
  Evidence: TODO count reduced or each TODO justified
  Completion: 28 TODO comments addressed

## Phase 7: Final Verification

- [ ] T011 [EVIDENCE] Run final verification suite (dependsOn: T010) All modified files
  Goal: Collect evidence for cc-check.
  Commands: `npx tsc --noEmit && npm run lint && npm test`
  Evidence: All checks pass
  Completion: Full verification suite passes