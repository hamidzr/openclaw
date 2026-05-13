import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const envExample = readFileSync(".env.example", "utf8");
const documentedEnvPattern =
  /\b[A-Z][A-Z0-9_]{2,}(?:_API_KEY|_KEY|_TOKEN|_SECRET|_APP_ID|_ACCESS_TOKEN|_CLIENT_SECRET|_URL)\b/g;
const allowedDocumentedOmissions = new Set([
  "AKS_OIDC_ISSUER_URL",
  "CHUTES_CLIENT_SECRET",
  "CUSTOM_API_KEY",
  "CHUTES_OAUTH_TOKEN",
  "CLIENT_SECRET",
  "COPILOT_GITHUB_TOKEN",
  "DISCORD_PERSONAL_TOKEN",
  "DISCORD_WORK_TOKEN",
  "GITHUB_TOKEN",
  "LM_API_TOKEN",
  "MATRIX_RECOVERY_KEY",
  "MINIMAX_OAUTH_TOKEN",
  "OPENAI_BASE_URL",
  "OPENAI_TTS_BASE_URL",
  "OPENCLAW_GEMINI_OAUTH_CLIENT_SECRET",
  "OPENCLAW_LIVE_VYDRA_KLING_IMAGE_URL",
  "SPEECH_KEY",
  "USER_ACCESS_TOKEN",
  "YOUR_APP_ID",
  "YOUR_APP_SECRET",
  "YOUR_BOT_TOKEN",
  "YOUR_DISCORD_BOT_TOKEN",
  "YOUR_KEY",
  "YOUR_TELEGRAM_BOT_TOKEN",
  "YOUR_TOKEN",
]);

function collectMarkdownEnvVars(dir: string): Set<string> {
  const result = new Set<string>();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) {
      continue;
    }

    const content = readFileSync(path.join(dir, entry.name), "utf8");
    for (const match of content.matchAll(documentedEnvPattern)) {
      result.add(match[0]);
    }
  }
  return result;
}

describe(".env.example", () => {
  it("does not define duplicate environment variables", () => {
    const seen = new Set<string>();
    const duplicates = new Set<string>();

    for (const line of envExample.split("\n")) {
      const match = /^#?\s*([A-Z][A-Z0-9_]+)=/.exec(line);
      if (!match) {
        continue;
      }

      const name = match[1];
      if (seen.has(name)) {
        duplicates.add(name);
      }
      seen.add(name);
    }

    expect([...duplicates].toSorted()).toEqual([]);
  });

  it("keeps enabled example variables empty", () => {
    const enabledAssignments = envExample
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^[A-Z][A-Z0-9_]+=/.test(line));

    expect(enabledAssignments).toEqual(["OPENCLAW_GATEWAY_TOKEN="]);
  });

  it("covers documented provider, channel, tool, and gateway env vars", () => {
    const documentedVars = new Set([
      ...collectMarkdownEnvVars("docs/providers"),
      ...collectMarkdownEnvVars("docs/channels"),
      ...collectMarkdownEnvVars("docs/tools"),
      ...collectMarkdownEnvVars("docs/gateway"),
    ]);
    const missing = [...documentedVars]
      .filter((name) => !envExample.includes(name) && !allowedDocumentedOmissions.has(name))
      .toSorted();

    expect(missing).toEqual([]);
  });
});
