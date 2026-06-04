import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { config } from "./config.js";
import { RepositoryManager } from "./repositoryManager.js";

const execFileAsync = promisify(execFile);

async function execGit(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.toString().trim();
}

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

async function createBareRepo(repoPath: string): Promise<void> {
  await fs.mkdir(path.dirname(repoPath), { recursive: true });
  await execFileAsync("git", ["init", "--bare", repoPath]);
}

async function installPrePushHook(repoPath: string, body: string): Promise<void> {
  const hookPath = path.join(repoPath, ".git", "hooks", "pre-push");
  await fs.writeFile(hookPath, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  await fs.chmod(hookPath, 0o755);
}

test("repository manager executes local tasks in the real repository path", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "raw-repo-manager-"));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const repoPath = await createCommittedRepo(tempRoot);
  const manager = new RepositoryManager(path.join(tempRoot, "repo-cache"), path.join(tempRoot, "workspaces"));

  const prepared = await manager.prepareWorkspace("task_local", repoPath, "main");
  const canonicalRepoPath = await fs.realpath(repoPath);

  assert.equal(prepared.sourceRepoPath, canonicalRepoPath);
  assert.equal(prepared.workspacePath, canonicalRepoPath);
  assert.equal(prepared.branchName, "codex/task_local");
  assert.equal(prepared.isGitRepository, true);
  assert.equal(await manager.currentBranch(canonicalRepoPath), "codex/task_local");

  let workspaceExists = true;
  try {
    await fs.access(path.join(tempRoot, "workspaces", "task_local"));
  } catch {
    workspaceExists = false;
  }
  assert.equal(workspaceExists, false);
});

test("repository manager keeps existing non-git directories usable for task execution", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "raw-repo-manager-non-git-"));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const directoryPath = path.join(tempRoot, "workspace");
  await fs.mkdir(directoryPath, { recursive: true });
  await fs.writeFile(path.join(directoryPath, "README.md"), "bootstrap me\n", "utf8");
  const manager = new RepositoryManager(path.join(tempRoot, "repo-cache"), path.join(tempRoot, "workspaces"));

  const inspection = await manager.inspectWorkspace(directoryPath);
  const prepared = await manager.prepareWorkspace("task_bootstrap", directoryPath, "main");
  const canonicalDirectoryPath = await fs.realpath(directoryPath);

  assert.equal(inspection.sourceRepoPath, canonicalDirectoryPath);
  assert.equal(inspection.isGitRepository, false);
  assert.equal(inspection.currentBranch, undefined);
  assert.equal(inspection.hasUncommittedChanges, false);
  assert.match(inspection.statusSummary ?? "", /Git has not been initialized yet/i);

  assert.equal(prepared.sourceRepoPath, canonicalDirectoryPath);
  assert.equal(prepared.workspacePath, canonicalDirectoryPath);
  assert.equal(prepared.isGitRepository, false);
  assert.equal(prepared.branchName, undefined);
});

test("repository manager creates missing local paths as plain workspaces instead of cloning", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "raw-repo-manager-missing-local-"));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const directoryPath = path.join(tempRoot, "new-folder");
  const manager = new RepositoryManager(path.join(tempRoot, "repo-cache"), path.join(tempRoot, "workspaces"));

  const prepared = await manager.prepareWorkspace("task_plain", directoryPath, "main");

  assert.equal(prepared.sourceRepoPath, directoryPath);
  assert.equal(prepared.workspacePath, directoryPath);
  assert.equal(prepared.isGitRepository, false);
  assert.equal(prepared.branchName, undefined);
  await fs.access(directoryPath);
});

test("repository manager refuses to switch a dirty repository onto a new task branch", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "raw-repo-manager-dirty-"));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const repoPath = await createCommittedRepo(tempRoot);
  await fs.writeFile(path.join(repoPath, "README.md"), "dirty\n", "utf8");
  const manager = new RepositoryManager(path.join(tempRoot, "repo-cache"), path.join(tempRoot, "workspaces"));

  await assert.rejects(
    manager.prepareWorkspace("task_dirty", repoPath, "main"),
    /has uncommitted changes/
  );
  assert.equal(await manager.currentBranch(repoPath), "main");
});

test("repository manager inspects the current dirty workspace state", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "raw-repo-manager-inspect-"));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const repoPath = await createCommittedRepo(tempRoot);
  await fs.writeFile(path.join(repoPath, "README.md"), "dirty\n", "utf8");
  await fs.writeFile(path.join(repoPath, "notes.txt"), "local note\n", "utf8");
  const manager = new RepositoryManager(path.join(tempRoot, "repo-cache"), path.join(tempRoot, "workspaces"));

  const inspection = await manager.inspectWorkspace(repoPath);
  const canonicalRepoPath = await fs.realpath(repoPath);

  assert.equal(inspection.sourceRepoPath, canonicalRepoPath);
  assert.equal(inspection.isGitRepository, true);
  assert.equal(inspection.currentBranch, "main");
  assert.equal(inspection.hasUncommittedChanges, true);
  assert.match(inspection.statusPorcelain ?? "", /README\.md/);
  assert.match(inspection.statusPorcelain ?? "", /notes\.txt/);
});

test("repository manager can discard dirty workspace changes before a fresh task branch", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "raw-repo-manager-clear-"));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const repoPath = await createCommittedRepo(tempRoot);
  await fs.writeFile(path.join(repoPath, "README.md"), "dirty\n", "utf8");
  await fs.writeFile(path.join(repoPath, "notes.txt"), "local note\n", "utf8");
  const manager = new RepositoryManager(path.join(tempRoot, "repo-cache"), path.join(tempRoot, "workspaces"));

  await manager.discardAllChanges(repoPath);

  const inspection = await manager.inspectWorkspace(repoPath);
  assert.equal(inspection.hasUncommittedChanges, false);
  await assert.rejects(fs.access(path.join(repoPath, "notes.txt")));
});

test("repository manager can execute an approved protected git reset command", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "raw-repo-manager-protected-reset-"));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const repoPath = await createCommittedRepo(tempRoot);
  await fs.writeFile(path.join(repoPath, "README.md"), "dirty\n", "utf8");
  const manager = new RepositoryManager(path.join(tempRoot, "repo-cache"), path.join(tempRoot, "workspaces"));

  await manager.executeProtectedGitCommand(repoPath, {
    kind: "reset_hard",
    args: ["reset", "--hard", "HEAD"]
  });

  const readme = await fs.readFile(path.join(repoPath, "README.md"), "utf8");
  assert.equal(readme, "hello\n");
});

test("repository manager allows continuing an already checked out task branch", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "raw-repo-manager-continue-"));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const repoPath = await createCommittedRepo(tempRoot);
  await execGit(["checkout", "-b", "codex/task_continue"], repoPath);
  await fs.writeFile(path.join(repoPath, "README.md"), "task progress\n", "utf8");
  const manager = new RepositoryManager(path.join(tempRoot, "repo-cache"), path.join(tempRoot, "workspaces"));

  const prepared = await manager.prepareWorkspace("task_continue", repoPath, "main");
  const canonicalRepoPath = await fs.realpath(repoPath);

  assert.equal(prepared.workspacePath, canonicalRepoPath);
  assert.equal(await manager.currentBranch(canonicalRepoPath), "codex/task_continue");
});

test("repository manager can keep working on the current checked out branch when requested", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "raw-repo-manager-current-branch-"));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const repoPath = await createCommittedRepo(tempRoot);
  await execGit(["checkout", "-b", "feature/item_ui"], repoPath);
  const manager = new RepositoryManager(path.join(tempRoot, "repo-cache"), path.join(tempRoot, "workspaces"));

  const prepared = await manager.prepareWorkspace("task_current_branch", repoPath, "main", {
    useCurrentBranch: true
  });

  assert.equal(prepared.branchName, "feature/item_ui");
  assert.equal(await manager.currentBranch(repoPath), "feature/item_ui");
});

test("repository manager switches a clean repository back to the expected task branch before Git actions", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "raw-repo-manager-ensure-branch-"));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const repoPath = await createCommittedRepo(tempRoot);
  await execGit(["checkout", "-b", "feature/item_ui"], repoPath);
  await execGit(["checkout", "main"], repoPath);
  const manager = new RepositoryManager(path.join(tempRoot, "repo-cache"), path.join(tempRoot, "workspaces"));

  const branch = await manager.ensureActiveBranch(repoPath, "feature/item_ui");

  assert.equal(branch, "feature/item_ui");
  assert.equal(await manager.currentBranch(repoPath), "feature/item_ui");
});

test("repository manager refuses to switch branches automatically when the current branch is dirty", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "raw-repo-manager-ensure-branch-dirty-"));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const repoPath = await createCommittedRepo(tempRoot);
  await execGit(["checkout", "-b", "feature/item_ui"], repoPath);
  await execGit(["checkout", "main"], repoPath);
  await fs.writeFile(path.join(repoPath, "README.md"), "dirty change\n", "utf8");
  const manager = new RepositoryManager(path.join(tempRoot, "repo-cache"), path.join(tempRoot, "workspaces"));

  await assert.rejects(
    manager.ensureActiveBranch(repoPath, "feature/item_ui"),
    /will not switch branches automatically/
  );
  assert.equal(await manager.currentBranch(repoPath), "main");
});

test("repository manager allocates a unique readable branch when the preferred branch already exists", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "raw-repo-manager-duplicate-"));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const repoPath = await createCommittedRepo(tempRoot);
  await execGit(["checkout", "-b", "feature/item_ui"], repoPath);
  await execGit(["checkout", "main"], repoPath);
  const manager = new RepositoryManager(path.join(tempRoot, "repo-cache"), path.join(tempRoot, "workspaces"));

  const prepared = await manager.prepareWorkspace("task_duplicate", repoPath, "main", {
    preferredBranchName: "feature/item_ui"
  });

  assert.equal(prepared.branchName, "feature/item_ui_dupl");
  assert.equal(await manager.currentBranch(repoPath), "feature/item_ui_dupl");
});

test("repository manager allocates a unique readable branch when the preferred branch already exists on origin", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "raw-repo-manager-remote-duplicate-"));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const repoPath = await createCommittedRepo(tempRoot);
  const remoteRepo = path.join(tempRoot, "origin.git");
  await createBareRepo(remoteRepo);
  await execGit(["remote", "add", "origin", remoteRepo], repoPath);
  await execGit(["checkout", "-b", "feature/item_ui"], repoPath);
  await execGit(["push", "-u", "origin", "feature/item_ui"], repoPath);
  await execGit(["checkout", "main"], repoPath);
  await execGit(["branch", "-D", "feature/item_ui"], repoPath);
  const manager = new RepositoryManager(path.join(tempRoot, "repo-cache"), path.join(tempRoot, "workspaces"));

  const prepared = await manager.prepareWorkspace("task_duplicate", repoPath, "main", {
    preferredBranchName: "feature/item_ui"
  });

  assert.equal(prepared.branchName, "feature/item_ui_dupl");
  assert.equal(await manager.currentBranch(repoPath), "feature/item_ui_dupl");
});

test("repository manager inspects current branch push state when origin already has the branch", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "raw-repo-manager-push-state-"));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const repoPath = await createCommittedRepo(tempRoot);
  const remoteRepo = path.join(tempRoot, "origin.git");
  await createBareRepo(remoteRepo);
  await execGit(["remote", "add", "origin", pathToFileURL(remoteRepo).href], repoPath);
  await execGit(["checkout", "-b", "feature/item_ui"], repoPath);
  await execGit(["push", "-u", "origin", "feature/item_ui"], repoPath);
  await fs.writeFile(path.join(repoPath, "README.md"), "local only\n", "utf8");
  await execGit(["commit", "-am", "local advance"], repoPath);

  const manager = new RepositoryManager(path.join(tempRoot, "repo-cache"), path.join(tempRoot, "workspaces"));
  const pushState = await manager.inspectCurrentBranchPushState(repoPath);

  assert.deepEqual(pushState, {
    branchName: "feature/item_ui",
    trackingBranch: "origin/feature/item_ui",
    remoteBranchExists: true,
    localAheadCount: 1,
    remoteAheadCount: 0
  });
});

test("repository manager reports when origin does not have the current branch", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "raw-repo-manager-push-state-missing-"));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const repoPath = await createCommittedRepo(tempRoot);
  const remoteRepo = path.join(tempRoot, "origin.git");
  await createBareRepo(remoteRepo);
  await execGit(["remote", "add", "origin", pathToFileURL(remoteRepo).href], repoPath);
  await execGit(["checkout", "-b", "feature/item_ui"], repoPath);

  const manager = new RepositoryManager(path.join(tempRoot, "repo-cache"), path.join(tempRoot, "workspaces"));
  const pushState = await manager.inspectCurrentBranchPushState(repoPath);

  assert.deepEqual(pushState, {
    branchName: "feature/item_ui",
    trackingBranch: "origin/feature/item_ui",
    remoteBranchExists: false,
    localAheadCount: 0,
    remoteAheadCount: 0
  });
});

test("repository manager reports no pushable branch for non-git directories", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "raw-repo-manager-non-git-push-state-"));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const directoryPath = path.join(tempRoot, "workspace");
  await fs.mkdir(directoryPath, { recursive: true });
  const manager = new RepositoryManager(path.join(tempRoot, "repo-cache"), path.join(tempRoot, "workspaces"));

  const pushState = await manager.inspectCurrentBranchPushState(directoryPath);

  assert.deepEqual(pushState, {
    remoteBranchExists: false,
    localAheadCount: 0,
    remoteAheadCount: 0
  });
});

test("repository manager detects the review platform from origin", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "raw-repo-manager-platform-"));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const repoPath = await createCommittedRepo(tempRoot);
  await execGit(["remote", "add", "origin", "git@github.com:acme/demo.git"], repoPath);
  const manager = new RepositoryManager(path.join(tempRoot, "repo-cache"), path.join(tempRoot, "workspaces"));

  const prepared = await manager.prepareWorkspace("task_platform", repoPath, "main");

  assert.equal(prepared.reviewPlatform, "github");
});

test("repository manager creates GitLab merge requests against the repository host", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "raw-repo-manager-gitlab-mr-"));
  const originalFetch = globalThis.fetch;
  const originalToken = config.gitlab.token;
  const originalBaseURL = config.gitlab.baseURL;

  t.after(async () => {
    globalThis.fetch = originalFetch;
    config.gitlab.token = originalToken;
    config.gitlab.baseURL = originalBaseURL;
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const gitlabHostRoot = path.join(tempRoot, "gitlab-host");
  const remoteRepo = path.join(gitlabHostRoot, "team", "demo.git");
  await createBareRepo(remoteRepo);

  const repoPath = await createCommittedRepo(tempRoot);
  await execGit(["checkout", "-b", "feature/item_ui"], repoPath);
  await execGit(["remote", "add", "origin", "https://gitlab.example.com/team/demo.git"], repoPath);
  await execGit(["remote", "set-url", "--push", "origin", pathToFileURL(remoteRepo).href], repoPath);

  config.gitlab.token = "gitlab-token";
  config.gitlab.baseURL = "https://gitlab.com";

  let requestedURL = "";
  let requestedBody = "";
  let requestedToken = "";

  globalThis.fetch = async (input, init) => {
    requestedURL = String(input);
    requestedToken = String((init?.headers as Record<string, string>)["PRIVATE-TOKEN"] ?? "");
    requestedBody = String(init?.body ?? "");

    return new Response(
      JSON.stringify({
        web_url: "https://gitlab.example.com/team/demo/-/merge_requests/1"
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      }
    );
  };

  const manager = new RepositoryManager(path.join(tempRoot, "repo-cache"), path.join(tempRoot, "workspaces"));
  const review = await manager.createReviewRequest(repoPath, "main", "Item UI polish", "Please review.");

  assert.equal(review.platform, "gitlab");
  assert.equal(review.url, "https://gitlab.example.com/team/demo/-/merge_requests/1");
  assert.equal(
    requestedURL,
    "https://gitlab.example.com/api/v4/projects/team%2Fdemo/merge_requests"
  );
  assert.equal(requestedToken, "gitlab-token");
  assert.match(requestedBody, /"source_branch":"feature\/item_ui"/);
  assert.match(requestedBody, /"target_branch":"main"/);
  assert.match(requestedBody, /"title":"Draft: Item UI polish"/);
  assert.match(
    await execGit(["--git-dir", remoteRepo, "rev-parse", "--verify", "refs/heads/feature/item_ui"], tempRoot),
    /^[0-9a-f]{40}$/
  );
});

test("repository manager explains local pre-push hook failures before review creation", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "raw-repo-manager-push-hook-"));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const remoteRepo = path.join(tempRoot, "origin.git");
  await createBareRepo(remoteRepo);

  const repoPath = await createCommittedRepo(tempRoot);
  await execGit(["checkout", "-b", "feature/item_ui"], repoPath);
  await execGit(["remote", "add", "origin", "https://github.com/acme/demo.git"], repoPath);
  await execGit(["remote", "set-url", "--push", "origin", pathToFileURL(remoteRepo).href], repoPath);
  await execGit(["config", "branch.feature/item_ui.remote", "origin"], repoPath);
  await execGit(["config", "branch.feature/item_ui.merge", "refs/heads/main"], repoPath);
  await installPrePushHook(repoPath, "echo 'hook blocked' >&2\nexit 1");

  const manager = new RepositoryManager(path.join(tempRoot, "repo-cache"), path.join(tempRoot, "workspaces"));

  let message = "";
  try {
    await manager.createReviewRequest(repoPath, "main", "Item UI polish", "Please review.");
    assert.fail("Expected createReviewRequest to fail when the local pre-push hook rejects the push");
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }

  assert.match(message, /before creating the review request/);
  assert.match(message, /local pre-push hook in this workspace rejected the push/i);
  assert.match(message, /track origin\/main instead of origin\/feature\/item_ui/i);
});

test("repository manager refuses to create a review request from detached HEAD without a local branch", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "raw-repo-manager-detached-review-"));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const remoteRepo = path.join(tempRoot, "origin.git");
  await createBareRepo(remoteRepo);

  const repoPath = await createCommittedRepo(tempRoot);
  await execGit(["checkout", "-b", "feature/item_ui"], repoPath);
  await execGit(["remote", "add", "origin", "https://github.com/acme/demo.git"], repoPath);
  await execGit(["remote", "set-url", "--push", "origin", pathToFileURL(remoteRepo).href], repoPath);
  await execGit(["checkout", "--detach", "HEAD"], repoPath);

  const manager = new RepositoryManager(path.join(tempRoot, "repo-cache"), path.join(tempRoot, "workspaces"));

  let message = "";
  try {
    await manager.createReviewRequest(repoPath, "main", "Item UI polish", "Please review.");
    assert.fail("Expected createReviewRequest to fail when the repository is on detached HEAD");
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }

  assert.match(message, /not currently on a local branch/i);
  assert.match(message, /will not create a new remote branch for a review request from detached HEAD/i);
});

test("repository manager times out hanging pushes and points at local hooks", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "raw-repo-manager-push-timeout-"));
  const originalPushTimeout = config.gitPushTimeoutMs;

  t.after(async () => {
    config.gitPushTimeoutMs = originalPushTimeout;
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const remoteRepo = path.join(tempRoot, "origin.git");
  await createBareRepo(remoteRepo);

  const repoPath = await createCommittedRepo(tempRoot);
  await execGit(["checkout", "-b", "feature/item_ui"], repoPath);
  await execGit(["remote", "add", "origin", pathToFileURL(remoteRepo).href], repoPath);
  await installPrePushHook(repoPath, "sleep 1\nexit 0");

  config.gitPushTimeoutMs = 100;

  const manager = new RepositoryManager(path.join(tempRoot, "repo-cache"), path.join(tempRoot, "workspaces"));

  let message = "";
  try {
    await manager.pushCurrentBranch(repoPath);
    assert.fail("Expected pushCurrentBranch to time out when the local pre-push hook hangs");
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }

  assert.match(message, /timed out on the Mac runner/i);
  assert.match(message, /does not bypass Git hooks automatically/i);
  assert.match(message, /local pre-push hook is present/i);
});

test("repository manager does not blame a local hook for non-fast-forward push failures", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "raw-repo-manager-nff-hook-"));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const remoteRepo = path.join(tempRoot, "origin.git");
  const otherClone = path.join(tempRoot, "other-clone");
  await createBareRepo(remoteRepo);

  const repoPath = await createCommittedRepo(tempRoot);
  await execGit(["checkout", "-b", "feature/item_ui"], repoPath);
  await execGit(["remote", "add", "origin", pathToFileURL(remoteRepo).href], repoPath);
  await execGit(["push", "-u", "origin", "feature/item_ui"], repoPath);
  await installPrePushHook(repoPath, "exit 0");

  await execFileAsync("git", ["clone", remoteRepo, otherClone]);
  await execFileAsync("git", ["-C", otherClone, "config", "user.name", "RemoteAgentWorkbench"], { cwd: tempRoot });
  await execFileAsync("git", ["-C", otherClone, "config", "user.email", "workbench@example.com"], { cwd: tempRoot });
  await execFileAsync("git", ["-C", otherClone, "checkout", "feature/item_ui"], { cwd: tempRoot });
  await fs.writeFile(path.join(otherClone, "README.md"), "remote-only\n", "utf8");
  await execFileAsync("git", ["-C", otherClone, "commit", "-am", "remote advance"], { cwd: tempRoot });
  await execFileAsync("git", ["-C", otherClone, "push", "origin", "feature/item_ui"], { cwd: tempRoot });

  const manager = new RepositoryManager(path.join(tempRoot, "repo-cache"), path.join(tempRoot, "workspaces"));

  let message = "";
  try {
    await manager.pushCurrentBranch(repoPath);
    assert.fail("Expected pushCurrentBranch to fail when origin is ahead");
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }

  assert.match(message, /will not force-push automatically/i);
  assert.doesNotMatch(message, /local pre-push hook in this workspace rejected the push/i);
});

test("repository manager creates GitLab merge requests from the push project into the fetch project", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "raw-repo-manager-gitlab-fork-mr-"));
  const originalFetch = globalThis.fetch;
  const originalToken = config.gitlab.token;
  const originalBaseURL = config.gitlab.baseURL;

  t.after(async () => {
    globalThis.fetch = originalFetch;
    config.gitlab.token = originalToken;
    config.gitlab.baseURL = originalBaseURL;
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const gitlabHostRoot = path.join(tempRoot, "gitlab-host");
  const sourceRepo = path.join(gitlabHostRoot, "user", "demo.git");
  await createBareRepo(sourceRepo);

  const repoPath = await createCommittedRepo(tempRoot);
  await execGit(["checkout", "-b", "feature/item_ui"], repoPath);
  await execGit(["remote", "add", "origin", "https://gitlab.example.com/team/demo.git"], repoPath);
  await execGit(["remote", "set-url", "--push", "origin", "https://gitlab.example.com/user/demo.git"], repoPath);
  await execGit(["config", `url.${pathToFileURL(sourceRepo).href}.insteadOf`, "https://gitlab.example.com/user/demo.git"], repoPath);

  config.gitlab.token = "gitlab-token";
  config.gitlab.baseURL = "https://gitlab.com";

  const requestedURLs: string[] = [];
  const requestBodies: string[] = [];

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    requestedURLs.push(url);
    requestBodies.push(String(init?.body ?? ""));

    if (url === "https://gitlab.example.com/api/v4/projects/team%2Fdemo") {
      return new Response(
        JSON.stringify({ id: 321 }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    }

    return new Response(
      JSON.stringify({
        web_url: "https://gitlab.example.com/team/demo/-/merge_requests/7"
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      }
    );
  };

  const manager = new RepositoryManager(path.join(tempRoot, "repo-cache"), path.join(tempRoot, "workspaces"));
  const review = await manager.createReviewRequest(repoPath, "main", "Item UI polish", "Please review.");

  assert.equal(review.platform, "gitlab");
  assert.equal(review.url, "https://gitlab.example.com/team/demo/-/merge_requests/7");
  assert.deepEqual(requestedURLs, [
    "https://gitlab.example.com/api/v4/projects/team%2Fdemo",
    "https://gitlab.example.com/api/v4/projects/user%2Fdemo/merge_requests"
  ]);
  assert.match(requestBodies[1] ?? "", /"source_branch":"feature\/item_ui"/);
  assert.match(requestBodies[1] ?? "", /"target_branch":"main"/);
  assert.match(requestBodies[1] ?? "", /"target_project_id":321/);
  assert.match(
    await execGit(["--git-dir", sourceRepo, "rev-parse", "--verify", "refs/heads/feature/item_ui"], tempRoot),
    /^[0-9a-f]{40}$/
  );
});
