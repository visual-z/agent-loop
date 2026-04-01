// =============================================================================
// Agent Loop — Backpressure Gate
// =============================================================================
//
// The gate is workflow-level, not language/tool-specific. By default it does
// not try to infer coding commands from the repository. If a project wants a
// blocking verification step, it must provide one explicitly via
// AGENT_LOOP_GATE_CMD.
// =============================================================================

import type { GateResult } from "./types";

interface ShellRunner {
  (cmd: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

/**
 * Run an optional workflow-level verification command.
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

  result.test = {
    passed: true,
    output:
      "No default verification command configured. Set AGENT_LOOP_GATE_CMD to enforce a project-specific gate.",
  };

  return result;
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
    lines.push(`_No verification command configured. Gate auto-passed._`);
  }

  return lines.join("\n");
}

/**
 * Generate the shell command string for the backpressure gate.
 * Workers can run this directly when the loop owner configured one.
 */
export function getBackpressureShellCommand(workdir: string): string {
  const mode = (process.env.AGENT_LOOP_GATE_MODE || "auto").toLowerCase();
  if (mode === "off") return "echo 'Backpressure gate disabled (AGENT_LOOP_GATE_MODE=off)'";

  const customCmd = process.env.AGENT_LOOP_GATE_CMD?.trim();
  if (customCmd) return customCmd;

  return "echo 'No default verification command configured; set AGENT_LOOP_GATE_CMD to enforce one'";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncateOutput(output: string, maxLength = 2000): string {
  if (output.length <= maxLength) return output.trim();
  // Keep the last N chars (tail is usually more informative for errors)
  return "...[truncated]...\n" + output.slice(-maxLength).trim();
}
