import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";

const root = new URL("../", import.meta.url);
const repoRoot = new URL("../", root);

async function exists(relativePath) {
  try {
    await access(new URL(relativePath, root), constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

describe("Codex plugin shape", () => {
  it("exposes the plugin through a repo marketplace", async () => {
    const marketplace = JSON.parse(
      await readFile(new URL(".agents/plugins/marketplace.json", repoRoot), "utf8"),
    );
    const entry = marketplace.plugins.find((plugin) => plugin.name === "agent-loop");

    assert.equal(marketplace.name, "agent-loop");
    assert.equal(entry?.source?.source, "local");
    assert.equal(entry?.source?.path, "./codex-plugin");
    assert.equal(entry?.policy?.installation, "AVAILABLE");
    assert.equal(entry?.policy?.authentication, "ON_INSTALL");
    assert.equal(await exists("../.agents/plugins/marketplace.json"), true);
  });

  it("declares skills and hooks without MCP servers", async () => {
    const manifest = JSON.parse(
      await readFile(new URL(".codex-plugin/plugin.json", root), "utf8"),
    );

    assert.equal(manifest.name, "agent-loop");
    assert.equal(manifest.skills, "./skills/");
    assert.equal(manifest.hooks, "./hooks/hooks.json");
    assert.equal("mcpServers" in manifest, false);
    assert.equal(await exists(".mcp.json"), false);
  });

  it("ships the main skill and reference files", async () => {
    assert.equal(await exists("skills/agent-loop/SKILL.md"), true);
    assert.equal(await exists("skills/agent-loop/references/loop-state.md"), true);
    assert.equal(await exists("skills/agent-loop/references/plan-format.md"), true);
    assert.equal(await exists("skills/agent-loop/references/worker-handoff.md"), true);
  });
});
