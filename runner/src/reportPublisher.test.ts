import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { config } from "./config.js";
import type { TaskSnapshot } from "./models.js";
import { ReportPublisher } from "./reportPublisher.js";
import { TaskHistoryRecorder } from "./taskHistory.js";
import { formatBeijingDateTime, formatBeijingFileTimestamp } from "./time.js";

const execFileAsync = promisify(execFile);

async function execGit(args: string[], cwd?: string): Promise<void> {
  await execFileAsync("git", args, cwd ? { cwd } : undefined);
}

async function installPrePushHook(repoPath: string, body: string): Promise<void> {
  const hookPath = path.join(repoPath, ".git", "hooks", "pre-push");
  await fs.writeFile(hookPath, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  await fs.chmod(hookPath, 0o755);
}

async function setupWorkspaceRepo(tempRoot: string): Promise<string> {
  const workspaceRepo = path.join(tempRoot, "workspace-repo");
  await execGit(["init", "-b", "main", workspaceRepo]);
  await execGit(["-C", workspaceRepo, "config", "user.name", "RemoteAgentWorkbench Tests"]);
  await execGit(["-C", workspaceRepo, "config", "user.email", "tests@example.com"]);
  await fs.writeFile(path.join(workspaceRepo, "feature.txt"), "base line\n", "utf8");
  await execGit(["-C", workspaceRepo, "add", "feature.txt"]);
  await execGit(["-C", workspaceRepo, "commit", "-m", "chore: seed base"]);
  await execGit(["-C", workspaceRepo, "checkout", "-b", "codex/task_report"]);
  await fs.writeFile(path.join(workspaceRepo, "feature.txt"), "base line\nnew line\n", "utf8");
  return workspaceRepo;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "project";
}

function createTaskSnapshot(overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    id: "task_report",
    workflowKey: "coding_session",
    deliveryMode: "review_required",
    autoPush: true,
    title: "Publish report",
    prompt: "Summarize the work and publish the report.",
    repo: "/tmp/report-repo",
    baseBranch: "main",
    branchMode: "new_branch",
    branchName: "feature/report_publish",
    projectId: "project_reports",
    projectName: "Reports",
    executionMode: "new_thread",
    status: "awaiting_human_input",
    runnerId: "runner-test",
    sessionAlias: "session_report",
    summary: "Implementation turn finished.",
    reportURL: undefined,
    lastPublishedAt: undefined,
    latestResultSummary: "Report updated and ready to review.",
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:05:00.000Z",
    approvals: [],
    artifacts: [
      {
        id: "artifact_tests",
        taskId: "task_report",
        kind: "tests",
        title: "Validation summary",
        summary: "npm test",
        createdAt: "2026-04-01T00:04:00.000Z"
      }
    ],
    events: [],
    executorSession: {
      sessionAlias: "session_report",
      executorType: "codex_cli",
      runnerId: "runner-test",
      threadId: "thread-report",
      cwd: "/tmp/worktrees/task_report",
      materializedFromHistory: false,
      lastTurnAt: "2026-04-01T00:05:00.000Z"
    },
    ...overrides
  };
}

async function seedReportEvents(recorder: TaskHistoryRecorder, taskId: string): Promise<void> {
  await recorder.recordRunnerLog(taskId, {
    kind: "plan_ready",
    title: "Plan ready",
    detail: "1. Inspect\n2. Implement\n3. Verify"
  });
  await recorder.recordRunnerLog(taskId, {
    kind: "turn_complete",
    title: "Implementation update",
    detail: "Implemented the requested report flow."
  });
  await recorder.recordRunnerLog(taskId, {
    kind: "git_completed",
    title: "Git action completed",
    detail: "Pushed branch codex/task_report to origin."
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function expectedReportRelativePath(
  snapshot: TaskSnapshot,
  _reportNamespace = "project_reports",
  executionBranch = "codex/task_report"
): string {
  return `${slugify(path.basename(snapshot.repo))}_${slugify(executionBranch)}_${slugify(snapshot.id)}_${formatBeijingFileTimestamp(snapshot.createdAt)}.md`;
}

test("report publisher writes a local markdown report even without a reports repository", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "raw-report-publisher-local-"));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const workspaceRepo = await setupWorkspaceRepo(tempRoot);
  const recorder = new TaskHistoryRecorder(path.join(tempRoot, "tasks"), path.join(tempRoot, "codex-home"));
  const snapshot = createTaskSnapshot({
    repo: workspaceRepo,
    executorSession: {
      sessionAlias: "session_report",
      executorType: "codex_cli",
      runnerId: "runner-test",
      threadId: "thread-report",
      cwd: workspaceRepo,
      materializedFromHistory: false,
      lastTurnAt: "2026-04-01T00:05:00.000Z"
    }
  });
  await seedReportEvents(recorder, snapshot.id);
  await recorder.recordExecutionMapping(snapshot.id, {
    workspacePath: workspaceRepo,
    executionBranch: "codex/task_report"
  });

  const publisher = new ReportPublisher(recorder, {
    repoURL: "",
    branch: "main",
    repoDir: path.join(tempRoot, "reports-repo"),
    publicBaseURL: "",
    rootDir: "plans"
  });

  const published = await publisher.publish(snapshot);
  const reportPath = path.join(tempRoot, "tasks", snapshot.id, "report.md");
  const markdown = await fs.readFile(reportPath, "utf8");

  assert.equal(published.reportURL, undefined);
  assert.equal(published.reportRelativePath, expectedReportRelativePath(snapshot));
  assert.equal(published.latestResultSummary, "Report updated and ready to review.");
  assert.match(markdown, new RegExp(`- Report Path: ${expectedReportRelativePath(snapshot)}`));
  assert.match(markdown, /- Task Updated At: 2026-04-01 08:05:00 北京时间/);
  assert.match(markdown, /## Latest Approved Plan/);
  assert.match(markdown, /## Code Diff/);
  assert.match(markdown, /### Diff Stat/);
  assert.match(markdown, /### Unified Diff/);
  assert.match(markdown, /\+\s*new line/);
  assert.match(markdown, /## Implementation Updates/);
  assert.match(markdown, /## Validation Results/);
  assert.match(markdown, /## Git Actions/);
});

test("report publisher keeps report files at the repository root even when a custom namespace is configured", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "raw-report-publisher-namespace-"));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const workspaceRepo = await setupWorkspaceRepo(tempRoot);
  const recorder = new TaskHistoryRecorder(path.join(tempRoot, "tasks"), path.join(tempRoot, "codex-home"));
  const snapshot = createTaskSnapshot({
    repo: workspaceRepo,
    executorSession: {
      sessionAlias: "session_report",
      executorType: "codex_cli",
      runnerId: "runner-test",
      threadId: "thread-report",
      cwd: workspaceRepo,
      materializedFromHistory: false,
      lastTurnAt: "2026-04-01T00:05:00.000Z"
    }
  });
  await seedReportEvents(recorder, snapshot.id);
  await recorder.recordExecutionMapping(snapshot.id, {
    workspacePath: workspaceRepo,
    executionBranch: "codex/task_report"
  });

  const publisher = new ReportPublisher(recorder, {
    repoURL: "",
    branch: "main",
    repoDir: path.join(tempRoot, "reports-repo"),
    publicBaseURL: "",
    rootDir: "plans",
    resolveReportNamespace: () => "../foo/iOS Demo"
  });

  const published = await publisher.publish(snapshot);

  assert.equal(published.reportRelativePath, expectedReportRelativePath(snapshot));
  assert.doesNotMatch(published.reportRelativePath, /\//);
  assert.doesNotMatch(published.reportRelativePath, /\.\./);
});

test("report publisher includes a dirty workspace snapshot when requested", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "raw-report-publisher-dirty-"));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const workspaceRepo = await setupWorkspaceRepo(tempRoot);
  await fs.writeFile(path.join(workspaceRepo, "notes.txt"), "local note\n", "utf8");
  const recorder = new TaskHistoryRecorder(path.join(tempRoot, "tasks"), path.join(tempRoot, "codex-home"));
  const snapshot = createTaskSnapshot({
    repo: workspaceRepo,
    status: "awaiting_human_input",
    summary: "Repository has uncommitted local changes on codex/task_report. Choose how to proceed before Codex edits this repo.",
    executionBranch: "codex/task_report",
    executorSession: {
      sessionAlias: "session_report",
      executorType: "codex_cli",
      runnerId: "runner-test",
      threadId: "thread-report",
      cwd: workspaceRepo,
      materializedFromHistory: false,
      lastTurnAt: "2026-04-01T00:05:00.000Z"
    }
  });
  await seedReportEvents(recorder, snapshot.id);
  await recorder.recordExecutionMapping(snapshot.id, {
    workspacePath: workspaceRepo,
    executionBranch: "codex/task_report"
  });

  const publisher = new ReportPublisher(recorder, {
    repoURL: "",
    branch: "main",
    repoDir: path.join(tempRoot, "reports-repo"),
    publicBaseURL: "",
    rootDir: "plans"
  });

  const dirtyWorkspaceSnapshot = await publisher.captureDirtyWorkspaceSnapshot(workspaceRepo);
  await publisher.publish(snapshot, {
    dirtyWorkspaceSnapshot
  });

  const reportPath = path.join(tempRoot, "tasks", snapshot.id, "report.md");
  const markdown = await fs.readFile(reportPath, "utf8");

  assert.match(markdown, /## Dirty Workspace Snapshot/);
  assert.match(markdown, /### Git Status/);
  assert.match(markdown, /### Untracked Files/);
  assert.match(markdown, /notes\.txt/);
});

test("report publisher commits and pushes one stable markdown file per task to the configured repository", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "raw-report-publisher-remote-"));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const workspaceRepo = await setupWorkspaceRepo(tempRoot);
  const remoteRepo = path.join(tempRoot, "reports-remote.git");
  const workingRepo = path.join(tempRoot, "reports-working");
  const verifyRepo = path.join(tempRoot, "reports-verify");
  await execGit(["init", "--bare", remoteRepo]);
  await execGit(["clone", remoteRepo, workingRepo]);
  await execGit(["-C", workingRepo, "config", "user.name", "RemoteAgentWorkbench Tests"]);
  await execGit(["-C", workingRepo, "config", "user.email", "tests@example.com"]);

  const recorder = new TaskHistoryRecorder(path.join(tempRoot, "tasks"), path.join(tempRoot, "codex-home"));
  const snapshot = createTaskSnapshot({
    repo: workspaceRepo,
    executorSession: {
      sessionAlias: "session_report",
      executorType: "codex_cli",
      runnerId: "runner-test",
      threadId: "thread-report",
      cwd: workspaceRepo,
      materializedFromHistory: false,
      lastTurnAt: "2026-04-01T00:05:00.000Z"
    }
  });
  await seedReportEvents(recorder, snapshot.id);
  await recorder.recordExecutionMapping(snapshot.id, {
    workspacePath: workspaceRepo,
    executionBranch: "codex/task_report"
  });

  const publisher = new ReportPublisher(recorder, {
    repoURL: remoteRepo,
    branch: "main",
    repoDir: workingRepo,
    publicBaseURL: "https://reports.example.com",
    rootDir: "plans",
    resolveReportNamespace: async () => "ios/ospark"
  });

  const published = await publisher.publish(snapshot);
  assert.equal(
    published.reportURL,
    `https://reports.example.com/blob/main/${expectedReportRelativePath(snapshot, "ios/ospark")}`
  );
  assert.equal(published.reportRelativePath, expectedReportRelativePath(snapshot, "ios/ospark"));

  const secondPublished = await publisher.publish({
    ...snapshot,
    updatedAt: "2026-05-03T08:00:00.000Z",
    latestResultSummary: "Report updated again after more work."
  });
  assert.equal(
    secondPublished.reportURL,
    `https://reports.example.com/blob/main/${expectedReportRelativePath(snapshot, "ios/ospark")}`
  );
  assert.equal(secondPublished.reportRelativePath, expectedReportRelativePath(snapshot, "ios/ospark"));

  await execGit(["clone", "--branch", "main", remoteRepo, verifyRepo]);
  const reportPath = path.join(verifyRepo, expectedReportRelativePath(snapshot, "ios/ospark"));
  const committedReport = await fs.readFile(reportPath, "utf8");
  const { stdout: gitLog } = await execFileAsync("git", ["-C", workingRepo, "log", "--oneline", "-1"]);

  assert.match(committedReport, /# Publish report/);
  assert.match(committedReport, /## Code Diff/);
  assert.match(committedReport, /feature\.txt/);
  assert.match(committedReport, /## Git Actions/);
  assert.match(gitLog.toString(), /docs\(report\): update task_report/);
});

test("report publisher refreshes the report timestamp on every publish to the reports repository", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "raw-report-publisher-republish-"));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const workspaceRepo = await setupWorkspaceRepo(tempRoot);
  const remoteRepo = path.join(tempRoot, "reports-remote.git");
  const workingRepo = path.join(tempRoot, "reports-working");
  await execGit(["init", "--bare", remoteRepo]);
  await execGit(["clone", remoteRepo, workingRepo]);
  await execGit(["-C", workingRepo, "config", "user.name", "RemoteAgentWorkbench Tests"]);
  await execGit(["-C", workingRepo, "config", "user.email", "tests@example.com"]);

  const recorder = new TaskHistoryRecorder(path.join(tempRoot, "tasks"), path.join(tempRoot, "codex-home"));
  const snapshot = createTaskSnapshot({
    repo: workspaceRepo,
    executorSession: {
      sessionAlias: "session_report",
      executorType: "codex_cli",
      runnerId: "runner-test",
      threadId: "thread-report",
      cwd: workspaceRepo,
      materializedFromHistory: false,
      lastTurnAt: "2026-04-01T00:05:00.000Z"
    }
  });
  await seedReportEvents(recorder, snapshot.id);
  await recorder.recordExecutionMapping(snapshot.id, {
    workspacePath: workspaceRepo,
    executionBranch: "codex/task_report"
  });

  const publisher = new ReportPublisher(recorder, {
    repoURL: remoteRepo,
    branch: "main",
    repoDir: workingRepo,
    publicBaseURL: "https://reports.example.com",
    rootDir: "plans",
    resolveReportNamespace: async () => "ios/ospark"
  });

  const firstPublished = await publisher.publish(snapshot);
  await sleep(1100);
  const secondPublished = await publisher.publish(snapshot);

  assert.notEqual(firstPublished.publishedAt, undefined);
  assert.notEqual(secondPublished.publishedAt, undefined);
  assert.notEqual(firstPublished.publishedAt, secondPublished.publishedAt);

  const { stdout: commitCount } = await execFileAsync("git", ["-C", workingRepo, "rev-list", "--count", "HEAD"]);
  assert.equal(commitCount.toString().trim(), "2");

  const reportPath = path.join(workingRepo, expectedReportRelativePath(snapshot, "ios/ospark"));
  const markdown = await fs.readFile(reportPath, "utf8");
  const reportUpdatedAt = markdown.match(/^- Report Updated At: (.+)$/m)?.[1];
  const taskUpdatedAt = markdown.match(/^- Task Updated At: (.+)$/m)?.[1];

  assert.equal(taskUpdatedAt, formatBeijingDateTime(snapshot.updatedAt));
  assert.equal(reportUpdatedAt, formatBeijingDateTime(secondPublished.publishedAt ?? ""));
});

test("report publisher returns a local result when reports repository fetch fails", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "raw-report-publisher-fetch-failure-"));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const workspaceRepo = await setupWorkspaceRepo(tempRoot);
  const missingRemote = path.join(tempRoot, "missing-remote.git");
  const workingRepo = path.join(tempRoot, "reports-working");
  await execGit(["init", "-b", "main", workingRepo]);
  await execGit(["-C", workingRepo, "config", "user.name", "RemoteAgentWorkbench Tests"]);
  await execGit(["-C", workingRepo, "config", "user.email", "tests@example.com"]);
  await execGit(["-C", workingRepo, "remote", "add", "origin", missingRemote]);

  const recorder = new TaskHistoryRecorder(path.join(tempRoot, "tasks"), path.join(tempRoot, "codex-home"));
  const snapshot = createTaskSnapshot({
    repo: workspaceRepo,
    executorSession: {
      sessionAlias: "session_report",
      executorType: "codex_cli",
      runnerId: "runner-test",
      threadId: "thread-report",
      cwd: workspaceRepo,
      materializedFromHistory: false,
      lastTurnAt: "2026-04-01T00:05:00.000Z"
    }
  });
  await seedReportEvents(recorder, snapshot.id);
  await recorder.recordExecutionMapping(snapshot.id, {
    workspacePath: workspaceRepo,
    executionBranch: "codex/task_report"
  });

  const publisher = new ReportPublisher(recorder, {
    repoURL: missingRemote,
    branch: "main",
    repoDir: workingRepo,
    publicBaseURL: "https://reports.example.com",
    rootDir: "plans"
  });

  const published = await publisher.publish(snapshot);
  const reportPath = path.join(tempRoot, "tasks", snapshot.id, "report.md");

  assert.equal(published.reportRelativePath, expectedReportRelativePath(snapshot));
  assert.equal(published.reportURL, undefined);
  assert.equal(published.latestResultSummary, "Report updated and ready to review.");
  assert.match(published.remoteSyncError ?? "", /could not read from remote repository|does not appear to be a git repository/i);
  assert.equal(await fs.readFile(reportPath, "utf8").then((value) => value.length > 0), true);
});

test("report publisher returns a local result when pushes hang on a hook", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "raw-report-publisher-push-timeout-"));
  const originalPushTimeout = config.gitPushTimeoutMs;

  t.after(async () => {
    config.gitPushTimeoutMs = originalPushTimeout;
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const workspaceRepo = await setupWorkspaceRepo(tempRoot);
  const remoteRepo = path.join(tempRoot, "reports-remote.git");
  const workingRepo = path.join(tempRoot, "reports-working");
  await execGit(["init", "--bare", remoteRepo]);
  await execGit(["clone", remoteRepo, workingRepo]);
  await execGit(["-C", workingRepo, "config", "user.name", "RemoteAgentWorkbench Tests"]);
  await execGit(["-C", workingRepo, "config", "user.email", "tests@example.com"]);
  await installPrePushHook(workingRepo, "sleep 1\nexit 0");

  const recorder = new TaskHistoryRecorder(path.join(tempRoot, "tasks"), path.join(tempRoot, "codex-home"));
  const snapshot = createTaskSnapshot({
    repo: workspaceRepo,
    executorSession: {
      sessionAlias: "session_report",
      executorType: "codex_cli",
      runnerId: "runner-test",
      threadId: "thread-report",
      cwd: workspaceRepo,
      materializedFromHistory: false,
      lastTurnAt: "2026-04-01T00:05:00.000Z"
    }
  });
  await seedReportEvents(recorder, snapshot.id);
  await recorder.recordExecutionMapping(snapshot.id, {
    workspacePath: workspaceRepo,
    executionBranch: "codex/task_report"
  });

  config.gitPushTimeoutMs = 100;

  const publisher = new ReportPublisher(recorder, {
    repoURL: remoteRepo,
    branch: "main",
    repoDir: workingRepo,
    publicBaseURL: "https://reports.example.com",
    rootDir: "plans"
  });

  const published = await publisher.publish(snapshot);

  assert.equal(published.reportRelativePath, expectedReportRelativePath(snapshot));
  assert.equal(published.reportURL, undefined);
  assert.match(published.remoteSyncError ?? "", /timed out while pushing the reports repository/i);
});
