import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createServerConfig } from "./config.js";

test("server config normalizes values and returns a redacted public summary", () => {
  const config = createServerConfig({
    HOST: "127.0.0.1",
    PORT: "8787",
    PUBLIC_BASE_URL: "https://workbench.example.com/",
    CORS_ORIGINS: "https://app.example.com,https://admin.example.com",
    DATA_ROOT: "~/RemoteAgentWorkbenchServerData",
    USER_BEARER_TOKEN: "user-secret",
    RUNNER_SHARED_SECRET: "runner-secret",
    DEPLOY_DIR: "/opt/remote-agent-workbench/server"
  });

  const summary = config.toPublicSummary({
    profiles: ["1000", "plus"],
    activeProfileName: "plus"
  });

  assert.equal(config.publicBaseURL, "https://workbench.example.com");
  assert.equal(config.dataRoot, path.join(os.homedir(), "RemoteAgentWorkbenchServerData"));
  assert.equal(config.runner.claimTimeoutMs, 35 * 60 * 1000);
  assert.deepEqual(summary.corsOrigins, ["https://app.example.com", "https://admin.example.com"]);
  assert.equal(summary.userAuthConfigured, true);
  assert.equal(summary.runnerAuthConfigured, true);
  assert.equal(summary.runner.claimTimeoutMs, 35 * 60 * 1000);
  assert.deepEqual(summary.codexConfig.protectedProfileNames, ["1000", "plus"]);
});

test("server config allows overriding runner claim timeout", () => {
  const config = createServerConfig({
    RUNNER_CLAIM_TIMEOUT_MS: "60000"
  });

  assert.equal(config.runner.claimTimeoutMs, 60000);
});

test("server config rejects invalid public URLs", () => {
  assert.throws(
    () => createServerConfig({ PUBLIC_BASE_URL: "not-a-url" }),
    /PUBLIC_BASE_URL/
  );
});
