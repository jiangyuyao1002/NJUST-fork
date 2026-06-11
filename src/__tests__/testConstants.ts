// Centralized test fixture constants for API keys and credentials.
// Values are clearly non-real to prevent security scanner false positives.
//
// Usage:
//   import { TEST_OPENAI_KEY } from "__tests__/testConstants"
//
// This entire file is in a gitleaks-allowlisted path (__tests__/).
// For additional clarity, detection-specific constants carry inline
// gitleaks:allow annotations.

// OpenAI / Anthropic style API key — intentionally short and clearly fake
export const TEST_OPENAI_KEY = "sk-test-not-real-00000000"

// GitHub Personal Access Token — clearly fake, for git URL sanitization tests
export const TEST_GITHUB_PAT = "ghp_test_not_real_00000000000000000000"

// AWS Access Key — official AWS documentation example, not a real key
export const TEST_AWS_ACCESS_KEY = "AKIAIOSFODNN7EXAMPLE"

// ── Detection test values ───────────────────────────────────────────
// These values are crafted to match secret detection patterns in
// BashCommandAnalyzer and PermissionRuleEngine tests. Format is
// intentionally realistic-looking; gitleaks paths allowlist covers
// the __tests__/ tree. gitleaks:allow

// OpenAI-style key matching expected sk- detection pattern
export const TEST_SK_DETECTION_VALUE = "sk-abcdefghijklmnopqrstuvwxyz1234" // gitleaks:allow

// GitHub PAT matching expected ghp_ detection pattern (40 alphanumeric chars)
export const TEST_GITHUB_PAT_DETECTION_VALUE = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij" // gitleaks:allow
