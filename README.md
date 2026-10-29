# pi-retry-enhance

A Pi extension that makes **Pi's own retry loop** retry provider failures Pi normally treats as fatal — most importantly OpenAI's `insufficient_quota` (HTTP 429) and the equivalent quota / credit / billing errors from other providers.

It does not implement its own retry engine. It normalizes the failure so Pi's built-in retry (settings `retry.*`) handles it, which means backoff, attempt counting, the TUI retry banner, and abort all keep working exactly as Pi intends.

---

## Why the previous version did nothing

v0.1 patched `globalThis.fetch` and rewrote matching HTTP responses into a `429` with `x-should-retry: true`, expecting Pi to retry. That cannot work. From Pi 1.4.0:

**1. Pi classifies retries by error text, not by HTTP status.**

`packages/ai/src/utils/retry.ts` → `isRetryableAssistantError()` only looks at `message.errorMessage`:

```ts
export function isRetryableAssistantError(message: AssistantMessage): boolean {
	if (message.stopReason !== "error" || !message.errorMessage) return false;
	const errorMessage = message.errorMessage;
	if (NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN.test(errorMessage)) return false; // ← first
	return RETRYABLE_PROVIDER_ERROR_PATTERN.test(errorMessage);                      // ← then
}
```

**2. `insufficient_quota` is hard-coded in the non-retryable list**, which is evaluated *before* any `429` / `rate limit` match:

```ts
const NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN = buildProviderErrorPattern([
	"GoUsageLimitError", "FreeUsageLimitError",
	"Monthly usage limit reached", "available balance",
	"insufficient_quota", "out of budget", "quota exceeded", "billing",
	"subscription_sharing_usage_limit_exceeded",
	"subscription_sharing_workplace_individual_usage_limit_exceeded",
]);
```

So a message that mentions `insufficient_quota` is unrereyable no matter what the HTTP layer returned — and rewriting the body keeps the original text, so the keyword survives.

**3. There was no HTTP-level retry to fall back on either.** Providers call the SDK with `maxRetries: 0` and wrap it in `retryProviderRequest()` using `settings.retry.provider.maxRetries`, whose default is `0` (`packages/coding-agent/src/core/settings-defaults.ts`). A rewritten `429` therefore produced exactly zero retries, then died in the agent-level classifier anyway.

Net effect: the fetch hook could fire and it still would not retry.

## How v0.2 works

The only supported place to change Pi's retry decision is the `message_end` extension hook: a handler may return `{ message }`, and `AgentSession` replaces the finalized assistant message **in place before** it evaluates `_isRetryableError()`. So the extension:

1. Watches `message_end` for assistant messages with `stopReason: "error"`.
2. Skips anything Pi would already retry (verified against Pi's own `isRetryableAssistantError`).
3. Matches the error against the configured quota/credit/billing patterns.
4. Rewrites `errorMessage` into a retryable form — default prefix `429 rate limit`, plus the original text with the fatal keywords neutralized (`insufficient_quota` → `quota-limit-code`, `billing` → `payment`, …).
5. Re-checks the rewrite with Pi's classifier. If a future Pi adds a fatal keyword this extension does not know, it falls back to the bare `429 rate limit`.
6. Returns the message. Pi's normal retry loop takes over.

No `globalThis` patching, so `/reload` no longer stacks wrappers.

Non-goals: it never retries auth errors, invalid requests, or context overflow (those stay fatal / go to compaction), and it does not invent its own backoff.

## Install

```bash
pi install https://github.com/4ucl/pi-retry-enhance
```

Or test a local checkout without installing:

```bash
pi -e ./index.ts
```

Reload a running session with `/reload` after changing the extension.

## Verify it is live

On session start the extension prints a notice and sets a footer status `quota-retry:on`. If you see neither, the extension is not loaded (check `pi config` / `pi list`).

```bash
/retry-enhance            # status: switch, provider scope, pattern count, rewrites this session
/retry-enhance on|off     # toggle and persist to the config file
/retry-enhance test       # run a sample insufficient_quota error through the rewrite pipeline
```

`/retry-enhance test` is the fastest way to confirm end-to-end behavior without spending a real request.

## Configuration

`~/.pi/agent/pi-retry-enhance.json`, created on first load. A v0.1 file is migrated automatically (its `hosts`, `retryableStatusCodes`, `retryableCodes` and `maxBodyChars` keys are obsolete and dropped).

```json
{
  "enabled": true,
  "providers": [],
  "patterns": [
    "insufficient_quota",
    "insufficient quota",
    "exceeded your current quota",
    "exceed your current quota",
    "quota has been exhausted",
    "quota exhausted",
    "quota exceeded",
    "out of budget",
    "insufficient credits",
    "more credits",
    "no credits",
    "credit balance",
    "insufficient balance",
    "add funds",
    "payment required",
    "usage limit",
    "billing"
  ],
  "retryablePrefix": "429 rate limit",
  "maxDetailChars": 240,
  "notify": true,
  "logFile": ""
}
```

| Key | Meaning |
|---|---|
| `enabled` | Master switch. Default `true`. |
| `providers` | Restrict to Pi provider ids (`"openai"`, `"openrouter"`, …). `[]` = every provider. |
| `patterns` | Case-insensitive regexes (or plain substrings) identifying a quota/credit/billing failure. |
| `retryablePrefix` | Prefix of the rewritten message. Must look retryable to Pi; `429 rate limit` does. |
| `maxDetailChars` | How much of the original error to keep. `0` keeps none. |
| `notify` | One toast per failed run when a retry is forced. |
| `logFile` | Optional JSONL path for rewrites (original cause + rewritten message). |

## Tuning how patient the retries are

Retry count and backoff belong to Pi, not to this extension:

```json
{
  "retry": {
    "enabled": true,
    "maxRetries": 5,
    "baseDelayMs": 5000,
    "maxAgentDelayMs": 120000
  }
}
```

in `~/.pi/agent/settings.json`. Quota resets are rarely seconds away, so a longer `baseDelayMs` is usually more useful than more attempts. If the quota is hard-exhausted, Pi stops after `maxRetries` and shows the rewritten error.

## Caveats

- Compaction and branch-summary calls retry inside `retryAssistantCall()` without emitting `message_end`, so a quota error during summarization is still not retried by this extension.
- The persisted assistant message carries the rewritten text (Pi stores the normalized error). The original provider text is preserved minus the neutralized keywords, and `logFile` keeps it verbatim.
- Rewriting is text-based. A provider that reports quota exhaustion with wording none of the patterns match will not be retried — add the wording to `patterns`.

## Compatibility

Verified against Pi 1.4.0 (`@earendil-works/pi-coding-agent` / `@earendil-works/pi-ai`), the current release. Relies on two stable, documented extension contracts: the `message_end` replacement contract and `isRetryableAssistantError` from `@earendil-works/pi-ai`.
