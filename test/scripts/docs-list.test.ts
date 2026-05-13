import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const scriptPath = path.resolve("scripts/docs-list.js");

function writeDoc(root: string, relativePath: string, content: string): void {
  const fullPath = path.join(root, relativePath);
  mkdirSync(path.dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content);
}

describe("docs-list", () => {
  it("skips root agent instruction files but keeps template docs", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-docs-list-"));
    try {
      writeDoc(root, "docs/AGENTS.md", "# Docs Guide\n");
      writeDoc(root, "docs/CLAUDE.md", "# Claude Guide\n");
      writeDoc(
        root,
        "docs/guide.md",
        '---\nsummary: "Example guide"\nread_when:\n  - Testing docs list\n---\n\n# Guide\n',
      );
      writeDoc(
        root,
        "docs/reference/templates/AGENTS.md",
        '---\nsummary: "Workspace template for AGENTS.md"\n---\n\n# AGENTS.md\n',
      );

      const output = execFileSync(process.execPath, [scriptPath], {
        cwd: root,
        encoding: "utf8",
      });

      expect(output).toContain("guide.md - Example guide");
      expect(output).toContain("reference/templates/AGENTS.md - Workspace template for AGENTS.md");
      expect(output).not.toContain("AGENTS.md - [missing front matter]");
      expect(output).not.toContain("CLAUDE.md");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
