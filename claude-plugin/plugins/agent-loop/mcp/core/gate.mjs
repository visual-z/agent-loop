export async function runBackpressureGate(runShell, workdir) {
  const result = {
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
      const customResult = await runShell(["sh", "-lc", customCmd]);
      result.test = {
        passed: customResult.exitCode === 0,
        output: truncateOutput(customResult.stdout + "\n" + customResult.stderr),
      };
      result.passed = result.test.passed;
    } catch (error) {
      result.test = {
        passed: false,
        output: truncateOutput(error?.message || String(error)),
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

export function formatGateResult(result) {
  const lines = [];
  lines.push(`## Backpressure Gate Results (${result.timestamp})`);
  lines.push(`**Overall**: ${result.passed ? "PASSED" : "FAILED"}`);
  lines.push("");

  if (result.build) {
    lines.push(`### Build: ${result.build.passed ? "PASS" : "FAIL"}`);
    if (!result.build.passed) lines.push("```\n" + result.build.output + "\n```");
  }
  if (result.test) {
    lines.push(`### Tests: ${result.test.passed ? "PASS" : "FAIL"}`);
    if (!result.test.passed) lines.push("```\n" + result.test.output + "\n```");
  }
  if (result.lint) {
    lines.push(`### Lint: ${result.lint.passed ? "PASS" : "WARN"}`);
    if (!result.lint.passed) lines.push("```\n" + result.lint.output + "\n```");
  }

  if (!result.build && !result.test && !result.lint) {
    lines.push("No verification command configured. Gate auto-passed.");
  }

  return lines.join("\n");
}

export async function getBackpressureShellCommand(workdir) {
  const mode = (process.env.AGENT_LOOP_GATE_MODE || "auto").toLowerCase();
  if (mode === "off") return "echo 'Backpressure gate disabled (AGENT_LOOP_GATE_MODE=off)'";

  const customCmd = process.env.AGENT_LOOP_GATE_CMD?.trim();
  if (customCmd) return customCmd;

  return "echo 'No default verification command configured; set AGENT_LOOP_GATE_CMD to enforce one'";
}

function truncateOutput(output, maxLength = 2000) {
  if (output.length <= maxLength) return output.trim();
  return "...[truncated]...\n" + output.slice(-maxLength).trim();
}
