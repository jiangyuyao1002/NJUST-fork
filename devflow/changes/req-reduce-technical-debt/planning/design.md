# DESIGN - Technical Debt Remediation

## Document Meta

- Requirement version: req-reduce-technical-debt.v1
- Design version: design.v1
- CC-Plan skill version: 3.7.6
- Output language: en
- Requirement ID: req-reduce-technical-debt
- Design mode: `tiny-design`
- Why not `full-design`: This is a systematic remediation of independent code quality issues across many files; each fix is self-contained and doesn't require cross-module coordination or architectural decisions.
- Design status: `approved`
- Source roadmap item: no source RM (direct requirement)
- Source roadmap version: N/A
- Source roadmap skill version: N/A
- Roadmap sync status: No source RM
- Primary capability: cap-technical-debt-remediation
- Secondary capabilities: none
- Date: 2026-05-09
- Owner: claude-code

## Source Handoff

- Source stage: Direct requirement from user
- Why now from roadmap: User explicitly requested systematic technical debt remediation
- Capability gap from roadmap: N/A - internal quality improvement
- Expected spec delta: Improve type safety, error handling, and code completeness across the codebase
- Inherited success signal: All TypeScript compilation passes, ESLint passes with fewer disables, tests pass
- Inherited kill signal: Changes introduce new type errors or break existing tests
- Inherited dependencies: None
- Inherited non-goals: Feature development, performance optimization, user-facing documentation
- Upstream evidence: Comprehensive debt inventory in `devflow/specs/capabilities/technical-debt-remediation.md`
- Assumptions to re-validate: None

## Assumptions Preview & Ambiguity Gate

- WHAT ambiguity score: 1/10 (clear - fix technical debt)
- WHY ambiguity score: 1/10 (clear - improve code quality and maintainability)
- Blocking threshold: 3
- Assumptions preview: All fixes are backward-compatible refactoring
- Missing user / operator: N/A (internal quality work)
- Missing pain / failure path: N/A
- Missing smallest wedge: Each individual fix is the smallest wedge
- Missing success signal: TypeScript compilation passes, tests pass
- Missing verification path: `npx tsc --noEmit`, `npm run lint`, `npm test`
- Gate verdict: `pass`

## Capability Handoff

- Canonical capability spec: `devflow/specs/capabilities/technical-debt-remediation.md`
- Related capability specs: none
- Current truth to preserve: Debt inventory with 28 TODOs, ~25+ any types, etc.
- Current gaps: All identified debt items need systematic resolution
- Intentional gaps: Performance optimization (separate capability)
- Spec sync target: Update capability spec with completion status

## Requirement Snapshot

- Raw ask: Create a requirement "Reduce Technical Debt" to identify and fix all technical debt in the entire repository.
- User: Internal development team
- Pain: Accumulated code quality issues hinder maintainability and introduce potential bugs
- Smallest viable wedge: Fix HIGH priority issues first (ProviderSettingsManager async constructor, silent error swallowing)
- Out of scope: Feature development, performance optimization, user-facing documentation

## PRD-Grade Requirement Brief

- Problem statement: The codebase has accumulated technical debt (28 TODO comments, ~25+ `any` types, incomplete implementations, anti-patterns) that reduces maintainability and increases bug risk.
- Solution summary: Systematically identify and resolve code quality issues in priority order.
- Actors / personas: Developers maintaining the codebase
- Primary user stories:

| ID | Actor | Wants | Benefit | Acceptance / evidence |
|----|-------|-------|---------|-----------------------|
| US-001 | Developer | Work with type-safe code | Fewer runtime type errors | TypeScript compilation passes with strict types |
| US-002 | Developer | See clear error handling | Easier debugging | No silent error swallows, errors logged properly |

- Implementation decisions:
  - Fix HIGH priority issues first (async constructor, silent error swallowing, type safety)
  - Then MEDIUM priority (incomplete implementations, architecture concerns)
  - Verify each fix doesn't introduce new debt
- Testing decisions:
  - Run TypeScript compiler after each fix
  - Run existing test suite to ensure no regression
  - Verify ESLint passes
- Out of scope: Feature development, performance optimization, user-facing documentation
- Further notes: Each fix should be independent and self-contained

## Success Criteria

- Observable success signals:
  - TypeScript compilation passes with no errors
  - ESLint reports fewer violations (especially eslint-disable comments reduced)
  - All existing tests pass
- Business / operator success signals: N/A (internal quality work)
- Abort signals: Any fix introduces new TypeScript errors or breaks tests

## Options Considered

### Option A (Recommended): Priority-Ordered Sequential Fixes

- Role: `minimal viable`
- Shape: Fix HIGH priority issues first, then MEDIUM, then LOW
- Reuses: Existing test infrastructure, TypeScript compiler, ESLint
- Completeness: 8/10 - addresses all documented debt
- Pros: Clear priority order, easy to verify progress, low risk of introducing new issues
- Cons: May take longer to see full benefit
- Risks: Low - each fix is independent and verifiable

### Option B: Aggressive Full Cleanup

- Role: `ideal architecture`
- Shape: Fix all issues simultaneously across all files
- Reuses: Same infrastructure
- Completeness: 10/10 - everything fixed at once
- Pros: Fastest overall completion
- Cons: High risk of introducing bugs, harder to verify each fix
- Risks: High - no intermediate verification gates

### Eliminated Options

- Option: Fix LOW priority first
- Why eliminated: Doesn't address the most critical issues causing maintenance burden

## Approved Direction

- Approved option: Option A (Priority-Ordered Sequential Fixes)
- Why this is the best trade-off now: Clear priority, verifiable progress, low risk
- Why not the other options now: Option B has high risk of introducing bugs
- What we explicitly rejected: Aggressive full cleanup approach
- Frozen decisions: Fix in priority order (HIGH -> MEDIUM -> LOW), verify after each fix
- Deferred questions: None

## Decision Questions

| ID | Gate | Known evidence | Recommendation | User choice | Impact on `cc-do` | Status |
|----|------|----------------|----------------|-------------|-------------------|--------|
| D1 | final-design-approval | User requested systematic remediation | Proceed with Option A | approved | cc-do follows priority-ordered task list | answered |

## File Plan

| File | Change | Reason |
|------|--------|--------|
| `src/core/config/ProviderSettingsManager.ts` | Fix async constructor, fix silent error swallow | HIGH priority anti-pattern |
| `apps/cli/src/ui/stores/uiStateStore.ts` | Remove eslint-disable for any types, add proper types | HIGH priority type safety |
| `apps/cli/src/ui/hooks/usePickerHandlers.ts` | Remove any types, add proper interfaces | HIGH priority type safety |
| `src/services/ripgrep/index.ts` | Complete error handling, add optimization | MEDIUM priority incomplete impl |
| `src/services/cangjie-lsp/CangjieTemplateLibrary.ts` | Complete handleClient implementation | MEDIUM priority incomplete impl |
| `src/integrations/terminal/TerminalRegistry.ts` | Extract VSCode-specific code | MEDIUM priority architecture |
| `src/core/config/importExport.ts` | Clarify data source responsibility | MEDIUM priority dual source |
| `apps/web-roo-code/src/lib/stats.ts` | Remove eslint-disable for any types | MEDIUM priority type safety |
| Various files | Resolve TODO comments appropriately | LOW priority cleanup |

## Implementation Decision Horizon

| Phase | Decision `cc-do` would otherwise hit | Frozen answer | Evidence / owner |
|-------|--------------------------------------|---------------|------------------|
| Foundation | How to fix async constructor | Extract async logic to separate initialization method | Standard TypeScript pattern |
| Core logic | How to handle silent error swallows | Add proper error logging and handling | Use existing logger |
| Integration | How to handle incomplete implementations | Either complete or remove dead code | Based on TODO context |
| Polish / tests | How to verify fixes | Run tsc, lint, tests after each fix | Standard verification |

## Invariant Impact

- Affected invariants:
  - No regression: existing tests must continue to pass (STRICT)
  - Type safety: new code must not introduce `any` types (STRICT)
  - Error handling: errors must be caught and handled explicitly (STRICT)
- Invariants kept unchanged: All user-facing behavior remains the same
- New invariants introduced: None

## Gap Changes

- Gaps closed by this change: 28 TODO comments, ~25+ any types, 15+ @ts-ignore
- New gaps introduced: None
- Gaps intentionally left open: Performance optimization (separate capability)

## Review Gate

- Placeholder scan: pass
- Consistency scan: pass
- Scope scan: pass - only technical debt remediation, no feature creep
- Ambiguity scan: pass
- Feasibility scan: pass - each fix is verifiable
- Source alignment: N/A (no source RM)
- Domain language scan: pass
- Implementation surface scan: pass
- Interface depth scan: N/A (internal refactoring)
- Interface testability scan: N/A
- Decision horizon scan: pass
- Error & rescue scan: N/A
- Test framework / regression scan: pass - regression tests required
- Test seam / mock boundary scan: N/A
- Public verification path scan: pass
- Tracer bullet scan: pass
- Green minimality / refactor candidate scan: pass
- PRD brief scan: pass
- Source trust boundary scan: N/A
- External conflict scan: N/A
- Ambiguity gate: pass
- Review loop status: completed in single pass
- Decision question scan: D1 answered
- UI / interaction review summary: N/A
- DX / operator review summary: N/A
- Test-first readiness: N/A (this is refactoring, not new feature development)
- Review calibration: Non-blocking
- Auto-decided items: None
- Taste decisions: None
- User challenges: None
- Recommendation: APPROVE for execution

## Bounded Review Loop

- Attempt: 1
- Max attempts: 3
- Repeated concern fingerprints: None
- Stall reason: None
- Reroute if stalled: N/A

## Approval

- User approval status: Approved via direct user request
- Follow-up changes after review: None

## Roadmap Sync Gate

- Source RM: None (direct requirement)
- Locate command: N/A
- Sync command: N/A
- Updated files: None
- Status after sync: No source RM
- Progress after sync: N/A
- No-op reason: Direct requirement without upstream roadmap item
- Blocking mismatch: None

## First-Read Test

- 10 秒内能否看出这次为什么不是 `tiny-design`: Yes - it's a series of independent fixes
- 10 秒内能否看出批准方案和被拒方案的边界: Yes - sequential priority-ordered vs aggressive simultaneous
- `cc-do` 是否还能被迫二次设计; if会, 说明这里还不够清楚: No - each fix is self-contained and clear