import assert from "node:assert/strict";
import test from "node:test";
import type { TaskSnapshot } from "./models.js";
import { buildImplementationPrompt, prepareImplementationTurn } from "./taskPrompting.js";

function createTaskSnapshot(overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    id: "task_test",
    workflowKey: "coding_session",
    deliveryMode: "review_required",
    autoPush: true,
    title: "Test task",
    prompt: "Make the home screen show offline agents correctly.",
    repo: "/tmp/demo-repo",
    baseBranch: "main",
    branchMode: "new_branch",
    branchName: "bugfix/home_screen_offline_agents",
    executionMode: "new_thread",
    status: "awaiting_plan_approval",
    runnerId: "runner-test",
    sessionAlias: "session_test",
    summary: "Waiting for plan approval.",
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    approvals: [],
    artifacts: [
      {
        id: "artifact_plan",
        taskId: "task_test",
        kind: "plan",
        title: "Execution plan",
        summary: "1. Normalize the status.\n2. Update the UI.\n3. Run checks.",
        createdAt: "2026-04-01T00:00:00.000Z"
      }
    ],
    events: [
      {
        id: "event_plan",
        taskId: "task_test",
        createdAt: "2026-04-01T00:00:00.000Z",
        kind: "plan.generated",
        title: "Plan ready",
        detail: "Execution plan generated."
      }
    ],
    executorSession: {
      sessionAlias: "session_test",
      executorType: "codex_cli",
      runnerId: "runner-test",
      threadId: "thread-plan",
      cwd: "/tmp/worktree",
      materializedFromHistory: false,
      lastTurnAt: "2026-04-01T00:00:00.000Z"
    },
    ...overrides
  };
}

test("new-thread tasks start implementation in a fresh writable thread after plan approval", () => {
  const task = createTaskSnapshot();

  const turn = prepareImplementationTurn(task, "Implement the approved plan.");

  assert.equal(turn.threadId, undefined);
  assert.equal(turn.startsFreshThread, true);
  assert.match(turn.prompt, /Original user request:/);
  assert.match(turn.prompt, /Approved implementation plan:/);
  assert.match(turn.prompt, /Current instruction:/);
});

test("new-thread tasks resume the implementation thread after a completed implementation turn", () => {
  const task = createTaskSnapshot({
    status: "awaiting_human_input",
    artifacts: [
      {
        id: "artifact_diff",
        taskId: "task_test",
        kind: "diff",
        title: "Diff summary",
        summary: "Updated the home screen status styling.",
        createdAt: "2026-04-01T00:10:00.000Z"
      },
      {
        id: "artifact_plan",
        taskId: "task_test",
        kind: "plan",
        title: "Execution plan",
        summary: "1. Normalize the status.\n2. Update the UI.\n3. Run checks.",
        createdAt: "2026-04-01T00:00:00.000Z"
      }
    ],
    events: [
      {
        id: "event_turn",
        taskId: "task_test",
        createdAt: "2026-04-01T00:10:00.000Z",
        kind: "codex.turn_complete",
        title: "Implementation update",
        detail: "Completed an implementation turn."
      }
    ],
    executorSession: {
      sessionAlias: "session_test",
      executorType: "codex_cli",
      runnerId: "runner-test",
      threadId: "thread-implement",
      cwd: "/tmp/worktree",
      materializedFromHistory: false,
      lastTurnAt: "2026-04-01T00:10:00.000Z"
    }
  });

  const turn = prepareImplementationTurn(task, "Please continue the implementation.");

  assert.equal(turn.threadId, "thread-implement");
  assert.equal(turn.startsFreshThread, false);
});

test("resume-thread tasks keep using the existing Codex thread", () => {
  const task = createTaskSnapshot({
    executionMode: "resume_thread",
    resumeThreadId: "thread-history",
    executorSession: undefined
  });

  const turn = prepareImplementationTurn(task, "Implement the approved plan.");

  assert.equal(turn.threadId, "thread-history");
  assert.equal(turn.startsFreshThread, false);
});

test("resume-thread tasks start a fresh thread when no existing thread id is available", () => {
  const task = createTaskSnapshot({
    executionMode: "resume_thread",
    resumeThreadId: undefined,
    executorSession: undefined
  });

  const turn = prepareImplementationTurn(task, "Implement the approved plan.");

  assert.equal(turn.threadId, undefined);
  assert.equal(turn.startsFreshThread, true);
});

test("resume-thread tasks reuse the thread created during planning when one is available", () => {
  const task = createTaskSnapshot({
    executionMode: "resume_thread",
    resumeThreadId: undefined,
    executorSession: {
      sessionAlias: "session_test",
      executorType: "codex_cli",
      runnerId: "runner-test",
      threadId: "thread-created-during-plan",
      cwd: "/tmp/worktree",
      materializedFromHistory: true,
      lastTurnAt: "2026-04-01T00:00:00.000Z"
    }
  });

  const turn = prepareImplementationTurn(task, "Implement the approved plan.");

  assert.equal(turn.threadId, "thread-created-during-plan");
  assert.equal(turn.startsFreshThread, false);
});

test("implementation prompt avoids duplicating the original request when no separate instruction is provided", () => {
  const task = createTaskSnapshot();

  const prompt = buildImplementationPrompt(task, task.prompt);

  assert.equal(prompt.match(/Original user request:/g)?.length, 1);
  assert.equal(prompt.match(/Current instruction:/g)?.length ?? 0, 0);
});

test("review-required tasks keep commits blocked in the implementation prompt", () => {
  const prompt = buildImplementationPrompt(createTaskSnapshot(), "Implement the approved plan.");

  assert.match(prompt, /Do not commit, rebase, or push unless the user explicitly requests/);
  assert.doesNotMatch(prompt, /direct_commit/);
});

test("direct-commit tasks allow local commits but still block push and review creation", () => {
  const prompt = buildImplementationPrompt(
    createTaskSnapshot({
      deliveryMode: "direct_commit"
    }),
    "Implement the approved plan."
  );

  assert.match(prompt, /This task uses `direct_commit`/);
  assert.match(prompt, /successful local commit marks the task completed/i);
  assert.match(prompt, /git add -A/);
  assert.match(prompt, /runner may auto-push after the implementation turn/);
});

test("direct-commit tasks with auto-push disabled keep push fully manual", () => {
  const prompt = buildImplementationPrompt(
    createTaskSnapshot({
      deliveryMode: "direct_commit",
      autoPush: false
    }),
    "Implement the approved plan."
  );

  assert.match(prompt, /Do not push, rebase, or create a PR\/MR unless the user explicitly requests/);
  assert.doesNotMatch(prompt, /runner may auto-push/);
});

test("plain local folder prompts never require Git", () => {
  const prompt = buildImplementationPrompt(
    createTaskSnapshot({
      deliveryMode: "direct_commit"
    }),
    "Implement the approved plan.",
    { isGitRepository: false }
  );

  assert.match(prompt, /Git is not initialized here/);
  assert.match(prompt, /Do not run Git commands/);
  assert.doesNotMatch(prompt, /git add -A/);
  assert.doesNotMatch(prompt, /local commit marks the task completed/);
});
