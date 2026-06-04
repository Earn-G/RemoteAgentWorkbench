import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { RunnerAssignment, TaskSnapshot } from "./models.js";
import { TaskHistoryRecorder } from "./taskHistory.js";

function createTaskSnapshot(overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    id: "task_history",
    workflowKey: "coding_session",
    deliveryMode: "review_required",
    autoPush: true,
    title: "History task",
    prompt: "Implement the requested history change.",
    repo: "/tmp/history-repo",
    baseBranch: "main",
    branchMode: "new_branch",
    branchName: "feature/history_output",
    projectId: "project_history",
    projectName: "History Project",
    executionMode: "new_thread",
    status: "awaiting_human_input",
    runnerId: "runner-test",
    sessionAlias: "session_history",
    summary: "Implementation turn finished.",
    reportURL: "https://reports.example.com/blob/main/history-repo_codex-task_history_task_history_2026-04-01_08-00-00.md",
    lastPublishedAt: "2026-04-01T00:05:00.000Z",
    latestResultSummary: "History output updated.",
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:05:00.000Z",
    approvals: [],
    artifacts: [],
    events: [],
    executorSession: {
      sessionAlias: "session_history",
      executorType: "codex_cli",
      runnerId: "runner-test",
      threadId: "thread-history",
      cwd: "/tmp/worktrees/task_history",
      materializedFromHistory: false,
      lastTurnAt: "2026-04-01T00:05:00.000Z"
    },
    ...overrides
  };
}

test("task history recorder writes local snapshots, events, artifacts, reports, and session links", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "raw-task-history-"));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const tasksRoot = path.join(tempRoot, "tasks");
  const codexHome = path.join(tempRoot, "codex-home");
  const sessionFile = path.join(codexHome, "sessions", "2026", "04", "thread-history-session.jsonl");
  await fs.mkdir(path.dirname(sessionFile), { recursive: true });
  await fs.writeFile(sessionFile, "{\"thread\":\"thread-history\"}\n", "utf8");

  const recorder = new TaskHistoryRecorder(tasksRoot, codexHome);
  const initialSnapshot = createTaskSnapshot({
    reportURL: undefined,
    lastPublishedAt: undefined,
    latestResultSummary: undefined
  });

  await recorder.syncSnapshot(initialSnapshot);

  const assignment: RunnerAssignment = {
    id: "cmd_history",
    taskId: initialSnapshot.id,
    runnerId: "runner-test",
    claimToken: "claim_history",
    kind: "continue_prompt",
    prompt: "Please continue the implementation.",
    task: initialSnapshot
  };
  await recorder.recordAssignmentClaimed(assignment);

  const codexOutputPath = await recorder.recordCodexTurnOutput(initialSnapshot.id, "implementation-turn", [
    "{\"kind\":\"stdout\",\"text\":\"line one\"}"
  ]);
  await recorder.recordExecutionMapping(initialSnapshot.id, {
    workspacePath: "/tmp/history-repo",
    executionBranch: "codex/task_history"
  });
  await recorder.recordReportMapping(initialSnapshot.id, {
    reportNamespace: "ios/history",
    reportRelativePath: "history-repo_codex-task_history_task_history_2026-04-01_08-00-00.md"
  });

  const completedSnapshot = createTaskSnapshot();
  await recorder.recordCompletion(
    completedSnapshot.id,
    {
      outcome: "turn_complete",
      summary: "Updated the history output.",
      testsSummary: "npm test",
      reportURL: completedSnapshot.reportURL,
      lastPublishedAt: completedSnapshot.lastPublishedAt,
      latestResultSummary: completedSnapshot.latestResultSummary
    },
    completedSnapshot,
    codexOutputPath
  );

  const reportPath = await recorder.writeReport(completedSnapshot.id, "# History Report\n");
  const taskRecord = await recorder.loadTask(completedSnapshot.id);
  const events = await recorder.loadEvents(completedSnapshot.id);
  const artifactFiles = await fs.readdir(path.join(tasksRoot, completedSnapshot.id, "artifacts"));
  const sessionContents = await fs.readFile(path.join(tasksRoot, completedSnapshot.id, "session.json"), "utf8");

  assert.ok(taskRecord);
  assert.equal(taskRecord.threadId, "thread-history");
  assert.equal(taskRecord.codexSessionFilePath, sessionFile);
  assert.equal(taskRecord.executionBranch, "codex/task_history");
  assert.equal(taskRecord.reportNamespace, "ios/history");
  assert.equal(taskRecord.reportRelativePath, "history-repo_codex-task_history_task_history_2026-04-01_08-00-00.md");
  assert.equal(taskRecord.reportURL, "https://reports.example.com/blob/main/history-repo_codex-task_history_task_history_2026-04-01_08-00-00.md");
  assert.equal(taskRecord.latestResultSummary, "History output updated.");

  assert.equal(events.length, 2);
  assert.equal(events[0]?.kind, "assignment_claimed");
  assert.equal(events[1]?.kind, "turn_complete");
  assert.equal(events[1]?.codexOutputPath, codexOutputPath);

  assert.ok(artifactFiles.some((name) => name.includes("diff-summary")));
  assert.ok(artifactFiles.some((name) => name.includes("validation-summary")));
  assert.match(sessionContents, /thread-history-session\.jsonl/);
  assert.equal(await fs.readFile(reportPath, "utf8"), "# History Report\n");
});

test("task history recorder patches the live executor session before turn completion", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "raw-task-progress-"));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const tasksRoot = path.join(tempRoot, "tasks");
  const codexHome = path.join(tempRoot, "codex-home");
  const planningSessionFile = path.join(codexHome, "sessions", "2026", "04", "thread-history-session.jsonl");
  const implementationSessionFile = path.join(codexHome, "sessions", "2026", "04", "thread-live-session.jsonl");
  await fs.mkdir(path.dirname(planningSessionFile), { recursive: true });
  await fs.writeFile(planningSessionFile, "{\"thread\":\"thread-history\"}\n", "utf8");
  await fs.writeFile(implementationSessionFile, "{\"thread\":\"thread-live\"}\n", "utf8");

  const recorder = new TaskHistoryRecorder(tasksRoot, codexHome);
  await recorder.syncSnapshot(createTaskSnapshot());

  await recorder.recordRunnerLog("task_history", {
    kind: "codex.session_attached",
    title: "Codex session attached",
    detail: "Streaming the writable implementation session locally.",
    status: "running",
    summary: "Mac is streaming the live Codex session locally.",
    session: {
      executorType: "codex_cli",
      threadId: "thread-live",
      cwd: "/tmp/worktrees/task_history",
      materializedFromHistory: false,
      lastTurnAt: "2026-04-01T00:06:00.000Z"
    }
  });

  const taskRecord = await recorder.loadTask("task_history");
  const sessionContents = await fs.readFile(path.join(tasksRoot, "task_history", "session.json"), "utf8");
  const events = await recorder.loadEvents("task_history");

  assert.ok(taskRecord);
  assert.equal(taskRecord.status, "running");
  assert.equal(taskRecord.summary, "Mac is streaming the live Codex session locally.");
  assert.equal(taskRecord.threadId, "thread-live");
  assert.equal(taskRecord.codexSessionFilePath, implementationSessionFile);
  assert.match(sessionContents, /thread-live/);
  assert.match(sessionContents, /thread-live-session\.jsonl/);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, "codex.session_attached");
});

test("task history recorder keeps repeated artifacts with the same title instead of overwriting them", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "raw-task-history-artifacts-"));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const recorder = new TaskHistoryRecorder(path.join(tempRoot, "tasks"), path.join(tempRoot, "codex-home"));
  await recorder.syncSnapshot(createTaskSnapshot());

  const firstPath = await recorder.saveArtifact("task_history", "diff", "Diff summary", "first artifact\n");
  const secondPath = await recorder.saveArtifact("task_history", "diff", "Diff summary", "second artifact\n");
  const artifactFiles = await fs.readdir(path.join(tempRoot, "tasks", "task_history", "artifacts"));

  assert.notEqual(firstPath, secondPath);
  assert.equal(artifactFiles.length, 2);
  assert.equal(await fs.readFile(firstPath, "utf8"), "first artifact\n");
  assert.equal(await fs.readFile(secondPath, "utf8"), "second artifact\n");
});

test("task history recorder prunes expired local terminal tasks", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "raw-task-history-retention-"));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const tasksRoot = path.join(tempRoot, "tasks");
  const recorder = new TaskHistoryRecorder(tasksRoot, path.join(tempRoot, "codex-home"));

  await recorder.syncSnapshot(createTaskSnapshot({
    id: "task_recent",
    status: "completed",
    updatedAt: new Date().toISOString()
  }));

  await recorder.syncSnapshot(createTaskSnapshot({
    id: "task_expired",
    status: "completed",
    updatedAt: "2025-01-01T00:00:00.000Z"
  }));

  await recorder.syncSnapshot(createTaskSnapshot({
    id: "task_running",
    status: "running",
    updatedAt: "2025-01-01T00:00:00.000Z"
  }));

  const removed = await recorder.cleanupExpiredTasks(30);

  assert.deepEqual(removed, ["task_expired"]);
  await assert.doesNotReject(fs.access(path.join(tasksRoot, "task_recent", "task.json")));
  await assert.rejects(fs.access(path.join(tasksRoot, "task_expired", "task.json")));
  await assert.doesNotReject(fs.access(path.join(tasksRoot, "task_running", "task.json")));
});
