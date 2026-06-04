import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function readFile(relativePath) {
  return fs.readFile(path.join(repoRoot, relativePath), "utf8");
}

test("config generator refreshes dev and deploy templates with the expected fields", async () => {
  await execFileAsync(process.execPath, ["deploy/generate-config-examples.mjs"], { cwd: repoRoot });

  const serverDevEnv = await readFile("server/.env.example");
  const runnerDevEnv = await readFile("runner/.env.example");
  const runnerProdEnv = await readFile("deploy/runner/env.production.example");
  const launchAgent = await readFile("deploy/runner/com.remote-agent-workbench.runner.plist.example");

  assert.match(serverDevEnv, /^DATA_ROOT=$/m);
  assert.match(serverDevEnv, /^DATABASE_PATH=$/m);
  assert.match(serverDevEnv, /^TASK_RETENTION_DAYS=30$/m);
  assert.match(serverDevEnv, /^USER_BEARER_TOKEN=$/m);

  assert.match(runnerDevEnv, /^RUNNER_TASKS_DIR=$/m);
  assert.match(runnerDevEnv, /^RUNNER_PROJECTS_FILE=$/m);
  assert.match(runnerDevEnv, /^RUNNER_DIRECTORIES_FILE=$/m);
  assert.match(runnerDevEnv, /^RUNNER_GIT_PUSH_TIMEOUT_MS=120000$/m);
  assert.match(runnerDevEnv, /^GITLAB_BASE_URL=https:\/\/gitlab\.com$/m);
  assert.match(runnerDevEnv, /^RUNNER_CODEX_PROFILE_TEMPLATE=1000$/m);

  assert.match(runnerProdEnv, /^RUNNER_REQUEST_JOURNAL_PATH=~\/RemoteAgentWorkbenchData\/logs\/runner-requests\.jsonl$/m);
  assert.match(launchAgent, /com\.remoteagentworkbench\.runner/);
  assert.doesNotMatch(launchAgent, /com\.fernando/);
});

test("config self-check passes for generated templates", async () => {
  await execFileAsync(process.execPath, [
    "scripts/check-config.mjs",
    "--server-env", "deploy/server/env.production.example",
    "--runner-env", "deploy/runner/env.production.example",
    "--host-env", "deploy/runner/runner-host.env.example",
    "--projects", "deploy/examples/projects.example.json",
    "--directories", "deploy/examples/directories.example.json"
  ], { cwd: repoRoot });
});

test("config self-check fails for invalid URLs and schema", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "raw-config-check-"));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const serverEnvPath = path.join(tempRoot, "server.env");
  const projectsPath = path.join(tempRoot, "projects.json");

  await fs.writeFile(serverEnvPath, "PUBLIC_BASE_URL=not-a-url\nPORT=8787\nTASK_RETENTION_DAYS=30\nRUNNER_OFFLINE_THRESHOLD_MS=45000\nDATA_ROOT=/tmp/server\nDATABASE_PATH=/tmp/server/db.sqlite\n", "utf8");
  await fs.writeFile(projectsPath, JSON.stringify([{ id: "missing-fields" }]), "utf8");

  await assert.rejects(
    execFileAsync(process.execPath, [
      "scripts/check-config.mjs",
      "--server-env", serverEnvPath,
      "--projects", projectsPath
    ], { cwd: repoRoot }),
    (error) => {
      const typed = error;
      return typed && typeof typed === "object" && "code" in typed && Number(typed.code) === 1;
    }
  );
});
