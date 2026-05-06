import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const hookPath = new URL("../hooks/agent-loop-stop.mjs", import.meta.url);

async function makeLoop(stateOverrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "agent-loop-codex-"));
  const loopId = "demo-loop";
  const loopDir = join(root, ".agent-loop", "codex", "loops", loopId);
  await mkdir(loopDir, { recursive: true });
  await writeFile(
    join(root, ".agent-loop", "codex", "active-loop.json"),
    JSON.stringify({ loop_id: loopId }, null, 2),
  );
  await writeFile(
    join(loopDir, "state.json"),
    JSON.stringify(
      {
        loop_id: loopId,
        objective: "Ship the demo loop",
        status: "running",
        continue_on_stop: true,
        awaiting_user: false,
        stop_hook_active: false,
        next_action: "Run the next ready task.",
        tasks: [
          {
            key: "todo:1",
            title: "Implement demo",
            status: "pending",
            depends_on: [],
            files: ["src/demo.ts"],
            validation: "npm test",
            attempts: 0
          }
        ],
        ...stateOverrides
      },
      null,
      2,
    ),
  );
  return root;
}

function runStopHook(cwd) {
  const result = spawnSync(process.execPath, [hookPath.pathname], {
    cwd,
    encoding: "utf8",
    input: JSON.stringify({ hook_event_name: "Stop" }),
  });
  assert.equal(result.stderr, "");
  assert.equal(result.status, 0);
  return result.stdout.trim() ? JSON.parse(result.stdout) : {};
}

describe("agent-loop Stop hook", () => {
  it("continues an active loop with pending work", async () => {
    const cwd = await makeLoop();

    const output = runStopHook(cwd);

    assert.equal(output.decision, "block");
    assert.match(output.reason, /Continue Agent Loop/);
    assert.match(output.additionalContext, /demo-loop/);
    assert.match(output.additionalContext, /Run the next ready task/);
  });

  it("does not continue when the loop is waiting for user input", async () => {
    const cwd = await makeLoop({ awaiting_user: true });

    const output = runStopHook(cwd);

    assert.deepEqual(output, {});
  });

  it("does not continue when the loop is complete", async () => {
    const cwd = await makeLoop({ status: "completed" });

    const output = runStopHook(cwd);

    assert.deepEqual(output, {});
  });
});
