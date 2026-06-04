import assert from "node:assert/strict";
import test from "node:test";
import type { RunnerCompletionPayload, TaskSnapshot } from "./models.js";
import { deriveSnapshotAfterCompletion } from "./taskSnapshot.js";

function createTaskSnapshot(overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    id: "task_snapshot",
    workflowKey: "coding_session",
    deliveryMode: "review_required",
    autoPush: true,
    title: "Snapshot task",
    prompt: "Implement the requested change.",
    repo: "/tmp/demo-repo",
    baseBranch: "main",
    branchMode: "new_branch",
    branchName: "feature/snapshot_task",
    executionMode: "new_thread",
    status: "preparing_workspace",
    runnerId: "runner-test",
    sessionAlias: "session_snapshot",
    summary: "Runner is preparing the repository.",
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    approvals: [],
    artifacts: [],
    events: [],
    ...overrides
  };
}

function createPlanCompletion(): RunnerCompletionPayload {
  return {
    outcome: "plan_ready",
    planSummary: "1. Inspect\n2. Implement\n3. Verify",
    session: {
      executorType: "codex_cli",
      threadId: "thread-plan",
      cwd: "/tmp/demo-repo",
      materializedFromHistory: false,
      lastTurnAt: "2026-04-01T00:05:00.000Z"
    }
  };
}

test("plan-ready snapshots keep review-required tasks waiting for approval", () => {
  const snapshot = deriveSnapshotAfterCompletion(
    createTaskSnapshot(),
    "runner-test",
    createPlanCompletion()
  );

  assert.equal(snapshot.status, "awaiting_plan_approval");
  assert.equal(snapshot.summary, "Codex generated an initial plan and is waiting for approval.");
});

test("plan-ready snapshots keep direct-commit tasks queued for automatic execution", () => {
  const snapshot = deriveSnapshotAfterCompletion(
    createTaskSnapshot({
      deliveryMode: "direct_commit"
    }),
    "runner-test",
    createPlanCompletion()
  );

  assert.equal(snapshot.status, "queued");
  assert.equal(snapshot.summary, "Plan captured. Waiting for the Mac runner to start implementation automatically.");
  assert.equal(snapshot.executorSession?.threadId, "thread-plan");
});

test("direct-commit turns become completed after a local commit is created", () => {
  const snapshot = deriveSnapshotAfterCompletion(
    createTaskSnapshot({
      deliveryMode: "direct_commit"
    }),
    "runner-test",
    {
      outcome: "turn_complete",
      summary: "Implemented the requested change and committed it locally.",
      implementationCommitCreated: true
    }
  );

  assert.equal(snapshot.status, "completed");
  assert.equal(snapshot.summary, "Implementation turn finished with a local commit. This direct-commit task is now completed.");
  assert.equal(snapshot.latestResultSummary, "Implemented the requested change and committed it locally.");
});

test("review-required turns become completed when implementation finishes", () => {
  const snapshot = deriveSnapshotAfterCompletion(
    createTaskSnapshot(),
    "runner-test",
    {
      outcome: "turn_complete",
      summary: "Implemented the requested change and ran checks."
    }
  );

  assert.equal(snapshot.status, "completed");
  assert.equal(
    snapshot.summary,
    "Implementation turn finished. This task is now completed, and push or review delivery remains optional."
  );
  assert.equal(snapshot.latestResultSummary, "Implemented the requested change and ran checks.");
});

test("direct-commit turns without a local commit keep waiting for input", () => {
  const snapshot = deriveSnapshotAfterCompletion(
    createTaskSnapshot({
      deliveryMode: "direct_commit"
    }),
    "runner-test",
    {
      outcome: "turn_complete",
      summary: "Implemented the change but stopped before committing."
    }
  );

  assert.equal(snapshot.status, "awaiting_human_input");
  assert.equal(snapshot.summary, "Implementation turn finished without a local commit, so the task is waiting for your next instruction.");
});

test("direct-commit turns in plain folders complete without a local commit", () => {
  const snapshot = deriveSnapshotAfterCompletion(
    createTaskSnapshot({
      deliveryMode: "direct_commit"
    }),
    "runner-test",
    {
      outcome: "turn_complete",
      summary: "Created the requested files in a plain folder.",
      workspaceIsGitRepository: false
    }
  );

  assert.equal(snapshot.status, "completed");
  assert.equal(snapshot.summary, "Implementation turn finished in a plain local folder. This direct-submit task is now completed without Git.");
});

test("manual commit completion marks direct-commit tasks as completed", () => {
  const snapshot = deriveSnapshotAfterCompletion(
    createTaskSnapshot({
      deliveryMode: "direct_commit"
    }),
    "runner-test",
    {
      outcome: "git_completed",
      action: "commit",
      summary: "Commit created on feature/snapshot_task."
    }
  );

  assert.equal(snapshot.status, "completed");
  assert.equal(snapshot.summary, "Local commit created. This direct-commit task is now completed.");
  assert.equal(snapshot.latestResultSummary, "Commit created on feature/snapshot_task.");
});
