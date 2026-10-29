import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const TARGET_HOSTS = new Set([
  "api.openai.com",
  "api.anthropic.com",
  "api.groq.com",
  "openrouter.ai",
  "generativelanguage.googleapis.com",
  "api.deepseek.com",
  "api.mistral.ai",
]);

export default function (pi: ExtensionAPI) {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    return originalFetch(input, init).then(async (response) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

      let hostname = "";
      try {
        hostname = new URL(url).hostname;
      } catch {
        return response;
      }

      if (!TARGET_HOSTS.has(hostname) || response.status < 400) {
        return response;
      }

      const bodyText = await response.clone().text();
      let payload: any = {};
      try {
        payload = JSON.parse(bodyText || "{}");
      } catch {
        // Ignore invalid JSON and leave the response alone.
      }

      const code = payload?.error?.code ?? payload?.code ?? "";
      if (code !== "insufficient_quota") {
        return response;
      }

      const rewritten = JSON.stringify({
        error: {
          ...(payload?.error ?? {}),
          code,
          message:
            payload?.error?.message ??
            "The provider quota is temporarily exhausted. Pi will retry according to its native retry policy.",
        },
      });

      return new Response(rewritten, {
        status: 429,
        statusText: "Too Many Requests",
        headers: new Headers({
          ...(response.headers ? Object.fromEntries(response.headers.entries()) : {}),
          "content-type": "application/json",
          "x-should-retry": "true",
          "retry-after-ms": "1000",
        }),
      });
    });
  };

  pi.on("session_shutdown", () => {
    globalThis.fetch = originalFetch;
  });
}
