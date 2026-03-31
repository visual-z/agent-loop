import { existsSync } from "fs";
import { join } from "path";

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

  const projectType = detectProjectType(workdir);

  const buildCmd = await getBuildCommand(projectType, workdir);
  if (buildCmd) {
    try {
      const buildResult = await runShell(buildCmd);
      result.build = {
        passed: buildResult.exitCode === 0,
        output: truncateOutput(buildResult.stdout + "\n" + buildResult.stderr),
      };
      if (!result.build.passed) result.passed = false;
    } catch (error) {
      result.build = {
        passed: false,
        output: truncateOutput(error?.message || String(error)),
      };
      result.passed = false;
    }
  }

  const testCmd = await getTestCommand(projectType, workdir);
  if (testCmd) {
    try {
      const testResult = await runShell(testCmd);
      result.test = {
        passed: testResult.exitCode === 0,
        output: truncateOutput(testResult.stdout + "\n" + testResult.stderr),
      };
      if (!result.test.passed) result.passed = false;
    } catch (error) {
      result.test = {
        passed: false,
        output: truncateOutput(error?.message || String(error)),
      };
      result.passed = false;
    }
  }

  const lintCmd = await getLintCommand(projectType, workdir);
  if (lintCmd) {
    try {
      const lintResult = await runShell(lintCmd);
      result.lint = {
        passed: lintResult.exitCode === 0,
        output: truncateOutput(lintResult.stdout + "\n" + lintResult.stderr),
      };
    } catch (error) {
      result.lint = {
        passed: false,
        output: truncateOutput(error?.message || String(error)),
      };
    }
  }

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
    lines.push("No build/test/lint configuration detected. Gate auto-passed.");
  }

  return lines.join("\n");
}

export async function getBackpressureShellCommand(workdir) {
  const mode = (process.env.AGENT_LOOP_GATE_MODE || "auto").toLowerCase();
  if (mode === "off") return "echo 'Backpressure gate disabled (AGENT_LOOP_GATE_MODE=off)'";

  const customCmd = process.env.AGENT_LOOP_GATE_CMD?.trim();
  if (customCmd) return customCmd;

  const type = detectProjectType(workdir);
  const commands = [];

  const build = await getBuildCommand(type, workdir);
  if (build) commands.push(build.join(" "));

  const test = await getTestCommand(type, workdir);
  if (test) commands.push(test.join(" "));

  return commands.length > 0 ? commands.join(" && ") : "echo 'No build/test detected'";
}

function detectProjectType(workdir) {
  if (existsSync(join(workdir, "package.json"))) return "node";
  if (existsSync(join(workdir, "Cargo.toml"))) return "rust";
  if (existsSync(join(workdir, "go.mod"))) return "go";
  if (
    existsSync(join(workdir, "pyproject.toml")) ||
    existsSync(join(workdir, "setup.py")) ||
    existsSync(join(workdir, "requirements.txt"))
  ) {
    return "python";
  }
  return "unknown";
}

async function readPackageJson(workdir) {
  const fs = await import("fs/promises");
  try {
    const raw = await fs.readFile(join(workdir, "package.json"), "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function getBuildCommand(type, workdir) {
  switch (type) {
    case "node": {
      const pkg = await readPackageJson(workdir);
      if (pkg?.scripts?.build) return ["npm", "run", "build"];
      if (pkg?.scripts?.typecheck) return ["npm", "run", "typecheck"];
      if (existsSync(join(workdir, "tsconfig.json"))) return ["npx", "tsc", "--noEmit"];
      return null;
    }
    case "rust":
      return ["cargo", "build"];
    case "go":
      return ["go", "build", "./..."];
    case "python":
      if (existsSync(join(workdir, "mypy.ini")) || existsSync(join(workdir, "pyrightconfig.json"))) {
        return ["python", "-m", "mypy", "."];
      }
      return null;
    default:
      return null;
  }
}

async function getTestCommand(type, workdir) {
  switch (type) {
    case "node": {
      const pkg = await readPackageJson(workdir);
      if (pkg?.scripts?.test) return ["npm", "test"];
      if (existsSync(join(workdir, "vitest.config.ts"))) return ["npx", "vitest", "run"];
      if (existsSync(join(workdir, "jest.config.ts")) || existsSync(join(workdir, "jest.config.js"))) {
        return ["npx", "jest"];
      }
      return null;
    }
    case "rust":
      return ["cargo", "test"];
    case "go":
      return ["go", "test", "./..."];
    case "python":
      if (existsSync(join(workdir, "pytest.ini")) || existsSync(join(workdir, "pyproject.toml"))) {
        return ["python", "-m", "pytest"];
      }
      return null;
    default:
      return null;
  }
}

async function getLintCommand(type, workdir) {
  switch (type) {
    case "node": {
      const pkg = await readPackageJson(workdir);
      if (pkg?.scripts?.lint) return ["npm", "run", "lint"];

      if (
        existsSync(join(workdir, ".eslintrc.js")) ||
        existsSync(join(workdir, ".eslintrc.json")) ||
        existsSync(join(workdir, "eslint.config.js")) ||
        existsSync(join(workdir, "eslint.config.mjs"))
      ) {
        return ["npx", "eslint", "."];
      }

      if (existsSync(join(workdir, "biome.json"))) {
        return ["npx", "biome", "check", "."];
      }

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

function truncateOutput(output, maxLength = 2000) {
  if (output.length <= maxLength) return output.trim();
  return "...[truncated]...\n" + output.slice(-maxLength).trim();
}
