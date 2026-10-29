# pi-retry-enhance

A small Pi extension that keeps Pi's built-in retry behavior intact while rewriting provider responses that match your configured retry policy into a native retryable `429`.

This extension does not read Pi settings. It uses its own config file under:

```bash
~/.pi/agent/pi-retry-enhance.json
```

If the file does not exist, the extension creates it automatically with a default configuration where the total switch is off.

Default config file

```json
{
  "enabled": false,
  "hosts": [],
  "retryableStatusCodes": [429],
  "retryablePatterns": [
    "insufficient_quota",
    "quota exceeded",
    "rate limit",
    "too many requests"
  ],
  "retryableCodes": [
    "insufficient_quota"
  ],
  "maxBodyChars": 4000
}
```

Notes
- `enabled: false` is the default. Nothing is rewritten until you turn it on.
- `hosts: []` means apply to all hosts.
- If you want this extension to only affect a subset of providers, list those hostnames.
- `retryableStatusCodes`, `retryablePatterns`, and `retryableCodes` are combined with OR semantics.
- Only responses matching one of these checks get rewritten into a retryable `429`.
- This extension does not replace Pi's built-in retry engine. It only transforms a matched response into a form Pi already knows how to retry.

Install

```bash
pi install https://github.com/4ucl/pi-retry-enhance
```

Or if you want to test locally without installing the package:

```bash
mkdir -p ~/.pi/agent/extensions
cp index.ts ~/.pi/agent/extensions/pi-retry-enhance.ts
```

Then reload Pi:

```bash
pi --reload
```
