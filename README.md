# pi-retry-enhance

A small Pi extension that rewrites `insufficient_quota` errors into a native retryable `429` so Pi's built-in retry logic can keep retrying without replacing Pi's own retry engine.

Why this exists
- Pi's native retry logic retries `429` and other retryable transport errors.
- Some providers report quota exhaustion as `insufficient_quota` instead of a classic retryable throttle.
- This extension converts that case into a Pi-native retryable error shape by setting:
  - HTTP status: `429`
  - header: `x-should-retry: true`
  - header: `retry-after-ms: 1000`

This keeps Pi's built-in retry behavior intact while making transient quota exhaustion behave like a retryable condition.

Install

Option 1: copy directly into Pi's extension directory

```bash
mkdir -p ~/.pi/agent/extensions
cp index.ts ~/.pi/agent/extensions/pi-retry-enhance.ts
```

Then reload Pi:

```bash
pi --reload
```

Option 2: use as a package via GitHub

```bash
pi install https://github.com/4ucl/pi-retry-enhance
```

Files
- `index.ts` — the extension entry point
- `package.json` — metadata for Pi package discovery

Notes
- This extension is intentionally narrow: it only rewrites `insufficient_quota`.
- Other errors are left alone.
- It does not replace Pi's built-in retry loop; it simply makes the provider error look retryable to Pi.
