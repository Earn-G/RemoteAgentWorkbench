import type { ExecutorSession, RunnerCompletionPayload, TaskSnapshot } from "./models.js";

function now(): string {
  return new Date().toISOString();
}

function deriveExecutorSession(
  task: TaskSnapshot,
  runnerId: string,
  sessionPatch?: {
    executorType?: "codex_app_server" | "codex_cli";
    threadId?: string;
    cwd?: string;
    materializedFromHistory?: boolean;
    lastTurnAt?: string;
  }
): ExecutorSession | undefined {
  const existing = task.executorSession;
  const executorType = sessionPatch?.executorType ?? existing?.executorType;
  const threadId = sessionPatch?.threadId ?? existing?.threadId;
  const cwd = sessionPatch?.cwd ?? existing?.cwd;
  const materializedFromHistory = sessionPatch?.materializedFromHistory ?? existing?.materializedFromHistory;
  const lastTurnAt = sessionPatch?.lastTurnAt ?? existing?.lastTurnAt;

  if (!executorType || !threadId || !cwd || materializedFromHistory === undefined || !lastTurnAt) {
    return existing;
  }

  return {
    sessionAlias: task.sessionAlias,
    executorType,
    runnerId,
    threadId,
    cwd,
    materializedFromHistory,
    lastTurnAt
  };
}

function summarizeTurnCompletion(task: TaskSnapshot, completion: Extract<RunnerCompletionPayload, { outcome: "turn_complete" }>): string {
  if (task.deliveryMode === "direct_commit" && completion.workspaceIsGitRepository === false) {
    return "Implementation turn finished in a plain local folder. This direct-submit task is now completed without Git.";
  }

  if (task.deliveryMode === "direct_commit" && completion.implementationCommitCreated) {
    return "Implementation turn finished with a local commit. This direct-commit task is now completed.";
  }

  if (task.deliveryMode === "direct_commit") {
    return "Implementation turn finished without a local commit, so the task is waiting for your next instruction.";
  }

  return "Implementation turn finished. This task is now completed, and push or review delivery remains optional.";
}

function resolveTurnCompletionStatus(
  task: TaskSnapshot,
  completion: Extract<RunnerCompletionPayload, { outcome: "turn_complete" }>
): TaskSnapshot["status"] {
  if (task.deliveryMode === "direct_commit" && (completion.implementationCommitCreated || completion.workspaceIsGitRepository === false)) {
    return "completed";
  }

  return task.deliveryMode === "review_required" ? "completed" : "awaiting_human_input";
}

function summarizeGitCompletion(task: TaskSnapshot, completion: Extract<RunnerCompletionPayload, { outcome: "git_completed" }>): string {
  if (completion.action === "commit" && task.deliveryMode === "direct_commit") {
    return "Local commit created. This direct-commit task is now completed.";
  }

  return completion.summary;
}

function resolveGitCompletionStatus(
  task: TaskSnapshot,
  completion: Extract<RunnerCompletionPayload, { outcome: "git_completed" }>
): TaskSnapshot["status"] {
  if (completion.action === "push" || completion.action === "create_pr") {
    return "completed";
  }

  if (completion.action === "commit" && task.deliveryMode === "direct_commit") {
    return "completed";
  }

  return "awaiting_human_input";
}

export function deriveSnapshotAfterCompletion(
  task: TaskSnapshot,
  runnerId: string,
  completion: RunnerCompletionPayload
): TaskSnapshot {
  let status = task.status;
  let summary = task.summary;
  let latestResultSummary = task.latestResultSummary;
  let reportURL = task.reportURL;
  let lastPublishedAt = task.lastPublishedAt;

  switch (completion.outcome) {
    case "plan_ready":
      if (task.deliveryMode === "direct_commit") {
        status = "queued";
        summary = "Plan captured. Waiting for the Mac runner to start implementation automatically.";
      } else {
        status = "awaiting_plan_approval";
        summary = "Codex generated an initial plan and is waiting for approval.";
      }
      break;
    case "turn_complete":
      status = resolveTurnCompletionStatus(task, completion);
      summary = summarizeTurnCompletion(task, completion);
      latestResultSummary = completion.latestResultSummary ?? completion.summary;
      reportURL = completion.reportURL ?? reportURL;
      lastPublishedAt = completion.lastPublishedAt ?? lastPublishedAt;
      break;
    case "handoff_completed":
      status = "awaiting_human_input";
      summary = "The task workspace is now open in Codex App on the Mac runner.";
      break;
    case "git_completed":
      status = resolveGitCompletionStatus(task, completion);
      summary = summarizeGitCompletion(task, completion);
      latestResultSummary = completion.latestResultSummary ?? completion.summary;
      reportURL = completion.reportURL ?? reportURL;
      lastPublishedAt = completion.lastPublishedAt ?? lastPublishedAt;
      break;
    case "dirty_workspace_detected":
      status = "awaiting_human_input";
      summary = completion.summary;
      latestResultSummary = completion.latestResultSummary ?? completion.summary;
      reportURL = completion.reportURL ?? reportURL;
      lastPublishedAt = completion.lastPublishedAt ?? lastPublishedAt;
      break;
    case "workspace_inspected_clean":
      status = "awaiting_human_input";
      summary = completion.summary;
      latestResultSummary = completion.latestResultSummary ?? completion.summary;
      reportURL = completion.reportURL ?? reportURL;
      lastPublishedAt = completion.lastPublishedAt ?? lastPublishedAt;
      break;
    case "protected_git_command_blocked":
      status = "awaiting_git_approval";
      summary = completion.summary;
      break;
    case "failed":
      status = "failed";
      summary = completion.detail ?? completion.summary;
      break;
    case "canceled":
      status = "canceled";
      summary = completion.detail ?? completion.summary;
      break;
  }

  return {
    ...task,
    runnerId,
    status,
    summary,
    executionBranch: "currentBranch" in completion ? completion.currentBranch ?? task.executionBranch : task.executionBranch,
    reviewPlatform: "reviewPlatform" in completion ? completion.reviewPlatform ?? task.reviewPlatform : task.reviewPlatform,
    reviewTargetBranches: "reviewTargetBranches" in completion ? completion.reviewTargetBranches ?? task.reviewTargetBranches : task.reviewTargetBranches,
    reportURL,
    lastPublishedAt,
    latestResultSummary,
    stopRequestedAt: undefined,
    dirtyWorkspace: completion.outcome === "dirty_workspace_detected"
      ? {
          state: "pending_decision",
          currentBranch: completion.currentBranch ?? task.executionBranch,
          statusSummary: completion.statusSummary,
          detectedAt: now(),
          snapshotPublishedAt: completion.lastPublishedAt
        }
      : task.dirtyWorkspace,
    updatedAt: now(),
    executorSession: "session" in completion ? deriveExecutorSession(task, runnerId, completion.session) : task.executorSession
  };
}
