import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const envExample = readFileSync(".env.example", "utf8");

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
});
