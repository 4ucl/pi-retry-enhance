# Changelog

## 0.2.0

### Fixed

- Quota/`insufficient_quota` failures are now actually retried. v0.1 rewrote the HTTP response into a `429`, but Pi decides retries from `message.errorMessage` (`isRetryableAssistantError`), and `insufficient_quota` sits in Pi's non-retryable list, which is evaluated before any status/text match. The rewrite never reached the decision point, and provider-level retry defaults to `maxRetries: 0`, so nothing retried.
- The extension now normalizes the error in the supported `message_end` hook, which Pi applies to the finalized assistant message before its retry check.

### Changed

- No longer patches `globalThis.fetch`. Reloading the extension used to stack fetch wrappers and could restore a stale one on shutdown.
- Config shape replaced: `hosts` / `retryableStatusCodes` / `retryableCodes` / `maxBodyChars` are gone. New keys: `patterns`, `providers`, `retryablePrefix`, `maxDetailChars`, `notify`, `logFile`. A v0.1 file is migrated on load.
- `enabled` now defaults to `true`; the extension exists to do exactly this one thing.
- Added `/retry-enhance` (`status` | `on` | `off` | `test`), a footer status indicator, and a one-time notice on session start so a silent no-op is visible immediately.

### Added

- Self-check against Pi's own `isRetryableAssistantError`, with a bare-message fallback if a future Pi introduces a keyword the extension does not know.
- `test/rewrite.test.ts` covering OpenAI/OpenRouter/credit-balance/subscription cases plus the non-retryable and already-retryable paths.

## 0.1.0

- Initial release.
