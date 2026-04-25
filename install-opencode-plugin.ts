#!/usr/bin/env bun

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Ensure a relative plugin path is registered in the opencode config's "plugin" array.
 * Creates the config file with a default structure if it doesn't exist.
 * Returns true if the config was modified.
 */
function ensurePluginRegistered(configPath: string, relativePluginPath: string): boolean {
  let config: Record<string, any>;

  if (existsSync(configPath)) {
    const raw = readFileSync(configPath, "utf8");
    try {
      config = JSON.parse(raw);
    } catch {
      // If we can't parse it, don't touch it
      return false;
    }
  } else {
    config = { "$schema": "https://opencode.ai/config.json" };
  }

  if (!Array.isArray(config.plugin)) {
    config.plugin = [];
  }

  // Already registered?
  if (config.plugin.includes(relativePluginPath)) {
    return false;
  }

  config.plugin.push(relativePluginPath);
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
  return true;
}

/**
 * Remove a plugin path from the opencode config's "plugin" array.
 * Returns true if the config was modified.
 */
function removePluginFromConfig(configPath: string, relativePluginPath: string): boolean {
  if (!existsSync(configPath)) return false;

  let config: Record<string, any>;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return false;
  }

  if (!Array.isArray(config.plugin)) return false;

  const idx = config.plugin.indexOf(relativePluginPath);
  if (idx === -1) return false;

  config.plugin.splice(idx, 1);
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
  return true;
}

function removeLegacyPluginPath(configPath: string, pluginPaths: string[]): boolean {
  if (!existsSync(configPath)) return false;

  const before = readFileSync(configPath, "utf8");
  let after = before;
  for (const pluginPath of pluginPaths) {
    const pathPattern = new RegExp(
      `^\\s*\"${escapeRegExp(pluginPath)}\",?\\s*\\n`,
      "gm",
    );
    const uriPattern = new RegExp(
      `^\\s*\"file://${escapeRegExp(pluginPath)}\",?\\s*\\n`,
      "gm",
    );
    after = after.replace(pathPattern, "").replace(uriPattern, "");
  }

  if (after === before) return false;

  writeFileSync(configPath, after, "utf8");
  return true;
}

function log(message: string): void {
  process.stdout.write(`[agent-loop] ${message}\n`);
}

function fail(message: string): never {
  process.stderr.write(`[agent-loop] ERROR: ${message}\n`);
  process.exit(1);
}

function usage(): void {
  process.stdout.write(
    [
      "Agent Loop OpenCode installer",
      "",
      "Usage:",
      "  bun ./install-opencode-plugin.ts [install|uninstall|status] [--config-dir <path>]",
      "",
      "Commands:",
      "  install    Install/update plugin assets (default)",
      "  uninstall  Remove installed plugin assets",
      "  status     Show installation status",
      "",
      "Environment:",
      "  OPENCODE_CONFIG_DIR   Override OpenCode config directory",
      "",
    ].join("\n"),
  );
}

interface ParsedArgs {
  command: "install" | "uninstall" | "status";
  configDir: string | null;
}

function parseArgs(argv: string[]): ParsedArgs {
  let command: ParsedArgs["command"] = "install";
  let configDir: string | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    }
    if (arg === "install" || arg === "uninstall" || arg === "status") {
      command = arg;
      continue;
    }
    if (arg === "--config-dir") {
      const value = argv[i + 1];
      if (!value) fail("Missing value for --config-dir");
      configDir = resolve(value);
      i += 1;
      continue;
    }
    fail(`Unknown argument: ${arg}`);
  }

  return { command, configDir };
}

const args = parseArgs(process.argv.slice(2));

const scriptDir = resolve(fileURLToPath(new URL(".", import.meta.url)));
const repoRoot = resolve(scriptDir);
const sourcePluginsDir = join(repoRoot, ".opencode", "plugins");
const sourceEntryPath = join(sourcePluginsDir, "agent-loop.ts");
const sourceModuleDir = join(sourcePluginsDir, "agent-loop");
const sourceAgentsDir = join(repoRoot, ".opencode", "agents");
const sourceCommandsDir = join(repoRoot, ".opencode", "commands");
const legacyAgentFiles = ["monkey-test.md"];
const agentFiles = [
  "agent-loop-orchestrator.md",
  "agent-loop-worker.md",
  "agent-loop-plan-architect.md",
  "agent-test-orchestrator.md",
  "agent-test-worker.md",
  "monkey-test-page-tester.md",
  "monkey-test-report-reviewer.md",
];
const commandFiles = ["agent-loop.md"];

const opencodeConfigDir =
  args.configDir || process.env.OPENCODE_CONFIG_DIR || join(homedir(), ".config", "opencode");
const globalPluginsDir = join(opencodeConfigDir, "plugins");
const globalAgentsDir = join(opencodeConfigDir, "agents");
const globalCommandsDir = join(opencodeConfigDir, "commands");
const targetEntryPath = join(globalPluginsDir, "agent-loop.ts");
const targetModuleDir = join(globalPluginsDir, "agent-loop");

if (args.command === "status") {
  const states: Array<[string, boolean]> = [
    [targetEntryPath, existsSync(targetEntryPath)],
    [targetModuleDir, existsSync(targetModuleDir)],
    ...agentFiles.map((file) => [join(globalAgentsDir, file), existsSync(join(globalAgentsDir, file))] as [string, boolean]),
    ...commandFiles.map((file) => [join(globalCommandsDir, file), existsSync(join(globalCommandsDir, file))] as [string, boolean]),
  ];

  log(`OpenCode config dir: ${opencodeConfigDir}`);
  for (const [path, exists] of states) {
    log(`${exists ? "[ok]" : "[missing]"} ${path}`);
  }
  process.exit(states.every(([, exists]) => exists) ? 0 : 1);
}

if (args.command === "uninstall") {
  rmSync(targetModuleDir, { recursive: true, force: true });
  rmSync(targetEntryPath, { force: true });
  for (const file of agentFiles) {
    rmSync(join(globalAgentsDir, file), { force: true });
  }
  for (const file of legacyAgentFiles) {
    rmSync(join(globalAgentsDir, file), { force: true });
  }
  for (const file of commandFiles) {
    rmSync(join(globalCommandsDir, file), { force: true });
  }

  const configPaths = [join(opencodeConfigDir, "opencode.json"), join(opencodeConfigDir, "opencode.jsonc")];
  const removedEntries = configPaths
    .map((configPath) => removeLegacyPluginPath(configPath, [targetEntryPath]))
    .some(Boolean);

  // Also remove from the plugin array in opencode.json
  const pluginRelativePath = "./plugins/agent-loop.ts";
  const removedFromConfig = configPaths
    .map((configPath) => removePluginFromConfig(configPath, pluginRelativePath))
    .some(Boolean);

  log(`Removed OpenCode plugin entry: ${targetEntryPath}`);
  log(`Removed OpenCode plugin directory: ${targetModuleDir}`);
  if (removedEntries || removedFromConfig) {
    log("Removed plugin references from OpenCode config file.");
  }
  log("Uninstall complete.");
  process.exit(0);
}

if (!existsSync(sourceEntryPath)) {
  fail(`Source entry not found: ${sourceEntryPath}`);
}
if (!existsSync(sourceModuleDir)) {
  fail(`Source module directory not found: ${sourceModuleDir}`);
}
for (const file of agentFiles) {
  const sourcePath = join(sourceAgentsDir, file);
  if (!existsSync(sourcePath)) {
    fail(`Source agent file not found: ${sourcePath}`);
  }
}
for (const file of commandFiles) {
  const sourcePath = join(sourceCommandsDir, file);
  if (!existsSync(sourcePath)) {
    fail(`Source command file not found: ${sourcePath}`);
  }
}

mkdirSync(globalPluginsDir, { recursive: true });
mkdirSync(globalAgentsDir, { recursive: true });
mkdirSync(globalCommandsDir, { recursive: true });

for (const file of legacyAgentFiles) {
  rmSync(join(globalAgentsDir, file), { force: true });
}

rmSync(targetModuleDir, { recursive: true, force: true });
cpSync(sourceModuleDir, targetModuleDir, { recursive: true, force: true });
cpSync(sourceEntryPath, targetEntryPath, { force: true });
for (const file of agentFiles) {
  cpSync(join(sourceAgentsDir, file), join(globalAgentsDir, file), { force: true });
}
for (const file of commandFiles) {
  cpSync(join(sourceCommandsDir, file), join(globalCommandsDir, file), { force: true });
}

const configPaths = [join(opencodeConfigDir, "opencode.json"), join(opencodeConfigDir, "opencode.jsonc")];
const removedLegacyPath = configPaths
  .map((configPath) => removeLegacyPluginPath(configPath, [sourceEntryPath, targetEntryPath]))
  .some(Boolean);

// Register the plugin in opencode.json (prefer opencode.json; create if neither exists)
const pluginRelativePath = "./plugins/agent-loop.ts";
const primaryConfig = configPaths.find((p) => existsSync(p)) || configPaths[0];
const registered = ensurePluginRegistered(primaryConfig, pluginRelativePath);

log(`Installed OpenCode plugin to: ${targetEntryPath}`);
log(`Installed OpenCode agents to: ${globalAgentsDir}`);
log(`Installed OpenCode commands to: ${globalCommandsDir}`);
if (removedLegacyPath) {
  log(`Removed legacy absolute plugin path from OpenCode config.`);
}
if (registered) {
  log(`Registered plugin in ${primaryConfig}`);
} else {
  log(`Plugin already registered in ${primaryConfig}`);
}

log("Done. Verify with: opencode debug config");
