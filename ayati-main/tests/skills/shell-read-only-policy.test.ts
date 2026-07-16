import { describe, expect, it } from "vitest";
import { isClearlyReadOnlyShellCommand } from "../../src/skills/builtins/shell/read-only-policy.js";

describe("read-only shell policy", () => {
  it("recognizes compound inspection and syntax-verification commands", () => {
    expect(isClearlyReadOnlyShellCommand([
      "set -e",
      "cd /tmp/project",
      "ls -la index.html styles.css app.js",
      "for token in hero menu story; do",
      "  if grep -q \"$token\" index.html; then echo OK; else echo MISS; fi",
      "done",
      "hits=$(grep -E 'cdn|unpkg' index.html | wc -l)",
      "echo \"$hits\"",
      "sha256sum index.html styles.css app.js",
      "node --check app.js 2>&1",
    ].join("\n"))).toBe(true);
  });

  it("fails closed for mutation-capable or unknown commands", () => {
    expect(isClearlyReadOnlyShellCommand("pnpm build")).toBe(false);
    expect(isClearlyReadOnlyShellCommand("node scripts/generate.js")).toBe(false);
    expect(isClearlyReadOnlyShellCommand("sed -i 's/a/b/' index.html")).toBe(false);
  });
});
