import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { classifyProtectedGitCommand, createGitGuardEnvironment, readBlockedProtectedGitCommand } from "./gitGuard.js";

const execFileAsync = promisify(execFile);

async function createCommittedRepo(root: string): Promise<string> {
  const repoPath = path.join(root, "repo");
  await fs.mkdir(repoPath, { recursive: true });
  await execFileAsync("git", ["init", "-b", "main"], { cwd: repoPath });
  await execFileAsync("git", ["config", "user.name", "RemoteAgentWorkbench"], { cwd: repoPath });
  await execFileAsync("git", ["config", "user.email", "workbench@example.com"], { cwd: repoPath });
  await fs.writeFile(path.join(repoPath, "README.md"), "hello\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd: repoPath });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: repoPath });
  return repoPath;
}

test("git guard classifies reset --hard and clean -fd commands", () => {
  assert.deepEqual(classifyProtectedGitCommand(["reset", "--hard", "HEAD"]), {
    kind: "reset_hard",
    args: ["reset", "--hard", "HEAD"]
  });
  assert.deepEqual(classifyProtectedGitCommand(["clean", "-fdx"]), {
    kind: "clean_fd",
    args: ["clean", "-fdx"]
  });
  assert.equal(classifyProtectedGitCommand(["status"]), undefined);
});

test("git guard blocks unapproved reset --hard and records the request", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "raw-git-guard-block-"));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const repoPath = await createCommittedRepo(tempRoot);
  await fs.writeFile(path.join(repoPath, "README.md"), "dirty\n", "utf8");
  const guard = await createGitGuardEnvironment();
  t.after(async () => {
    await guard.cleanup();
  });

  await assert.rejects(
    execFileAsync("git", ["reset", "--hard", "HEAD"], {
      cwd: repoPath,
      env: {
        ...process.env,
        ...guard.extraEnv
      }
    }),
    /REMOTE_AGENT_GIT_GUARD_BLOCKED/
  );

  assert.deepEqual(await readBlockedProtectedGitCommand(guard.requestPath), {
    kind: "reset_hard",
    args: ["reset", "--hard", "HEAD"]
  });
});

test("git guard allows reset --hard when the current turn is explicitly authorized", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "raw-git-guard-allow-"));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const repoPath = await createCommittedRepo(tempRoot);
  await fs.writeFile(path.join(repoPath, "README.md"), "dirty\n", "utf8");
  const guard = await createGitGuardEnvironment({
    allowedKinds: ["reset_hard"]
  });
  t.after(async () => {
    await guard.cleanup();
  });

  await execFileAsync("git", ["reset", "--hard", "HEAD"], {
    cwd: repoPath,
    env: {
      ...process.env,
      ...guard.extraEnv
    }
  });

  const readme = await fs.readFile(path.join(repoPath, "README.md"), "utf8");
  assert.equal(readme, "hello\n");
  assert.equal(await readBlockedProtectedGitCommand(guard.requestPath), undefined);
});
