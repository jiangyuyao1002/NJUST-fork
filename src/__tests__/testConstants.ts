// Centralized test fixture constants for API keys and credentials.
// Values are clearly non-real to prevent security scanner false positives.
//
// Usage:
//   import { TEST_OPENAI_KEY } from "__tests__/testConstants"
//
// For BashCommandAnalyzer secret detection tests that require specific prefixes
// (AKIA, ghp_, sk-), use the documented AWS example key and clearly
// fake GitHub PAT to avoid automated scanner matches.

// OpenAI / Anthropic style API key — intentionally short and clearly fake
export const TEST_OPENAI_KEY = "sk-test-not-real-00000000"

// GitHub Personal Access Token — clearly fake, for git URL sanitization tests
export const TEST_GITHUB_PAT = "ghp_test_not_real_00000000000000000000"

// AWS Access Key — this is the official AWS documentation example key (not a real key)
export const TEST_AWS_ACCESS_KEY = "AKIAIOSFODNN7EXAMPLE"

// AWS Secret Key — this is the official AWS documentation example key (not a real key)
export const TEST_AWS_SECRET_KEY = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"

// Generic API key placeholder — safe for any test that just needs a non-empty string
export const TEST_API_KEY = "test-api-key-not-real"

// OAuth / Bearer token placeholder
export const TEST_BEARER_TOKEN = "test-bearer-token-not-real"

// Generic secret / password placeholder
export const TEST_SECRET = "test-secret-not-real"

// ── Detection test values ───────────────────────────────────────────
// These values are specifically crafted to match the secret detection
// patterns in BashCommandAnalyzer and PermissionRuleEngine. They are
// clearly non-real but must follow the format expected by the detectors.

// OpenAI-style key matching expected sk- detection pattern
export const TEST_SK_DETECTION_VALUE = "sk-abcdefghijklmnopqrstuvwxyz1234"

// GitHub PAT matching expected ghp_ detection pattern (40 alphanumeric chars)
export const TEST_GITHUB_PAT_DETECTION_VALUE = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij"
