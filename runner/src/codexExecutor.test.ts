import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildArgs, runCodex } from "./codexExecutor.js";

test("buildArgs keeps the git repo check for normal planning runs", () => {
  assert.deepEqual(
    buildArgs({
      cwd: "/tmp/project",
      prompt: "Plan the work",
      mode: "plan",
      materializedFromHistory: false
    }),
    ["exec", "--json", "-s", "read-only", "Plan the work"]
  );
});

test("buildArgs adds skip-git-repo-check for non-git planning runs", () => {
  assert.deepEqual(
    buildArgs({
      cwd: "/tmp/project",
      prompt: "Initialize a new repository here",
      mode: "plan",
      skipGitRepoCheck: true,
      materializedFromHistory: false
    }),
    ["exec", "--json", "--skip-git-repo-check", "-s", "read-only", "Initialize a new repository here"]
  );
});

test("buildArgs adds skip-git-repo-check for resumed implementation runs outside git", () => {
  assert.deepEqual(
    buildArgs({
      cwd: "/tmp/project",
      prompt: "Continue implementation",
      threadId: "thread_123",
      mode: "implement",
      skipGitRepoCheck: true,
      materializedFromHistory: true
    }),
    ["exec", "resume", "--json", "--skip-git-repo-check", "--full-auto", "thread_123", "Continue implementation"]
  );
});

test("runCodex closes stdin so codex does not hang waiting for additional input", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "remote-agent-codex-"));
  const binDir = path.join(tempRoot, "bin");
  await mkdir(binDir, { recursive: true });

  const fakeCodex = path.join(binDir, "codex");
  await writeFile(
    fakeCodex,
    `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("end", () => {
  console.log(JSON.stringify({ type: "thread.started", thread_id: "thread_fake" }));
  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Ready." } }));
});
`,
    { mode: 0o755 }
  );

  const result = await runCodex({
    cwd: tempRoot,
    prompt: "Plan",
    mode: "plan",
    materializedFromHistory: false,
    extraEnv: {
      PATH: `${binDir}:${process.env.PATH ?? ""}`
    }
  });

  assert.equal(result.threadId, "thread_fake");
  assert.equal(result.finalMessage, "Ready.");
});

test("runCodex times out a codex process that never finishes", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "remote-agent-codex-timeout-"));
  const binDir = path.join(tempRoot, "bin");
  await mkdir(binDir, { recursive: true });

  const fakeCodex = path.join(binDir, "codex");
  await writeFile(
    fakeCodex,
    `#!/usr/bin/env node
setInterval(() => {}, 1000);
`,
    { mode: 0o755 }
  );

  await assert.rejects(
    () => runCodex({
      cwd: tempRoot,
      prompt: "Plan",
      mode: "plan",
      materializedFromHistory: false,
      timeoutMs: 50,
      extraEnv: {
        PATH: `${binDir}:${process.env.PATH ?? ""}`
      }
    }),
    /timed out/
  );
});
