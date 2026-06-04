import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { config } from "./config.js";
import { TaskService } from "./services/taskService.js";

function createServiceWithRunner(capabilities: string[] = ["codex_cli", "git_guard"]): TaskService {
  const service = new TaskService({
    storagePath: ":memory:"
  });
  service.upsertRunner({
    id: "runner-test",
    name: "Test Runner",
    platform: "macOS",
    labels: ["local"],
    capabilities
  });
  return service;
}

function createTask(
  service: TaskService,
  overrides: Partial<{
    title: string;
    prompt: string;
    repo: string;
    baseBranch: string;
    branchMode: "current_branch" | "new_branch";
    branchName: string;
    deliveryMode: "review_required" | "direct_commit";
    autoPush: boolean;
    executionMode: "new_thread" | "resume_thread";
    resumeThreadId: string;
  }> = {}
) {
  return service.createTask({
    workflowKey: "coding_session",
    deliveryMode: overrides.deliveryMode ?? "review_required",
    autoPush: overrides.autoPush ?? true,
    title: overrides.title ?? "Test task",
    prompt: overrides.prompt ?? "Implement the requested change",
    repo: overrides.repo ?? "/tmp/demo-repo",
    baseBranch: overrides.baseBranch ?? "main",
    branchMode: overrides.branchMode,
    branchName: overrides.branchName,
    executionMode: overrides.executionMode ?? "new_thread",
    resumeThreadId: overrides.resumeThreadId
  });
}

test("creating a second unfinished task for the same repository is rejected", () => {
  const service = createServiceWithRunner();
  const firstTask = createTask(service, {
    repo: "/tmp/shared-repo"
  });

  assert.ok(firstTask.id);
  assert.throws(
    () =>
      createTask(service, {
        title: "Second task",
        repo: "/tmp/shared-repo/"
      }),
    /already has an unfinished task/
  );
});

test("creating a second unfinished task for the same repository is allowed when explicitly requested", () => {
  const service = createServiceWithRunner();
  const firstTask = createTask(service, {
    repo: "/tmp/shared-repo"
  });

  const secondTask = service.createTask({
    workflowKey: "coding_session",
    deliveryMode: "review_required",
    autoPush: true,
    title: "Parallel task",
    prompt: "Work on another change in parallel",
    repo: "/tmp/shared-repo/",
    baseBranch: "main",
    executionMode: "new_thread",
    allowParallel: true
  });

  assert.ok(firstTask.id);
  assert.ok(secondTask.id);
  assert.notEqual(secondTask.id, firstTask.id);
});

test("same-repository tasks can be created again after the earlier task fails", () => {
  const service = createServiceWithRunner();
  const firstTask = createTask(service, {
    repo: "/tmp/shared-repo"
  });

  const planAssignment = service.claimNextCommand("runner-test");
  assert.ok(planAssignment);

  service.completeRunnerCommand("runner-test", firstTask.id, {
    outcome: "failed",
    summary: "Runner failed while preparing the workspace.",
    detail: "workspace lock timed out"
  });

  const secondTask = createTask(service, {
    title: "Retry task",
    repo: "/tmp/shared-repo"
  });

  assert.ok(secondTask.id);
  assert.notEqual(secondTask.id, firstTask.id);
});

test("terminal task records can be deleted from server history", () => {
  const service = createServiceWithRunner();
  const task = createTask(service);

  const planAssignment = service.claimNextCommand("runner-test");
  assert.ok(planAssignment);

  service.completeRunnerCommand("runner-test", task.id, {
    outcome: "failed",
    summary: "Runner failed while preparing the workspace.",
    detail: "workspace lock timed out"
  });

  service.deleteTaskRecord(task.id);

  assert.equal(service.getTask(task.id), undefined);
  assert.equal(service.listTasks().some((candidate) => candidate.id === task.id), false);
});

test("unfinished task records cannot be deleted", () => {
  const service = createServiceWithRunner();
  const task = createTask(service);

  assert.throws(
    () => service.deleteTaskRecord(task.id),
    /must be completed, failed, or canceled/
  );
});

test("directory presets sync and create-directory utilities can be claimed and completed", () => {
  const service = createServiceWithRunner();

  const presets = service.syncRunnerDirectoryPresets("runner-test", [
    {
      id: "preset_projects",
      label: "Projects",
      rootPath: "/Users/test/Projects"
    }
  ]);

  assert.equal(presets.length, 1);
  assert.equal(presets[0]?.id, "runner-test:preset_projects");

  const receipt = service.requestDirectoryCreation({
    presetId: "runner-test:preset_projects",
    relativePath: "feature/app-shell",
    defaultPrompt: "   "
  });
  assert.equal(receipt.presetId, "runner-test:preset_projects");
  assert.equal(receipt.absolutePath, "/Users/test/Projects/feature/app-shell");
  assert.equal(receipt.createProject, true);
  assert.equal(receipt.projectName, "app-shell");

  const assignment = service.claimNextUtilityCommand("runner-test");
  assert.ok(assignment);
  assert.equal(assignment.kind, "create_directory");
  assert.equal(assignment.absolutePath, "/Users/test/Projects/feature/app-shell");
  assert.equal(assignment.createProject, true);
  assert.equal(assignment.projectName, "app-shell");
  assert.equal(assignment.projectDeliveryMode, "direct_commit");
  assert.equal(assignment.projectDefaultTaskTitle, "Work on app-shell");
  assert.equal(
    assignment.projectDefaultPrompt,
    "Describe the outcome you want in app-shell. Mention files to create or change and checks to run."
  );

  const secondClaim = service.claimNextUtilityCommand("runner-test");
  assert.equal(secondClaim, undefined);

  service.completeUtilityCommand("runner-test", assignment.id, {
    outcome: "completed",
    absolutePath: assignment.absolutePath,
    message: "created"
  });

  const afterCompletion = service.claimNextUtilityCommand("runner-test");
  assert.equal(afterCompletion, undefined);
});

test("codex config commands can queue behind unrelated utility commands", () => {
  const service = createServiceWithRunner();

  service.heartbeatRunner("runner-test", {
    currentTaskId: undefined,
    version: "0.1.0",
    hostname: "runner-test-host",
    codexConfigProfiles: ["1000", "plus"],
    activeCodexConfigProfile: "plus"
  });

  service.syncRunnerDirectoryPresets("runner-test", [
    {
      id: "preset_projects",
      label: "Projects",
      rootPath: "/Users/test/Projects"
    }
  ]);

  service.requestDirectoryCreation({
    presetId: "runner-test:preset_projects",
    relativePath: "feature/app-shell"
  });
  const receipt = service.switchCodexConfig("1000");
  assert.equal(receipt.profileName, "1000");

  const firstAssignment = service.claimNextUtilityCommand("runner-test");
  assert.ok(firstAssignment);
  assert.equal(firstAssignment.kind, "create_directory");

  service.completeUtilityCommand("runner-test", firstAssignment.id, {
    outcome: "completed",
    absolutePath: firstAssignment.absolutePath,
    message: "created"
  });

  const secondAssignment = service.claimNextUtilityCommand("runner-test");
  assert.ok(secondAssignment);
  assert.equal(secondAssignment.kind, "switch_codex_profile");
  assert.equal(secondAssignment.profileName, "1000");
});

test("codex config summary reloads persisted state across service instances", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "task-service-codex-summary-"));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const storagePath = path.join(tempRoot, "state.sqlite");
  const summaryService = new TaskService({
    storagePath
  });
  const writerService = new TaskService({
    storagePath
  });

  writerService.upsertRunner({
    id: "runner-test",
    name: "Test Runner",
    platform: "macOS",
    labels: ["local"],
    capabilities: ["codex_cli"],
    codexConfigProfiles: ["1000", "plus"],
    activeCodexConfigProfile: "plus"
  });

  const receipt = writerService.switchCodexConfig("1000");
  assert.equal(receipt.profileName, "1000");

  const assignment = writerService.claimNextUtilityCommand("runner-test");
  assert.ok(assignment);

  writerService.completeUtilityCommand("runner-test", assignment.id, {
    claimToken: assignment.claimToken,
    outcome: "completed",
    absolutePath: assignment.absolutePath,
    message: "switched",
    codexConfigProfiles: ["1000", "plus"],
    activeCodexConfigProfile: "1000"
  });

  const summary = summaryService.getCodexConfigState();
  assert.deepEqual(summary.profiles, ["1000", "plus"]);
  assert.equal(summary.activeProfileName, "1000");
  assert.equal(summary.pendingAction, undefined);
  assert.equal(summary.pendingProfileName, undefined);
});

test("deleteCodexConfig rejects deleting protected and active profiles", () => {
  const service = createServiceWithRunner(["codex_cli"]);
  service.upsertRunner({
    id: "runner-test",
    name: "Test Runner",
    platform: "macOS",
    labels: ["local"],
    capabilities: ["codex_cli"],
    codexConfigProfiles: ["1000", "plus", "demo"],
    activeCodexConfigProfile: "demo"
  });

  assert.throws(() => service.deleteCodexConfig("1000"), /cannot be deleted/);
  assert.throws(() => service.deleteCodexConfig("demo"), /currently active/);
});

test("create-codex-profile utilities do not persist secrets to sqlite", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "task-service-codex-config-"));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const storagePath = path.join(tempRoot, "state.sqlite");
  const service = new TaskService({
    storagePath
  });
  service.upsertRunner({
    id: "runner-test",
    name: "Test Runner",
    platform: "macOS",
    labels: ["local"],
    capabilities: ["codex_cli"],
    codexConfigProfiles: ["1000", "plus"]
  });

  service.createCodexConfig("demo", "https://demo.example/v1", "demo-token");

  const db = new DatabaseSync(storagePath);
  t.after(() => {
    db.close();
  });

  const row = db.prepare(
    `SELECT profileName, baseURL, apiKey FROM utility_commands WHERE kind = 'create_codex_profile'`
  ).get() as { profileName: string; baseURL: string | null; apiKey: string | null } | undefined;

  assert.ok(row);
  assert.equal(row.profileName, "demo");
  assert.equal(row.baseURL, null);
  assert.equal(row.apiKey, null);
});

test("directory presets with the same local id stay isolated per runner", () => {
  const service = createServiceWithRunner();
  service.upsertRunner({
    id: "runner-second",
    name: "Second Runner",
    platform: "macOS",
    labels: ["remote"],
    capabilities: ["codex_cli"]
  });

  service.syncRunnerDirectoryPresets("runner-test", [
    {
      id: "preset_projects",
      label: "Projects",
      rootPath: "/Users/one/Projects"
    }
  ]);
  service.syncRunnerDirectoryPresets("runner-second", [
    {
      id: "preset_projects",
      label: "Projects",
      rootPath: "/Users/two/Projects"
    }
  ]);

  const presets = service.listDirectoryPresets();
  assert.deepEqual(
    presets.map((preset) => ({ id: preset.id, runnerId: preset.runnerId, rootPath: preset.rootPath })),
    [
      {
        id: "runner-second:preset_projects",
        runnerId: "runner-second",
        rootPath: "/Users/two/Projects"
      },
      {
        id: "runner-test:preset_projects",
        runnerId: "runner-test",
        rootPath: "/Users/one/Projects"
      }
    ]
  );

  const firstReceipt = service.requestDirectoryCreation({
    presetId: "runner-test:preset_projects",
    relativePath: "feature/one"
  });
  const secondReceipt = service.requestDirectoryCreation({
    presetId: "runner-second:preset_projects",
    relativePath: "feature/two"
  });

  assert.equal(firstReceipt.runnerId, "runner-test");
  assert.equal(firstReceipt.absolutePath, "/Users/one/Projects/feature/one");
  assert.equal(secondReceipt.runnerId, "runner-second");
  assert.equal(secondReceipt.absolutePath, "/Users/two/Projects/feature/two");
});

test("runner-driven lifecycle creates a plan approval and then an implementation turn", () => {
  const service = createServiceWithRunner();
  const task = createTask(service);

  const planAssignment = service.claimNextCommand("runner-test");
  assert.ok(planAssignment);
  assert.equal(planAssignment.kind, "generate_plan");
  assert.equal(planAssignment.taskId, task.id);

  service.completeRunnerCommand("runner-test", task.id, {
    outcome: "plan_ready",
    planSummary: "1. Inspect the repo\n2. Make the change\n3. Run checks",
    session: {
      executorType: "codex_cli",
      threadId: "thread-123",
      cwd: "/tmp/worktrees/task-1",
      materializedFromHistory: false,
      lastTurnAt: "2026-03-31T09:00:00.000Z"
    }
  });

  const afterPlan = service.getTask(task.id);
  assert.ok(afterPlan);
  assert.equal(afterPlan.status, "awaiting_plan_approval");
  assert.equal(afterPlan.executorSession?.threadId, "thread-123");
  assert.equal(afterPlan.artifacts[0]?.kind, "plan");
  assert.equal(afterPlan.reportURL, undefined);

  const planApproval = service.listApprovals().find((candidate) => candidate.taskId === task.id && candidate.type === "plan.execute");
  assert.ok(planApproval);

  service.resolveApproval(planApproval.id, "approve");

  const turnAssignment = service.claimNextCommand("runner-test");
  assert.ok(turnAssignment);
  assert.equal(turnAssignment.kind, "continue_prompt");

  service.completeRunnerCommand("runner-test", task.id, {
    outcome: "turn_complete",
    summary: "Implemented the change and ran the relevant checks.",
    testsSummary: "npm test"
  });

  const completedTurn = service.getTask(task.id);
  assert.ok(completedTurn);
  assert.equal(completedTurn.status, "completed");
  assert.equal(
    completedTurn.summary,
    "Implementation turn finished. This task is now completed, and push or review delivery remains optional."
  );
  assert.equal(completedTurn.artifacts.filter((artifact) => artifact.kind === "diff").length, 1);
  assert.equal(completedTurn.artifacts.filter((artifact) => artifact.kind === "tests").length, 1);
});

test("plan completion can persist the published report metadata before implementation starts", () => {
  const service = createServiceWithRunner();
  const task = createTask(service);

  const planAssignment = service.claimNextCommand("runner-test");
  assert.ok(planAssignment);

  service.completeRunnerCommand("runner-test", task.id, {
    outcome: "plan_ready",
    planSummary: "1. Inspect the repo\n2. Publish the plan\n3. Wait for approval",
    reportURL: "https://github.com/example-org/workbench-reports/blob/main/demo_main_task_plan_2026-04-06_08-05-24.md",
    lastPublishedAt: "2026-04-06T00:05:24.000Z",
    session: {
      executorType: "codex_cli",
      threadId: "thread-plan-report",
      cwd: "/tmp/worktrees/task-plan-report",
      materializedFromHistory: false,
      lastTurnAt: "2026-04-06T00:05:24.000Z"
    }
  });

  const snapshot = service.getTask(task.id);
  assert.ok(snapshot);
  assert.equal(
    snapshot.reportURL,
    "https://github.com/example-org/workbench-reports/blob/main/demo_main_task_plan_2026-04-06_08-05-24.md"
  );
  assert.equal(snapshot.lastPublishedAt, "2026-04-06T00:05:24.000Z");
  assert.equal(snapshot.status, "awaiting_plan_approval");
});

test("approvals are idempotent and do not enqueue the same implementation turn twice", () => {
  const service = createServiceWithRunner();
  const task = createTask(service);

  const planAssignment = service.claimNextCommand("runner-test");
  assert.ok(planAssignment);

  service.completeRunnerCommand("runner-test", task.id, {
    outcome: "plan_ready",
    planSummary: "A plan",
    session: {
      executorType: "codex_cli",
      threadId: "thread-456",
      cwd: "/tmp/worktrees/task-2",
      materializedFromHistory: false,
      lastTurnAt: "2026-03-31T09:30:00.000Z"
    }
  });

  const approval = service.listApprovals().find((candidate) => candidate.taskId === task.id && candidate.type === "plan.execute");
  assert.ok(approval);

  service.resolveApproval(approval.id, "approve");
  service.resolveApproval(approval.id, "approve");

  const first = service.claimNextCommand("runner-test");
  const second = service.claimNextCommand("runner-test");
  assert.ok(first);
  assert.equal(first.kind, "continue_prompt");
  assert.equal(second, undefined);
});

test("runner is released after a terminal git action completes", () => {
  const service = createServiceWithRunner();
  const task = createTask(service);

  const planAssignment = service.claimNextCommand("runner-test");
  assert.ok(planAssignment);

  service.completeRunnerCommand("runner-test", task.id, {
    outcome: "plan_ready",
    planSummary: "A plan",
    session: {
      executorType: "codex_cli",
      threadId: "thread-789",
      cwd: "/tmp/worktrees/task-3",
      materializedFromHistory: false,
      lastTurnAt: "2026-03-31T10:00:00.000Z"
    }
  });

  const planApproval = service.listApprovals().find((candidate) => candidate.taskId === task.id && candidate.type === "plan.execute");
  assert.ok(planApproval);
  service.resolveApproval(planApproval.id, "approve");

  const turnAssignment = service.claimNextCommand("runner-test");
  assert.ok(turnAssignment);
  service.completeRunnerCommand("runner-test", task.id, {
    outcome: "turn_complete",
    summary: "Implementation complete."
  });

  service.requestGitAction(task.id, "push");
  const pushApproval = service.listApprovals().find((candidate) => candidate.taskId === task.id && candidate.type === "git.push");
  assert.ok(pushApproval);
  service.resolveApproval(pushApproval.id, "approve");

  const gitAssignment = service.claimNextCommand("runner-test");
  assert.ok(gitAssignment);
  assert.equal(gitAssignment.kind, "git.push");

  service.completeRunnerCommand("runner-test", task.id, {
    outcome: "git_completed",
    action: "push",
    summary: "Pushed branch codex/task_123 to origin."
  });

  const runner = service.listRunners().find((candidate) => candidate.id === "runner-test");
  const snapshot = service.getTask(task.id);
  assert.ok(runner);
  assert.ok(snapshot);
  assert.equal(snapshot.status, "completed");
  assert.equal(runner.currentTaskId, undefined);
});

test("blocked destructive git commands create an approval and resume Codex with an explicit allowance after approval", () => {
  const service = createServiceWithRunner();
  const task = createTask(service);

  const planAssignment = service.claimNextCommand("runner-test");
  assert.ok(planAssignment);

  service.completeRunnerCommand("runner-test", task.id, {
    outcome: "plan_ready",
    planSummary: "1. Update files\n2. Validate changes",
    session: {
      executorType: "codex_cli",
      threadId: "thread-plan",
      cwd: "/tmp/worktrees/task-guard",
      materializedFromHistory: false,
      lastTurnAt: "2026-03-31T10:00:00.000Z"
    }
  });

  const planApproval = service.listApprovals().find((candidate) => candidate.taskId === task.id && candidate.type === "plan.execute");
  assert.ok(planApproval);
  service.resolveApproval(planApproval.id, "approve");

  const implementationAssignment = service.claimNextCommand("runner-test");
  assert.ok(implementationAssignment);
  assert.equal(implementationAssignment.kind, "continue_prompt");

  service.completeRunnerCommand("runner-test", task.id, {
    outcome: "protected_git_command_blocked",
    summary: "Codex requested git reset --hard HEAD. Waiting for approval before the runner can continue.",
    protectedGitCommand: {
      kind: "reset_hard",
      args: ["reset", "--hard", "HEAD"]
    },
    session: {
      executorType: "codex_cli",
      threadId: "thread-implement",
      cwd: "/tmp/worktrees/task-guard",
      materializedFromHistory: false,
      lastTurnAt: "2026-03-31T10:05:00.000Z"
    }
  });

  const blockedSnapshot = service.getTask(task.id);
  assert.ok(blockedSnapshot);
  assert.equal(blockedSnapshot.status, "awaiting_git_approval");
  assert.equal(blockedSnapshot.executorSession?.threadId, "thread-implement");

  const protectedApproval = service.listApprovals().find((candidate) => (
    candidate.taskId === task.id && candidate.type === "protected_git.reset_hard"
  ));
  assert.ok(protectedApproval);

  service.resolveApproval(protectedApproval.id, "approve");

  const resumedAssignment = service.claimNextCommand("runner-test");
  assert.ok(resumedAssignment);
  assert.equal(resumedAssignment.kind, "continue_prompt");
  assert.match(resumedAssignment.prompt ?? "", /previously blocked destructive Git command/);
  assert.deepEqual(resumedAssignment.protectedGitCommand, {
    kind: "reset_hard",
    args: ["reset", "--hard", "HEAD"]
  });
  assert.deepEqual(resumedAssignment.allowedProtectedGitCommandKinds, ["reset_hard"]);
});

test("stale claimed commands are recovered when the runner loses task ownership", () => {
  const service = createServiceWithRunner();
  const task = createTask(service);

  const claimed = service.claimNextCommand("runner-test");
  assert.ok(claimed);
  assert.equal(claimed.kind, "generate_plan");

  service.heartbeatRunner("runner-test", {
    currentTaskId: undefined,
    version: "0.1.0",
    hostname: "runner-test-host"
  });

  const recovered = service.claimNextCommand("runner-test");
  assert.ok(recovered);
  assert.equal(recovered.kind, "generate_plan");
  assert.equal(recovered.taskId, task.id);

  const snapshot = service.getTask(task.id);
  assert.ok(snapshot);
  assert.equal(snapshot.status, "preparing_workspace");
  assert.ok(snapshot.events.some((event) => event.kind === "runner.recovered"));
});

test("claimed commands are recovered when an online runner exceeds the claim timeout", async () => {
  const service = createServiceWithRunner();
  const previousTimeout = config.runner.claimTimeoutMs;
  const task = createTask(service);

  try {
    (config.runner as { claimTimeoutMs: number }).claimTimeoutMs = 1;

    const claimed = service.claimNextCommand("runner-test");
    assert.ok(claimed);

    await delay(5);
    service.heartbeatRunner("runner-test", {
      currentTaskId: task.id,
      currentCommandId: claimed.id,
      currentCommandKind: claimed.kind,
      currentCommandStartedAt: new Date(Date.now() - 5000).toISOString(),
      version: "0.1.0",
      hostname: "runner-test-host"
    });

    const recovered = service.claimNextCommand("runner-test");
    assert.ok(recovered);
    assert.equal(recovered.id, claimed.id);
    assert.notEqual(recovered.claimToken, claimed.claimToken);

    const snapshot = service.getTask(task.id);
    assert.ok(snapshot);
    assert.equal(snapshot.status, "preparing_workspace");
    assert.ok(snapshot.events.some((event) => /longer than the configured timeout/.test(event.detail)));
  } finally {
    (config.runner as { claimTimeoutMs: number }).claimTimeoutMs = previousTimeout;
  }
});

test("recovered commands reject stale claim tokens and allow idempotent completion for the active claim", () => {
  const service = createServiceWithRunner();
  const task = createTask(service);

  const firstClaim = service.claimNextCommand("runner-test");
  assert.ok(firstClaim);

  service.heartbeatRunner("runner-test", {
    currentTaskId: undefined,
    version: "0.1.0",
    hostname: "runner-test-host"
  });

  const recoveredClaim = service.claimNextCommand("runner-test");
  assert.ok(recoveredClaim);
  assert.equal(recoveredClaim.id, firstClaim.id);
  assert.notEqual(recoveredClaim.claimToken, firstClaim.claimToken);

  assert.throws(
    () =>
      service.completeRunnerCommand("runner-test", task.id, {
        commandId: firstClaim.id,
        claimToken: firstClaim.claimToken,
        outcome: "plan_ready",
        planSummary: "1. Inspect\n2. Change\n3. Validate",
        session: {
          executorType: "codex_cli",
          threadId: "thread-stale",
          cwd: "/tmp/worktrees/task-stale",
          materializedFromHistory: false,
          lastTurnAt: "2026-04-06T00:00:00.000Z"
        }
      }),
    /claim token mismatch/
  );

  const snapshot = service.completeRunnerCommand("runner-test", task.id, {
    commandId: recoveredClaim.id,
    claimToken: recoveredClaim.claimToken,
    outcome: "plan_ready",
    planSummary: "1. Inspect\n2. Change\n3. Validate",
    session: {
      executorType: "codex_cli",
      threadId: "thread-active",
      cwd: "/tmp/worktrees/task-active",
      materializedFromHistory: false,
      lastTurnAt: "2026-04-06T00:01:00.000Z"
    }
  });
  assert.equal(snapshot.status, "awaiting_plan_approval");

  const duplicate = service.completeRunnerCommand("runner-test", task.id, {
    commandId: recoveredClaim.id,
    claimToken: recoveredClaim.claimToken,
    outcome: "plan_ready",
    planSummary: "1. Inspect\n2. Change\n3. Validate",
    session: {
      executorType: "codex_cli",
      threadId: "thread-active",
      cwd: "/tmp/worktrees/task-active",
      materializedFromHistory: false,
      lastTurnAt: "2026-04-06T00:01:00.000Z"
    }
  });
  assert.equal(duplicate.status, "awaiting_plan_approval");
});

test("failed and completed tasks can still queue follow-ups and git approvals", () => {
  const service = createServiceWithRunner();
  const task = createTask(service);

  const planAssignment = service.claimNextCommand("runner-test");
  assert.ok(planAssignment);

  service.completeRunnerCommand("runner-test", task.id, {
    outcome: "plan_ready",
    planSummary: "A plan",
    session: {
      executorType: "codex_cli",
      threadId: "thread-recover",
      cwd: "/tmp/demo-repo",
      materializedFromHistory: false,
      lastTurnAt: "2026-04-02T00:00:00.000Z"
    }
  });

  const planApproval = service.listApprovals().find((candidate) => candidate.taskId === task.id && candidate.type === "plan.execute");
  assert.ok(planApproval);
  service.resolveApproval(planApproval.id, "approve");

  const implementationAssignment = service.claimNextCommand("runner-test");
  assert.ok(implementationAssignment);
  service.completeRunnerCommand("runner-test", task.id, {
    outcome: "failed",
    summary: "Runner failed while editing files.",
    detail: "git checkout failed"
  });

  const followUpAfterFailure = service.addUserMessage(task.id, "Please retry the change and fix the failure.");
  assert.equal(followUpAfterFailure.status, "queued");

  const failedFollowUpAssignment = service.claimNextCommand("runner-test");
  assert.ok(failedFollowUpAssignment);
  assert.equal(failedFollowUpAssignment.kind, "continue_prompt");
  assert.equal(failedFollowUpAssignment.prompt, "Please retry the change and fix the failure.");

  service.completeRunnerCommand("runner-test", task.id, {
    outcome: "turn_complete",
    summary: "Recovered through a manual follow-up."
  });

  const recovered = service.continueTask(task.id);
  assert.equal(recovered.status, "queued");

  const retryAssignment = service.claimNextCommand("runner-test");
  assert.ok(retryAssignment);
  assert.equal(retryAssignment.kind, "continue_prompt");

  service.completeRunnerCommand("runner-test", task.id, {
    outcome: "turn_complete",
    summary: "Recovered after the failure."
  });

  service.requestGitAction(task.id, "push");
  const pushApproval = service.listApprovals().find((candidate) => candidate.taskId === task.id && candidate.type === "git.push");
  assert.ok(pushApproval);
  service.resolveApproval(pushApproval.id, "approve");

  const gitAssignment = service.claimNextCommand("runner-test");
  assert.ok(gitAssignment);
  service.completeRunnerCommand("runner-test", task.id, {
    outcome: "git_completed",
    action: "push",
    summary: "Pushed the task branch."
  });

  const followUpAfterCompletion = service.addUserMessage(task.id, "One more tweak after push.");
  assert.equal(followUpAfterCompletion.status, "queued");

  const completionFollowUpAssignment = service.claimNextCommand("runner-test");
  assert.ok(completionFollowUpAssignment);
  assert.equal(completionFollowUpAssignment.kind, "continue_prompt");
  assert.equal(completionFollowUpAssignment.prompt, "One more tweak after push.");

  service.completeRunnerCommand("runner-test", task.id, {
    outcome: "turn_complete",
    summary: "Applied the post-push tweak."
  });

  const continuedAfterCompletion = service.continueTask(task.id);
  assert.equal(continuedAfterCompletion.status, "queued");
});

test("manual complete marks awaiting-input tasks as completed without queueing runner work", () => {
  const service = createServiceWithRunner();
  const task = createTask(service, {
    deliveryMode: "direct_commit"
  });

  const planAssignment = service.claimNextCommand("runner-test");
  assert.ok(planAssignment);
  service.completeRunnerCommand("runner-test", task.id, {
    outcome: "plan_ready",
    planSummary: "1. Update the repo\n2. Run checks\n3. Stop before committing",
    session: {
      executorType: "codex_cli",
      threadId: "thread-manual-complete",
      cwd: "/tmp/direct-complete-manual",
      materializedFromHistory: false,
      lastTurnAt: "2026-04-10T00:00:00.000Z"
    }
  });

  const turnAssignment = service.claimNextCommand("runner-test");
  assert.ok(turnAssignment);
  service.completeRunnerCommand("runner-test", task.id, {
    outcome: "turn_complete",
    summary: "Implemented the change but stopped before committing."
  });

  const completed = service.completeTask(task.id);
  assert.equal(completed.status, "completed");
  assert.equal(
    completed.summary,
    "Task marked completed from iPhone without creating a local commit. Repository state was not changed."
  );
  assert.equal(completed.events.some((event) => event.kind === "task.completed_manual"), true);
});

test("manual complete rejects tasks that are not waiting for input", () => {
  const service = createServiceWithRunner();
  const task = createTask(service);

  assert.throws(
    () => service.completeTask(task.id),
    /can only be manually completed while waiting for input/
  );
});

test("terminal tasks auto-clear orphaned commands before queueing the next follow-up", () => {
  const service = createServiceWithRunner();
  const task = createTask(service);

  const planAssignment = service.claimNextCommand("runner-test");
  assert.ok(planAssignment);

  service.completeRunnerCommand("runner-test", task.id, {
    outcome: "plan_ready",
    planSummary: "A plan",
    session: {
      executorType: "codex_cli",
      threadId: "thread-orphan",
      cwd: "/tmp/demo-repo",
      materializedFromHistory: false,
      lastTurnAt: "2026-04-02T00:00:00.000Z"
    }
  });

  const planApproval = service.listApprovals().find((candidate) => candidate.taskId === task.id && candidate.type === "plan.execute");
  assert.ok(planApproval);
  service.resolveApproval(planApproval.id, "approve");

  const implementationAssignment = service.claimNextCommand("runner-test");
  assert.ok(implementationAssignment);
  service.completeRunnerCommand("runner-test", task.id, {
    outcome: "failed",
    summary: "Runner failed while editing files.",
    detail: "dirty repository"
  });

  const internals = service as unknown as {
    commands: Map<string, { id: string; taskId: string; runnerId: string; kind: string; createdAt: string }>;
    store: { upsertCommand: (command: { id: string; taskId: string; runnerId: string; kind: string; createdAt: string }) => void };
  };

  const ghostCommand = {
    id: "cmd_ghost",
    taskId: task.id,
    runnerId: "runner-test",
    kind: "continue_prompt",
    createdAt: "2026-04-02T00:10:00.000Z"
  };
  internals.commands.set(ghostCommand.id, ghostCommand);
  internals.store.upsertCommand(ghostCommand);

  const resumed = service.addUserMessage(task.id, "Retry after the dirty repo failure.");
  assert.equal(resumed.status, "queued");

  const assignment = service.claimNextCommand("runner-test");
  assert.ok(assignment);
  assert.equal(assignment.prompt, "Retry after the dirty repo failure.");
});

test("continue auto-rebinds older tasks that are missing a stored runner assignment", () => {
  const service = createServiceWithRunner();
  const task = createTask(service);

  const planAssignment = service.claimNextCommand("runner-test");
  assert.ok(planAssignment);
  service.completeRunnerCommand("runner-test", task.id, {
    outcome: "plan_ready",
    planSummary: "A plan",
    session: {
      executorType: "codex_cli",
      threadId: "thread-rebind",
      cwd: "/tmp/demo-repo",
      materializedFromHistory: false,
      lastTurnAt: "2026-04-03T00:00:00.000Z"
    }
  });

  const planApproval = service.listApprovals().find((candidate) => candidate.taskId === task.id && candidate.type === "plan.execute");
  assert.ok(planApproval);
  service.resolveApproval(planApproval.id, "approve");

  const implementationAssignment = service.claimNextCommand("runner-test");
  assert.ok(implementationAssignment);
  service.completeRunnerCommand("runner-test", task.id, {
    outcome: "turn_complete",
    summary: "Implementation complete."
  });

  const internals = service as unknown as {
    tasks: Map<string, { id: string; runnerId?: string }>;
    store: { upsertTask: (task: { id: string; runnerId?: string }) => void };
  };

  const storedTask = internals.tasks.get(task.id);
  assert.ok(storedTask);
  storedTask.runnerId = undefined;
  internals.store.upsertTask(storedTask);

  const continued = service.continueTask(task.id);
  assert.equal(continued.status, "queued");
  assert.equal(continued.runnerId, "runner-test");

  const followUpAssignment = service.claimNextCommand("runner-test");
  assert.ok(followUpAssignment);
  assert.equal(followUpAssignment.kind, "continue_prompt");
});

test("workspace recheck queues a dedicated inspection command and clears stale dirty state when clean", () => {
  const service = createServiceWithRunner();
  const task = createTask(service);

  const planAssignment = service.claimNextCommand("runner-test");
  assert.ok(planAssignment);
  service.completeRunnerCommand("runner-test", task.id, {
    outcome: "plan_ready",
    planSummary: "A plan",
    session: {
      executorType: "codex_cli",
      threadId: "thread-inspect",
      cwd: "/tmp/demo-repo",
      materializedFromHistory: false,
      lastTurnAt: "2026-04-03T00:10:00.000Z"
    }
  });

  const planApproval = service.listApprovals().find((candidate) => candidate.taskId === task.id && candidate.type === "plan.execute");
  assert.ok(planApproval);
  service.resolveApproval(planApproval.id, "approve");

  const implementationAssignment = service.claimNextCommand("runner-test");
  assert.ok(implementationAssignment);
  service.completeRunnerCommand("runner-test", task.id, {
    outcome: "turn_complete",
    summary: "Implementation complete."
  });

  const queued = service.inspectWorkspace(task.id);
  assert.equal(queued.status, "queued");

  const inspectionAssignment = service.claimNextCommand("runner-test");
  assert.ok(inspectionAssignment);
  assert.equal(inspectionAssignment.kind, "inspect_workspace");

  service.completeRunnerCommand("runner-test", task.id, {
    outcome: "workspace_inspected_clean",
    summary: "Workspace is clean. No dirty workspace action is required.",
    currentBranch: "feature/task_cleanup",
    statusSummary: "## feature/task_cleanup",
    reviewPlatform: "github"
  });

  const snapshot = service.getTask(task.id);
  assert.ok(snapshot);
  assert.equal(snapshot.status, "awaiting_human_input");
  assert.equal(snapshot.executionBranch, "feature/task_cleanup");
  assert.equal(snapshot.reviewPlatform, "github");
  assert.equal(snapshot.dirtyWorkspace, undefined);
});

test("workspace inspection completion does not append a duplicate clean timeline event", () => {
  const service = createServiceWithRunner();
  const task = createTask(service);

  const planAssignment = service.claimNextCommand("runner-test");
  assert.ok(planAssignment);
  service.completeRunnerCommand("runner-test", task.id, {
    outcome: "plan_ready",
    planSummary: "A plan",
    session: {
      executorType: "codex_cli",
      threadId: "thread-clean-dedupe",
      cwd: "/tmp/demo-repo",
      materializedFromHistory: false,
      lastTurnAt: "2026-04-03T00:10:00.000Z"
    }
  });

  const planApproval = service.listApprovals().find((candidate) => candidate.taskId === task.id && candidate.type === "plan.execute");
  assert.ok(planApproval);
  service.resolveApproval(planApproval.id, "approve");

  const implementationAssignment = service.claimNextCommand("runner-test");
  assert.ok(implementationAssignment);
  service.completeRunnerCommand("runner-test", task.id, {
    outcome: "turn_complete",
    summary: "Implementation complete."
  });

  service.inspectWorkspace(task.id);
  const inspectionAssignment = service.claimNextCommand("runner-test");
  assert.ok(inspectionAssignment);
  assert.equal(inspectionAssignment.kind, "inspect_workspace");

  service.logRunnerProgress("runner-test", task.id, {
    commandId: inspectionAssignment.id,
    claimToken: inspectionAssignment.claimToken,
    kind: "workspace.clean",
    title: "Workspace clean",
    detail: "No uncommitted local changes were found in /tmp/demo-repo on feature/task_cleanup.",
    executionBranch: "feature/task_cleanup",
    reviewPlatform: "github",
    summary: "Workspace is clean. No dirty workspace action is required."
  });

  service.completeRunnerCommand("runner-test", task.id, {
    commandId: inspectionAssignment.id,
    claimToken: inspectionAssignment.claimToken,
    outcome: "workspace_inspected_clean",
    summary: "Workspace is clean. No dirty workspace action is required.",
    currentBranch: "feature/task_cleanup",
    statusSummary: "## feature/task_cleanup",
    reviewPlatform: "github"
  });

  const snapshot = service.getTask(task.id);
  assert.ok(snapshot);
  assert.equal(snapshot.status, "awaiting_human_input");
  assert.equal(
    snapshot.events.filter((event) => event.kind === "workspace.clean").length,
    1
  );
});

test("dirty workspace detection stores the pending decision state and queues a dedicated resolution command", () => {
  const service = createServiceWithRunner();
  const task = createTask(service);

  const planAssignment = service.claimNextCommand("runner-test");
  assert.ok(planAssignment);

  service.completeRunnerCommand("runner-test", task.id, {
    outcome: "dirty_workspace_detected",
    summary: "Repository has uncommitted local changes on dev_3.0. Choose how to proceed before Codex edits this repo.",
    currentBranch: "dev_3.0",
    statusSummary: "## dev_3.0\n M README.md\n?? notes.txt",
    reportURL: "https://reports.example.com/blob/main/ospark_dev_3.0_task_dirty_2026-04-02_20-00-00.md",
    lastPublishedAt: "2026-04-02T12:00:00.000Z",
    latestResultSummary: "Dirty workspace snapshot published."
  });

  const blocked = service.getTask(task.id);
  assert.ok(blocked);
  assert.equal(blocked.status, "awaiting_human_input");
  assert.equal(blocked.executionBranch, "dev_3.0");
  assert.equal(blocked.dirtyWorkspace?.state, "pending_decision");
  assert.equal(blocked.dirtyWorkspace?.currentBranch, "dev_3.0");
  assert.equal(blocked.reportURL, "https://reports.example.com/blob/main/ospark_dev_3.0_task_dirty_2026-04-02_20-00-00.md");

  assert.throws(
    () => service.addUserMessage(task.id, "Continue anyway."),
    /dirty workspace decision/
  );

  const queued = service.resolveDirtyWorkspaceDecision(task.id, "continue_current_workspace");
  assert.equal(queued.status, "queued");
  assert.equal(queued.dirtyWorkspace?.lastDecision, "continue_current_workspace");

  const resolutionAssignment = service.claimNextCommand("runner-test");
  assert.ok(resolutionAssignment);
  assert.equal(resolutionAssignment.kind, "resolve_dirty_workspace");
  assert.equal(resolutionAssignment.dirtyWorkspaceDecision, "continue_current_workspace");
});

test("plan-only dirty workspace resolution keeps the task waiting for the next decision without creating a plan approval", () => {
  const service = createServiceWithRunner();
  const task = createTask(service);

  const planAssignment = service.claimNextCommand("runner-test");
  assert.ok(planAssignment);

  service.completeRunnerCommand("runner-test", task.id, {
    outcome: "dirty_workspace_detected",
    summary: "Repository has uncommitted local changes on dev_3.0. Choose how to proceed before Codex edits this repo.",
    currentBranch: "dev_3.0",
    statusSummary: "## dev_3.0\n M README.md"
  });

  service.resolveDirtyWorkspaceDecision(task.id, "plan_only");
  const resolutionAssignment = service.claimNextCommand("runner-test");
  assert.ok(resolutionAssignment);
  assert.equal(resolutionAssignment.kind, "resolve_dirty_workspace");
  assert.equal(resolutionAssignment.dirtyWorkspaceDecision, "plan_only");

  service.completeRunnerCommand("runner-test", task.id, {
    outcome: "plan_ready",
    planSummary: "1. Inspect dirty changes\n2. Propose a safe sequence\n3. Wait for confirmation",
    session: {
      executorType: "codex_cli",
      threadId: "thread-dirty-plan",
      cwd: "/tmp/demo-repo",
      materializedFromHistory: false,
      lastTurnAt: "2026-04-02T12:05:00.000Z"
    }
  });

  const snapshot = service.getTask(task.id);
  assert.ok(snapshot);
  assert.equal(snapshot.status, "awaiting_human_input");
  assert.equal(snapshot.dirtyWorkspace?.state, "pending_decision");
  assert.equal(snapshot.dirtyWorkspace?.lastDecision, "plan_only");
  assert.equal(snapshot.approvals.filter((approval) => approval.type === "plan.execute").length, 0);
  assert.equal(snapshot.artifacts[0]?.kind, "plan");
});

test("server storage keeps only the newest event and artifact summaries per task", () => {
  const service = createServiceWithRunner();
  const task = createTask(service);

  const publish = service as unknown as {
    publish: (taskId: string, kind: string, title: string, detail: string) => void;
    addArtifact: (taskId: string, kind: "plan" | "diff" | "tests" | "git" | "handoff", title: string, summary: string) => void;
  };

  for (let index = 0; index < 25; index += 1) {
    publish.publish(task.id, `event.${index}`, `Event ${index}`, `Detail ${index}`);
  }

  for (let index = 0; index < 5; index += 1) {
    publish.addArtifact(task.id, "diff", `Artifact ${index}`, `Summary ${index}`);
  }

  const snapshot = service.getTask(task.id);
  assert.ok(snapshot);
  assert.equal(snapshot.events.length, 20);
  assert.equal(snapshot.events[0]?.kind, "event.5");
  assert.equal(snapshot.events.at(-1)?.kind, "event.24");
  assert.equal(snapshot.artifacts.length, 3);
  assert.deepEqual(
    snapshot.artifacts.map((artifact) => artifact.title),
    ["Artifact 4", "Artifact 3", "Artifact 2"]
  );
});

test("task status view stays lightweight for phone clients", () => {
  const service = createServiceWithRunner();
  const task = createTask(service);

  const publish = service as unknown as {
    publish: (taskId: string, kind: string, title: string, detail: string) => void;
    addArtifact: (taskId: string, kind: "plan" | "diff" | "tests" | "git" | "handoff", title: string, summary: string) => void;
  };

  publish.publish(task.id, "event.1", "Queued", "Task queued");
  publish.publish(task.id, "event.2", "Running", "Task running");
  publish.addArtifact(task.id, "diff", "Patch", "Changed files");

  const snapshot = service.getTaskStatusView(task.id);
  assert.ok(snapshot);
  assert.equal(snapshot.events.length, 1);
  assert.equal(snapshot.events[0]?.kind, "event.2");
  assert.equal(snapshot.artifacts.length, 0);
});

test("project summaries surface report metadata and terminal tasks are cleaned up after retention", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "raw-server-task-service-"));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const storagePath = path.join(tempRoot, "control-plane.sqlite");
  const service = new TaskService({
    storagePath,
    retentionDays: 30
  });

  service.upsertRunner({
    id: "runner-test",
    name: "Test Runner",
    platform: "macOS",
    labels: ["local"],
    capabilities: ["codex_cli", "git_guard"]
  });

  service.syncRunnerProjects("runner-test", [
    {
      id: "project_history",
      name: "History Project",
      repo: "/tmp/history-project",
      baseBranch: "main",
      deliveryMode: "review_required",
      autoPush: true,
      defaultTaskTitle: "Continue history task",
      defaultPrompt: "Implement the requested change.",
      isFeatured: false
    }
  ]);

  const task = service.createTaskForProject("project_history", {
    title: "Generate GitHub report",
    prompt: "Update the reporting output.",
    executionMode: "new_thread"
  });

  const planAssignment = service.claimNextCommand("runner-test");
  assert.ok(planAssignment);
  service.completeRunnerCommand("runner-test", task.id, {
    outcome: "plan_ready",
    planSummary: "1. Inspect\n2. Update report\n3. Verify",
    session: {
      executorType: "codex_cli",
      threadId: "thread-report",
      cwd: "/tmp/worktrees/report-task",
      materializedFromHistory: false,
      lastTurnAt: "2026-04-01T00:00:00.000Z"
    }
  });

  const planApproval = service.listApprovals().find((candidate) => candidate.taskId === task.id && candidate.type === "plan.execute");
  assert.ok(planApproval);
  service.resolveApproval(planApproval.id, "approve");

  const implementationAssignment = service.claimNextCommand("runner-test");
  assert.ok(implementationAssignment);
  service.completeRunnerCommand("runner-test", task.id, {
    outcome: "turn_complete",
    summary: "Updated the report output.",
    testsSummary: "npm test",
    reportURL: "https://reports.example.com/blob/main/history_codex-task_history_task_history_2026-04-01_08-00-00.md",
    lastPublishedAt: "2026-04-01T00:05:00.000Z",
    latestResultSummary: "Report output updated."
  });

  const project = service.getProject("project_history");
  assert.ok(project);
  assert.equal(project.latestReportURL, "https://reports.example.com/blob/main/history_codex-task_history_task_history_2026-04-01_08-00-00.md");
  assert.equal(project.latestResultSummary, "Report output updated.");

  service.requestGitAction(task.id, "push");
  const pushApproval = service.listApprovals().find((candidate) => candidate.taskId === task.id && candidate.type === "git.push");
  assert.ok(pushApproval);
  service.resolveApproval(pushApproval.id, "approve");

  const gitAssignment = service.claimNextCommand("runner-test");
  assert.ok(gitAssignment);
  service.completeRunnerCommand("runner-test", task.id, {
    outcome: "git_completed",
    action: "push",
    summary: "Pushed branch codex/task_history to origin.",
    reportURL: "https://reports.example.com/blob/main/history_codex-task_history_task_history_2026-04-01_08-00-00.md",
    lastPublishedAt: "2026-04-01T00:06:00.000Z",
    latestResultSummary: "Report published and pushed."
  });

  const persistedService = service as unknown as {
    tasks: Map<string, { id: string; sessionAlias: string; status: string; updatedAt: string }>;
    store: { upsertTask: (task: { id: string; sessionAlias: string; status: string; updatedAt: string }) => void };
  };
  const storedTask = persistedService.tasks.get(task.id);
  assert.ok(storedTask);
  storedTask.updatedAt = "2026-01-01T00:00:00.000Z";
  persistedService.store.upsertTask(storedTask);

  const cleanupService = new TaskService({
    storagePath,
    retentionDays: 30
  });
  cleanupService.cleanupExpiredData();

  assert.equal(cleanupService.getTask(task.id), undefined);
  assert.equal(cleanupService.getProject("project_history")?.recentTasksCount, 0);
});

test("task creation generates readable branch names and normalizes custom ones", () => {
  const service = createServiceWithRunner();

  const generated = createTask(service, {
    repo: "/tmp/demo-repo-generated",
    title: "Fix detail number display",
    prompt: "Fix detail number display on the item card and keep the UI aligned."
  });
  assert.equal(generated.branchName, "bugfix/detail_number_display_item");

  const custom = createTask(service, {
    repo: "/tmp/demo-repo-custom",
    title: "Item UI polish",
    prompt: "Polish the item UI.",
    branchName: "Feature / Item UI"
  });
  assert.equal(custom.branchName, "feature/item_ui");
});

test("direct-commit tasks can target the repository's current branch without preallocating a new one", () => {
  const service = createServiceWithRunner();

  const task = createTask(service, {
    repo: "/tmp/demo-repo-current-branch",
    deliveryMode: "direct_commit",
    branchMode: "current_branch"
  });

  assert.equal(task.branchMode, "current_branch");
  assert.equal(task.branchName, undefined);
});

test("direct-commit tasks force the current branch even when branch mode is omitted", () => {
  const service = createServiceWithRunner();

  const task = createTask(service, {
    repo: "/tmp/demo-repo-current-branch-defaulted",
    deliveryMode: "direct_commit",
    branchName: "feature/should_be_ignored"
  });

  assert.equal(task.branchMode, "current_branch");
  assert.equal(task.branchName, undefined);
});

test("create PR approvals carry the requested PR title to the runner assignment", () => {
  const service = createServiceWithRunner(["codex_cli", "git_guard", "github_pr"]);
  const task = createTask(service, {
    repo: "git@github.com:acme/demo.git"
  });

  const planAssignment = service.claimNextCommand("runner-test");
  assert.ok(planAssignment);
  service.completeRunnerCommand("runner-test", task.id, {
    outcome: "plan_ready",
    planSummary: "A plan",
    session: {
      executorType: "codex_cli",
      threadId: "thread-pr",
      cwd: "/tmp/demo-repo",
      materializedFromHistory: false,
      lastTurnAt: "2026-04-02T10:00:00.000Z"
    }
  });

  const planApproval = service.listApprovals().find((candidate) => candidate.taskId === task.id && candidate.type === "plan.execute");
  assert.ok(planApproval);
  service.resolveApproval(planApproval.id, "approve");

  const implementationAssignment = service.claimNextCommand("runner-test");
  assert.ok(implementationAssignment);
  service.completeRunnerCommand("runner-test", task.id, {
    outcome: "turn_complete",
    summary: "Implementation complete."
  });

  service.requestGitAction(task.id, "create_pr", undefined, "UI: polish item detail", "release/1.2");
  const prApproval = service.listApprovals().find((candidate) => candidate.taskId === task.id && candidate.type === "git.create_pr");
  assert.ok(prApproval);
  assert.equal(prApproval.payload.title, "UI: polish item detail");
  assert.equal(prApproval.payload.targetBranch, "release/1.2");
  assert.match(prApproval.detail, /into release\/1.2/);

  service.resolveApproval(prApproval.id, "approve");
  const assignment = service.claimNextCommand("runner-test");
  assert.ok(assignment);
  assert.equal(assignment.kind, "git.create_pr");
  assert.equal(assignment.prTitle, "UI: polish item detail");
  assert.equal(assignment.targetBranch, "release/1.2");
});

test("create PR can commit current local changes before creating the review request", () => {
  const service = createServiceWithRunner(["codex_cli", "git_guard", "gitlab_mr"]);
  const task = createTask(service, {
    repo: "git@gitlab.com:acme/demo.git"
  });

  const planAssignment = service.claimNextCommand("runner-test");
  assert.ok(planAssignment);
  service.completeRunnerCommand("runner-test", task.id, {
    outcome: "plan_ready",
    planSummary: "A plan",
    session: {
      executorType: "codex_cli",
      threadId: "thread-pr-commit",
      cwd: "/tmp/demo-repo",
      materializedFromHistory: false,
      lastTurnAt: "2026-04-02T10:00:00.000Z"
    }
  });

  const planApproval = service.listApprovals().find((candidate) => candidate.taskId === task.id && candidate.type === "plan.execute");
  assert.ok(planApproval);
  service.resolveApproval(planApproval.id, "approve");

  const implementationAssignment = service.claimNextCommand("runner-test");
  assert.ok(implementationAssignment);
  service.completeRunnerCommand("runner-test", task.id, {
    outcome: "turn_complete",
    summary: "Implementation complete."
  });

  service.requestGitAction(task.id, "create_pr", "chore: prepare mr", "UI polish", "release/1.2", "commit_and_review");
  const prApproval = service.listApprovals().find((candidate) => candidate.taskId === task.id && candidate.type === "git.create_pr");
  assert.ok(prApproval);
  assert.equal(prApproval.payload.reviewMode, "commit_and_review");
  assert.equal(prApproval.payload.message, "chore: prepare mr");
  assert.match(prApproval.detail, /Commit the current changes/);

  service.resolveApproval(prApproval.id, "approve");
  const assignment = service.claimNextCommand("runner-test");
  assert.ok(assignment);
  assert.equal(assignment.reviewMode, "commit_and_review");
  assert.equal(assignment.commitMessage, "chore: prepare mr");
  assert.equal(assignment.prTitle, "UI polish");
});

test("stop task cancels queued work before the runner claims it", () => {
  const service = createServiceWithRunner();
  const task = createTask(service);

  const canceled = service.stopTask(task.id);
  assert.equal(canceled.status, "canceled");

  const nextAssignment = service.claimNextCommand("runner-test");
  assert.equal(nextAssignment, undefined);
});

test("stop task marks a claimed runner command for cancellation and finalizes as canceled", () => {
  const service = createServiceWithRunner();
  const task = createTask(service);

  const assignment = service.claimNextCommand("runner-test");
  assert.ok(assignment);

  const stopRequested = service.stopTask(task.id);
  assert.ok(stopRequested.stopRequestedAt);
  assert.equal(stopRequested.status, "preparing_workspace");
  assert.match(stopRequested.summary, /Stop requested/);

  service.completeRunnerCommand("runner-test", task.id, {
    outcome: "canceled",
    summary: "Task canceled from iPhone. Local execution stopped on the Mac runner."
  });

  const snapshot = service.getTask(task.id);
  assert.ok(snapshot);
  assert.equal(snapshot.status, "canceled");
  assert.equal(snapshot.stopRequestedAt, undefined);
});

test("create PR is rejected before approval when the runner lacks GitHub PR support", () => {
  const service = createServiceWithRunner(["codex_cli", "git_guard"]);
  const task = createTask(service, {
    repo: "git@github.com:acme/demo.git"
  });

  const planAssignment = service.claimNextCommand("runner-test");
  assert.ok(planAssignment);
  service.completeRunnerCommand("runner-test", task.id, {
    outcome: "plan_ready",
    planSummary: "A plan",
    session: {
      executorType: "codex_cli",
      threadId: "thread-pr-missing",
      cwd: "/tmp/demo-repo",
      materializedFromHistory: false,
      lastTurnAt: "2026-04-02T10:00:00.000Z"
    }
  });

  const planApproval = service.listApprovals().find((candidate) => candidate.taskId === task.id && candidate.type === "plan.execute");
  assert.ok(planApproval);
  service.resolveApproval(planApproval.id, "approve");

  const implementationAssignment = service.claimNextCommand("runner-test");
  assert.ok(implementationAssignment);
  service.completeRunnerCommand("runner-test", task.id, {
    outcome: "turn_complete",
    summary: "Implementation complete."
  });

  assert.throws(
    () => service.requestGitAction(task.id, "create_pr"),
    /cannot create pull requests yet/
  );
});

test("create PR is rejected before approval when the runner lacks GitLab MR support", () => {
  const service = createServiceWithRunner(["codex_cli", "git_guard"]);
  const task = createTask(service, {
    repo: "git@gitlab.com:acme/demo.git"
  });

  const planAssignment = service.claimNextCommand("runner-test");
  assert.ok(planAssignment);
  service.completeRunnerCommand("runner-test", task.id, {
    outcome: "plan_ready",
    planSummary: "A plan",
    session: {
      executorType: "codex_cli",
      threadId: "thread-mr-missing",
      cwd: "/tmp/demo-repo",
      materializedFromHistory: false,
      lastTurnAt: "2026-04-02T10:00:00.000Z"
    }
  });

  const planApproval = service.listApprovals().find((candidate) => candidate.taskId === task.id && candidate.type === "plan.execute");
  assert.ok(planApproval);
  service.resolveApproval(planApproval.id, "approve");

  const implementationAssignment = service.claimNextCommand("runner-test");
  assert.ok(implementationAssignment);
  service.completeRunnerCommand("runner-test", task.id, {
    outcome: "turn_complete",
    summary: "Implementation complete."
  });

  assert.throws(
    () => service.requestGitAction(task.id, "create_pr"),
    /cannot create merge requests yet/
  );
});

test("direct-commit project defaults persist and project tasks can override them", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "task-service-delivery-mode-"));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const storagePath = path.join(tempRoot, "state.sqlite");
  const service = new TaskService({ storagePath });
  service.upsertRunner({
    id: "runner-test",
    name: "Test Runner",
    platform: "macOS",
    labels: ["local"],
    capabilities: ["codex_cli", "git_guard", "github_pr"]
  });

  service.syncRunnerProjects("runner-test", [
    {
      id: "project_direct",
      name: "Direct",
      repo: "/tmp/direct-project",
      baseBranch: "main",
      deliveryMode: "direct_commit",
      autoPush: true,
      defaultTaskTitle: "Continue direct task",
      defaultPrompt: "Implement the requested change.",
      isFeatured: false
    }
  ]);

  const inheritedTask = service.createTaskForProject("project_direct", {
    title: "Use project default",
    prompt: "Follow the project default delivery mode.",
    executionMode: "new_thread"
  });
  const overriddenTask = service.createTaskForProject("project_direct", {
    title: "Override delivery mode",
    prompt: "Override the project delivery mode once.",
    deliveryMode: "review_required",
    autoPush: false,
    executionMode: "new_thread",
    allowParallel: true
  });

  assert.equal(inheritedTask.deliveryMode, "direct_commit");
  assert.equal(inheritedTask.autoPush, true);
  assert.equal(overriddenTask.deliveryMode, "review_required");
  assert.equal(overriddenTask.autoPush, false);

  const reloaded = new TaskService({ storagePath });
  assert.equal(reloaded.getProject("project_direct")?.deliveryMode, "direct_commit");
  assert.equal(reloaded.getProject("project_direct")?.autoPush, true);
  assert.equal(reloaded.getTask(inheritedTask.id)?.deliveryMode, "direct_commit");
  assert.equal(reloaded.getTask(inheritedTask.id)?.autoPush, true);
  assert.equal(reloaded.getTask(overriddenTask.id)?.deliveryMode, "review_required");
  assert.equal(reloaded.getTask(overriddenTask.id)?.autoPush, false);
});

test("direct-commit tasks start implementation automatically and become completed after a local commit", () => {
  const service = createServiceWithRunner(["codex_cli", "git_guard", "github_pr"]);
  const task = createTask(service, {
    repo: "git@github.com:demo/mobile.git",
    deliveryMode: "direct_commit"
  });

  const planAssignment = service.claimNextCommand("runner-test");
  assert.ok(planAssignment);
  service.completeRunnerCommand("runner-test", task.id, {
    outcome: "plan_ready",
    planSummary: "1. Update the repo\n2. Run checks\n3. Commit locally",
    session: {
      executorType: "codex_cli",
      threadId: "thread-direct-commit",
      cwd: "/tmp/worktrees/direct-commit",
      materializedFromHistory: false,
      lastTurnAt: "2026-04-08T00:00:00.000Z"
    }
  });

  const snapshotAfterPlan = service.getTask(task.id);
  assert.ok(snapshotAfterPlan);
  assert.equal(snapshotAfterPlan.status, "queued");
  assert.match(snapshotAfterPlan.summary, /start implementation automatically/i);
  assert.equal(
    service.listApprovals().find((candidate) => candidate.taskId === task.id && candidate.type === "plan.execute"),
    undefined
  );

  const turnAssignment = service.claimNextCommand("runner-test");
  assert.ok(turnAssignment);
  assert.equal(turnAssignment.kind, "continue_prompt");
  assert.match(turnAssignment.prompt ?? "", /git add -A/);
  service.completeRunnerCommand("runner-test", task.id, {
    outcome: "turn_complete",
    summary: "Implemented the change and committed locally.",
    implementationCommitCreated: true
  });

  const completedSnapshot = service.getTask(task.id);
  assert.ok(completedSnapshot);
  assert.equal(completedSnapshot.status, "completed");
  assert.equal(
    completedSnapshot.summary,
    "Implementation turn finished with a local commit. This direct-commit task is now completed."
  );

  assert.throws(
    () => service.requestGitAction(task.id, "create_pr"),
    /direct_commit delivery/
  );
});

test("direct-commit tasks in plain folders complete without requiring Git", () => {
  const service = createServiceWithRunner(["codex_cli", "git_guard"]);
  const task = createTask(service, {
    repo: "/tmp/plain-folder-task",
    deliveryMode: "direct_commit"
  });

  const planAssignment = service.claimNextCommand("runner-test");
  assert.ok(planAssignment);
  service.completeRunnerCommand("runner-test", task.id, {
    outcome: "plan_ready",
    planSummary: "1. Create the requested files\n2. Run checks when available",
    session: {
      executorType: "codex_cli",
      threadId: "thread-plain-folder",
      cwd: "/tmp/plain-folder-task",
      materializedFromHistory: false,
      lastTurnAt: "2026-04-08T00:00:00.000Z"
    }
  });

  const turnAssignment = service.claimNextCommand("runner-test");
  assert.ok(turnAssignment);
  service.completeRunnerCommand("runner-test", task.id, {
    outcome: "turn_complete",
    summary: "Created the requested files in the plain folder.",
    workspaceIsGitRepository: false
  });

  const completedSnapshot = service.getTask(task.id);
  assert.ok(completedSnapshot);
  assert.equal(completedSnapshot.status, "completed");
  assert.equal(
    completedSnapshot.summary,
    "Implementation turn finished in a plain local folder. This direct-submit task is now completed without Git."
  );
});

test("direct-commit tasks stay awaiting input when the implementation turn stops before committing", () => {
  const service = createServiceWithRunner(["codex_cli", "git_guard"]);
  const task = createTask(service, {
    repo: "/tmp/direct-commit-waiting",
    deliveryMode: "direct_commit"
  });

  const planAssignment = service.claimNextCommand("runner-test");
  assert.ok(planAssignment);
  service.completeRunnerCommand("runner-test", task.id, {
    outcome: "plan_ready",
    planSummary: "1. Update the repo\n2. Run checks\n3. Stop before committing",
    session: {
      executorType: "codex_cli",
      threadId: "thread-direct-commit-waiting",
      cwd: "/tmp/worktrees/direct-commit-waiting",
      materializedFromHistory: false,
      lastTurnAt: "2026-04-08T00:00:00.000Z"
    }
  });

  const turnAssignment = service.claimNextCommand("runner-test");
  assert.ok(turnAssignment);
  service.completeRunnerCommand("runner-test", task.id, {
    outcome: "turn_complete",
    summary: "Implemented the change but stopped before committing."
  });

  const snapshot = service.getTask(task.id);
  assert.ok(snapshot);
  assert.equal(snapshot.status, "awaiting_human_input");
  assert.equal(
    snapshot.summary,
    "Implementation turn finished without a local commit, so the task is waiting for your next instruction."
  );
});

test("manual commit completes direct-commit tasks", () => {
  const service = createServiceWithRunner(["codex_cli", "git_guard"]);
  const task = createTask(service, {
    repo: "/tmp/direct-commit-manual",
    deliveryMode: "direct_commit"
  });

  const planAssignment = service.claimNextCommand("runner-test");
  assert.ok(planAssignment);
  service.completeRunnerCommand("runner-test", task.id, {
    outcome: "plan_ready",
    planSummary: "A plan",
    session: {
      executorType: "codex_cli",
      threadId: "thread-direct-commit-manual",
      cwd: "/tmp/direct-commit-manual",
      materializedFromHistory: false,
      lastTurnAt: "2026-04-08T00:00:00.000Z"
    }
  });

  const turnAssignment = service.claimNextCommand("runner-test");
  assert.ok(turnAssignment);
  service.completeRunnerCommand("runner-test", task.id, {
    outcome: "turn_complete",
    summary: "Implemented the change without creating a commit."
  });

  service.requestGitAction(task.id, "commit", "feat: finish direct commit");
  const commitApproval = service.listApprovals().find((candidate) => candidate.taskId === task.id && candidate.type === "git.commit");
  assert.ok(commitApproval);
  service.resolveApproval(commitApproval.id, "approve");

  const gitAssignment = service.claimNextCommand("runner-test");
  assert.ok(gitAssignment);
  assert.equal(gitAssignment.kind, "git.commit");
  service.completeRunnerCommand("runner-test", task.id, {
    outcome: "git_completed",
    action: "commit",
    summary: "Commit created on feature/direct_commit_manual."
  });

  const snapshot = service.getTask(task.id);
  assert.ok(snapshot);
  assert.equal(snapshot.status, "completed");
  assert.equal(snapshot.summary, "Local commit created. This direct-commit task is now completed.");
});

test("direct-commit tasks completed by a local commit can still queue follow-ups", () => {
  const service = createServiceWithRunner(["codex_cli", "git_guard"]);
  const task = createTask(service, {
    repo: "/tmp/direct-commit-follow-up",
    deliveryMode: "direct_commit"
  });

  const planAssignment = service.claimNextCommand("runner-test");
  assert.ok(planAssignment);
  service.completeRunnerCommand("runner-test", task.id, {
    outcome: "plan_ready",
    planSummary: "1. Update the repo\n2. Run checks\n3. Commit locally",
    session: {
      executorType: "codex_cli",
      threadId: "thread-direct-commit-follow-up",
      cwd: "/tmp/worktrees/direct-commit-follow-up",
      materializedFromHistory: false,
      lastTurnAt: "2026-04-08T00:00:00.000Z"
    }
  });

  const turnAssignment = service.claimNextCommand("runner-test");
  assert.ok(turnAssignment);
  service.completeRunnerCommand("runner-test", task.id, {
    outcome: "turn_complete",
    summary: "Implemented the change and committed locally.",
    implementationCommitCreated: true
  });

  const followUp = service.addUserMessage(task.id, "Apply one more tweak after the completed local commit.");
  assert.equal(followUp.status, "queued");

  const followUpAssignment = service.claimNextCommand("runner-test");
  assert.ok(followUpAssignment);
  assert.equal(followUpAssignment.kind, "continue_prompt");
  assert.equal(followUpAssignment.prompt, "Apply one more tweak after the completed local commit.");
});

test("sqlite migration backfills legacy projects and tasks to review_required delivery mode", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "task-service-legacy-delivery-mode-"));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const storagePath = path.join(tempRoot, "legacy.sqlite");
  const db = new DatabaseSync(storagePath);

  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      repo TEXT NOT NULL,
      baseBranch TEXT NOT NULL,
      defaultTaskTitle TEXT NOT NULL,
      defaultPrompt TEXT NOT NULL,
      isFeatured INTEGER NOT NULL DEFAULT 0,
      runnerId TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      lastSyncedAt TEXT NOT NULL
    );

    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      workflowKey TEXT NOT NULL,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      repo TEXT NOT NULL,
      baseBranch TEXT NOT NULL,
      projectId TEXT,
      projectName TEXT,
      branchName TEXT NOT NULL DEFAULT '',
      executionBranch TEXT,
      reviewPlatform TEXT,
      reviewTargetBranchesJson TEXT,
      dirtyWorkspaceJson TEXT,
      executionMode TEXT NOT NULL,
      resumeThreadId TEXT,
      stopRequestedAt TEXT,
      status TEXT NOT NULL,
      runnerId TEXT,
      sessionAlias TEXT NOT NULL UNIQUE,
      summary TEXT NOT NULL,
      reportURL TEXT,
      lastPublishedAt TEXT,
      latestResultSummary TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
  `);

  db.prepare(
    `
      INSERT INTO projects (
        id, name, repo, baseBranch, defaultTaskTitle, defaultPrompt,
        isFeatured, runnerId, createdAt, updatedAt, lastSyncedAt
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
  ).run(
    "project_legacy",
    "Legacy Project",
    "/tmp/legacy-project",
    "main",
    "Continue legacy task",
    "Implement the requested legacy change.",
    0,
    "runner-test",
    "2026-04-08T00:00:00.000Z",
    "2026-04-08T00:00:00.000Z",
    "2026-04-08T00:00:00.000Z"
  );

  db.prepare(
    `
      INSERT INTO tasks (
        id, workflowKey, title, prompt, repo, baseBranch, projectId, projectName,
        branchName, executionBranch, reviewPlatform, reviewTargetBranchesJson, dirtyWorkspaceJson, executionMode, resumeThreadId, stopRequestedAt, status, runnerId, sessionAlias, summary,
        reportURL, lastPublishedAt, latestResultSummary, createdAt, updatedAt
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
  ).run(
    "task_legacy",
    "coding_session",
    "Legacy task",
    "Implement the requested legacy change",
    "/tmp/legacy-project",
    "main",
    "project_legacy",
    "Legacy Project",
    "feature/legacy_change",
    "feature/legacy_change",
    "github",
    JSON.stringify(["main"]),
    null,
    "new_thread",
    null,
    null,
    "awaiting_human_input",
    "runner-test",
    "session_legacy",
    "Legacy summary",
    null,
    null,
    null,
    "2026-04-08T00:00:00.000Z",
    "2026-04-08T00:00:00.000Z"
  );
  db.close();

  const service = new TaskService({ storagePath, retentionDays: 3650 });
  assert.equal(service.getProject("project_legacy")?.deliveryMode, "review_required");
  assert.equal(service.getTask("task_legacy")?.deliveryMode, "review_required");
});

test("global task listing sorts by urgency first and newest first within the same status", async () => {
  const service = createServiceWithRunner();

  const olderApproval = createTask(service, {
    repo: "/tmp/demo-repo-older",
    title: "Fix detail number display",
    prompt: "Fix detail number display on the item card."
  });
  const olderPlan = service.claimNextCommand("runner-test");
  assert.ok(olderPlan);
  service.completeRunnerCommand("runner-test", olderApproval.id, {
    outcome: "plan_ready",
    planSummary: "Older plan",
    session: {
      executorType: "codex_cli",
      threadId: "thread-older",
      cwd: "/tmp/demo-repo",
      materializedFromHistory: false,
      lastTurnAt: "2026-04-02T10:00:00.000Z"
    }
  });
  await delay(5);

  const newerApproval = createTask(service, {
    repo: "/tmp/demo-repo-newer",
    title: "Add item UI polish",
    prompt: "Implement the item UI polish request."
  });
  const newerPlan = service.claimNextCommand("runner-test");
  assert.ok(newerPlan);
  service.completeRunnerCommand("runner-test", newerApproval.id, {
    outcome: "plan_ready",
    planSummary: "Newer plan",
    session: {
      executorType: "codex_cli",
      threadId: "thread-newer",
      cwd: "/tmp/demo-repo",
      materializedFromHistory: false,
      lastTurnAt: "2026-04-02T10:05:00.000Z"
    }
  });

  const queuedTask = createTask(service, {
    repo: "/tmp/demo-repo-queued",
    title: "Queued task",
    prompt: "Leave this task queued."
  });

  const orderedTaskIDs = service.listTasks().map((task) => task.id);
  assert.deepEqual(orderedTaskIDs.slice(0, 3), [newerApproval.id, olderApproval.id, queuedTask.id]);
});

test("project history includes older tasks that only match the synced repository", () => {
  const service = createServiceWithRunner();

  service.syncRunnerProjects("runner-test", [
    {
      id: "project_mobile",
      name: "Mobile",
      repo: "/tmp/mobile-repo",
      baseBranch: "main",
      deliveryMode: "review_required",
      autoPush: true,
      defaultTaskTitle: "Default title",
      defaultPrompt: "Default prompt",
      isFeatured: true
    }
  ]);

  const directTask = createTask(service, {
    title: "Direct repo task",
    repo: "/tmp/mobile-repo/"
  });

  const projectTasks = service.listTasks({ projectId: "project_mobile" });
  assert.equal(projectTasks.some((task) => task.id === directTask.id), true);
  assert.equal(service.getProject("project_mobile")?.recentTasksCount, 1);
  assert.equal(service.getProject("missing-project")?.recentTasksCount, undefined);
});

test("project task listing also sorts by urgency first", async () => {
  const service = createServiceWithRunner();

  service.syncRunnerProjects("runner-test", [
    {
      id: "project_mobile",
      name: "Mobile",
      repo: "/tmp/mobile-repo",
      baseBranch: "main",
      deliveryMode: "review_required",
      autoPush: true,
      defaultTaskTitle: "Default title",
      defaultPrompt: "Default prompt",
      isFeatured: false
    }
  ]);

  const olderApproval = service.createTaskForProject("project_mobile", {
    title: "Older approval",
    prompt: "Prepare a plan.",
    executionMode: "new_thread"
  });
  const olderClaim = service.claimNextCommand("runner-test");
  assert.ok(olderClaim);
  service.completeRunnerCommand("runner-test", olderApproval.id, {
    outcome: "failed",
    summary: "Runner failed while preparing the project task.",
    detail: "workspace lock timed out"
  });
  await delay(5);

  const newerQueued = service.createTaskForProject("project_mobile", {
    title: "Newer queued",
    prompt: "Leave queued.",
    executionMode: "new_thread"
  });

  const orderedTaskIDs = service.listTasks({ projectId: "project_mobile" }).map((task) => task.id);
  assert.deepEqual(orderedTaskIDs.slice(0, 2), [olderApproval.id, newerQueued.id]);
});
