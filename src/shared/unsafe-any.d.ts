/**
 * Transitional dynamic boundary for legacy provider/tool payloads.
 *
 * Keep this alias centralized so `no-explicit-any` can stay strict while the
 * remaining call sites are narrowed to concrete types incrementally.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type UnsafeAny = any
