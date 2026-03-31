// =============================================================================
// Agent Loop — Backpressure Gate
// =============================================================================
//
// Quality gate that runs between tasks. A task isn't marked as "done" unless
// the codebase still builds, tests pass, and lint is clean.
//
// The gate is intentionally conservative: a build failure blocks the task,
// but lint warnings just get logged (don't block).
// =============================================================================

import { existsSync } from "fs";
import { join } from "path";
import type { GateResult } from "./types";

interface ShellRunner {
  (cmd: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

/**
 * Auto-detect the project type and run build + test + lint.
 *
 * @param $ - The Bun shell runner from the plugin context
 * @param workdir - Project root directory
 * @returns GateResult with pass/fail for each phase
 */
export async function runBackpressureGate(
  $: ShellRunner,
  workdir: string
): Promise<GateResult> {
  const result: GateResult = {
    passed: true,
    build: null,
    test: null,
    lint: null,
    timestamp: new Date().toISOString(),
  };

  const mode = (process.env.AGENT_LOOP_GATE_MODE || "auto").toLowerCase();
  if (mode === "off") {
    result.test = {
      passed: true,
      output: "Backpressure gate disabled via AGENT_LOOP_GATE_MODE=off",
    };
    return result;
  }

  const customCmd = process.env.AGENT_LOOP_GATE_CMD?.trim();
  if (customCmd) {
    try {
      const customResult = await $(["sh", "-lc", customCmd]);
      result.test = {
        passed: customResult.exitCode === 0,
        output: truncateOutput(customResult.stdout + "\n" + customResult.stderr),
      };
      result.passed = result.test.passed;
    } catch (e: any) {
      result.test = {
        passed: false,
        output: truncateOutput(e.message || String(e)),
      };
      result.passed = false;
    }
    return result;
  }

  const projectType = detectProjectType(workdir);

  // ---- Build Phase ----
  const buildCmd = getBuildCommand(projectType, workdir);
  if (buildCmd) {
    try {
      const buildResult = await $(buildCmd);
      result.build = {
        passed: buildResult.exitCode === 0,
        output: truncateOutput(buildResult.stdout + "\n" + buildResult.stderr),
      };
      if (!result.build.passed) result.passed = false;
    } catch (e: any) {
      result.build = {
        passed: false,
        output: truncateOutput(e.message || String(e)),
      };
      result.passed = false;
    }
  }

  // ---- Test Phase ----
  const testCmd = getTestCommand(projectType, workdir);
  if (testCmd) {
    try {
      const testResult = await $(testCmd);
      result.test = {
        passed: testResult.exitCode === 0,
        output: truncateOutput(testResult.stdout + "\n" + testResult.stderr),
      };
      if (!result.test.passed) result.passed = false;
    } catch (e: any) {
      result.test = {
        passed: false,
        output: truncateOutput(e.message || String(e)),
      };
      result.passed = false;
    }
  }

  // ---- Lint Phase (non-blocking) ----
  const lintCmd = getLintCommand(projectType, workdir);
  if (lintCmd) {
    try {
      const lintResult = await $(lintCmd);
      result.lint = {
        passed: lintResult.exitCode === 0,
        output: truncateOutput(lintResult.stdout + "\n" + lintResult.stderr),
      };
      // Lint failures are warnings — don't block the gate
    } catch (e: any) {
      result.lint = {
        passed: false,
        output: truncateOutput(e.message || String(e)),
      };
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Project Detection
// ---------------------------------------------------------------------------

type ProjectType =
  | "node"
  | "rust"
  | "go"
  | "python"
  | "unknown";

function detectProjectType(workdir: string): ProjectType {
  if (existsSync(join(workdir, "package.json"))) return "node";
  if (existsSync(join(workdir, "Cargo.toml"))) return "rust";
  if (existsSync(join(workdir, "go.mod"))) return "go";
  if (
    existsSync(join(workdir, "pyproject.toml")) ||
    existsSync(join(workdir, "setup.py")) ||
    existsSync(join(workdir, "requirements.txt"))
  )
    return "python";
  return "unknown";
}

function getBuildCommand(
  type: ProjectType,
  workdir: string
): string[] | null {
  switch (type) {
    case "node": {
      // Check if there's a build script in package.json
      try {
        const pkg = require(join(workdir, "package.json"));
        if (pkg.scripts?.build) return ["npm", "run", "build"];
        if (pkg.scripts?.typecheck) return ["npm", "run", "typecheck"];
      } catch {}
      // Try tsc directly
      if (existsSync(join(workdir, "tsconfig.json")))
        return ["npx", "tsc", "--noEmit"];
      return null;
    }
    case "rust":
      return ["cargo", "build"];
    case "go":
      return ["go", "build", "./..."];
    case "python":
      // Python: type checking if mypy/pyright is available
      if (existsSync(join(workdir, "mypy.ini")) || existsSync(join(workdir, "pyrightconfig.json")))
        return ["python", "-m", "mypy", "."];
      return null;
    default:
      return null;
  }
}

function getTestCommand(
  type: ProjectType,
  workdir: string
): string[] | null {
  switch (type) {
    case "node": {
      try {
        const pkg = require(join(workdir, "package.json"));
        if (pkg.scripts?.test) return ["npm", "test"];
      } catch {}
      // Heuristics
      if (existsSync(join(workdir, "vitest.config.ts"))) return ["npx", "vitest", "run"];
      if (existsSync(join(workdir, "jest.config.ts")) || existsSync(join(workdir, "jest.config.js")))
        return ["npx", "jest"];
      return null;
    }
    case "rust":
      return ["cargo", "test"];
    case "go":
      return ["go", "test", "./..."];
    case "python": {
      if (existsSync(join(workdir, "pytest.ini")) || existsSync(join(workdir, "pyproject.toml")))
        return ["python", "-m", "pytest"];
      return null;
    }
    default:
      return null;
  }
}

function getLintCommand(
  type: ProjectType,
  workdir: string
): string[] | null {
  switch (type) {
    case "node": {
      try {
        const pkg = require(join(workdir, "package.json"));
        if (pkg.scripts?.lint) return ["npm", "run", "lint"];
      } catch {}
      if (
        existsSync(join(workdir, ".eslintrc.js")) ||
        existsSync(join(workdir, ".eslintrc.json")) ||
        existsSync(join(workdir, "eslint.config.js")) ||
        existsSync(join(workdir, "eslint.config.mjs"))
      )
        return ["npx", "eslint", "."];
      if (existsSync(join(workdir, "biome.json")))
        return ["npx", "biome", "check", "."];
      return null;
    }
    case "rust":
      return ["cargo", "clippy"];
    case "go":
      return ["golangci-lint", "run"];
    case "python":
      return ["python", "-m", "ruff", "check", "."];
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Gate Result Formatting
// ---------------------------------------------------------------------------

export function formatGateResult(result: GateResult): string {
  const lines: string[] = [];
  lines.push(`## Backpressure Gate Results (${result.timestamp})`);
  lines.push(`**Overall**: ${result.passed ? "✅ PASSED" : "❌ FAILED"}`);
  lines.push(``);

  if (result.build) {
    lines.push(`### Build: ${result.build.passed ? "✅" : "❌"}`);
    if (!result.build.passed) lines.push(`\`\`\`\n${result.build.output}\n\`\`\``);
  }
  if (result.test) {
    lines.push(`### Tests: ${result.test.passed ? "✅" : "❌"}`);
    if (!result.test.passed) lines.push(`\`\`\`\n${result.test.output}\n\`\`\``);
  }
  if (result.lint) {
    lines.push(`### Lint: ${result.lint.passed ? "✅" : "⚠️"}`);
    if (!result.lint.passed) lines.push(`\`\`\`\n${result.lint.output}\n\`\`\``);
  }

  if (!result.build && !result.test && !result.lint) {
    lines.push(`_No build/test/lint configuration detected. Gate auto-passed._`);
  }

  return lines.join("\n");
}

/**
 * Generate the shell command string for the backpressure gate.
 * Workers can run this directly to verify their work.
 */
export function getBackpressureShellCommand(workdir: string): string {
  const mode = (process.env.AGENT_LOOP_GATE_MODE || "auto").toLowerCase();
  if (mode === "off") return "echo 'Backpressure gate disabled (AGENT_LOOP_GATE_MODE=off)'";

  const customCmd = process.env.AGENT_LOOP_GATE_CMD?.trim();
  if (customCmd) return customCmd;

  const type = detectProjectType(workdir);
  const cmds: string[] = [];

  const build = getBuildCommand(type, workdir);
  if (build) cmds.push(build.join(" "));

  const test = getTestCommand(type, workdir);
  if (test) cmds.push(test.join(" "));

  return cmds.length > 0 ? cmds.join(" && ") : "echo 'No build/test detected'";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncateOutput(output: string, maxLength = 2000): string {
  if (output.length <= maxLength) return output.trim();
  // Keep the last N chars (tail is usually more informative for errors)
  return "...[truncated]...\n" + output.slice(-maxLength).trim();
}
