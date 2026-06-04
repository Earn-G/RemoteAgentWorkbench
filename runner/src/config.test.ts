import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRunnerConfig } from "./config.js";

test("runner config derives grouped paths and codex live directory", () => {
  const config = createRunnerConfig({
    SERVER_BASE_URL: "https://workbench.example.com/",
    RUNNER_DATA_ROOT: "~/RemoteAgentWorkbenchData",
    RUNNER_CODEX_HOME: "",
    RUNNER_CODEX_PROFILES_ROOT: "~/codex-profiles",
    GITLAB_BASE_URL: "https://gitlab.example.com",
    RUNNER_REPORTS_PUBLIC_BASE_URL: "https://github.com/your-org/reports"
  });

  assert.equal(config.serverBaseURL, "https://workbench.example.com");
  assert.equal(config.dataRoot, path.join(os.homedir(), "RemoteAgentWorkbenchData"));
  assert.equal(config.paths.requestJournalPath, path.join(os.homedir(), "RemoteAgentWorkbenchData", "logs", "runner-requests.jsonl"));
  assert.equal(config.codex.liveDirectory, path.join(os.homedir(), ".codex"));
  assert.equal(config.codex.profilesRoot, path.join(os.homedir(), "codex-profiles"));
  assert.equal(config.codexRunTimeoutMs, 1800000);
});

test("runner config allows overriding the Codex run timeout", () => {
  const config = createRunnerConfig({
    RUNNER_CODEX_RUN_TIMEOUT_MS: "60000"
  });

  assert.equal(config.codexRunTimeoutMs, 60000);
});

test("runner config rejects invalid URLs", () => {
  assert.throws(
    () => createRunnerConfig({ SERVER_BASE_URL: "not-a-url" }),
    /SERVER_BASE_URL/
  );
});
