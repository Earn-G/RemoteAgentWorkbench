import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { spawn } from "node:child_process";
import { config } from "./config.js";
import { ControlPlaneClient, isRunnerInstanceMismatchError } from "./controlPlaneClient.js";
import {
  createCodexProfile,
  deleteCodexProfile,
  readCodexConfigSnapshot,
  restartCodexApp,
  switchCodexProfile
} from "./codexConfigManager.js";
import { CodexRunCanceledError, CodexRunFailedError, runCodex, type CodexRunEvent } from "./codexExecutor.js";
import { DirectoryCatalog } from "./directoryCatalog.js";
import { FileLockManager } from "./fileLock.js";
import { createGitGuardEnvironment, readBlockedProtectedGitCommand } from "./gitGuard.js";
import { attemptAutoPush, buildLatestResultSummary } from "./autoPush.js";
import type {
  DirtyWorkspaceDecision,
  GitAction,
  ProtectedGitCommandKind,
  RunnerAssignment,
  RunnerCompletionPayload,
  RunnerLogPayload,
  TaskSnapshot,
  UtilityRunnerAssignment
} from "./models.js";
import { ProjectCatalog } from "./projectCatalog.js";
import { ReportPublisher } from "./reportPublisher.js";
import { RepositoryManager, type WorkspaceGitState } from "./repositoryManager.js";
import { detectCapabilities, detectVersions } from "./system.js";
import { deriveSnapshotAfterCompletion } from "./taskSnapshot.js";
import { TaskHistoryRecorder } from "./taskHistory.js";
import { prepareImplementationTurn } from "./taskPrompting.js";
import { formatBeijingDateTime } from "./time.js";

const client = new ControlPlaneClient();
const repositories = new RepositoryManager(config.repoCacheDir, config.workspaceDir);
const runnerJournalPath = config.paths.requestJournalPath;
const projectCatalog = new ProjectCatalog(config.projectsFilePath);
const directoryCatalog = new DirectoryCatalog(config.directoriesFilePath);
const taskHistory = new TaskHistoryRecorder(config.tasksDir, config.codexHome);
const lockManager = new FileLockManager(config.lockRootDir);
const reportPublisher = new ReportPublisher(taskHistory, {
  ...config.reports,
  lockManager,
  resolveReportNamespace: (task) =>
    projectCatalog.resolveReportNamespace({
      projectId: task.projectId,
      projectName: task.projectName,
      repo: task.repo
    })
});

function now(): string {
  return new Date().toISOString();
}

class TaskCanceledError extends Error {
  constructor(message = "Task canceled from iPhone.") {
    super(message);
    this.name = "TaskCanceledError";
  }
}

function isAbortError(error: unknown): boolean {
  const typed = error as { name?: string; code?: number | string };
  return typed?.name === "AbortError" || typed?.code === "ABORT_ERR";
}

function isTaskCanceledError(error: unknown): error is TaskCanceledError | CodexRunCanceledError {
  return error instanceof TaskCanceledError || error instanceof CodexRunCanceledError || isAbortError(error);
}

function throwIfTaskStopRequested(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new TaskCanceledError();
  }
}

function sameCapabilities(lhs: string[], rhs: string[]): boolean {
  return [...lhs].sort().join("|") === [...rhs].sort().join("|");
}

function isLegacyManagedWorktree(targetPath: string): boolean {
  const relative = path.relative(config.workspaceDir, targetPath);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function appendRunnerJournal(entry: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.dirname(runnerJournalPath), { recursive: true });
  await fs.appendFile(
    runnerJournalPath,
    `${JSON.stringify({
      recordedAt: now(),
      ...entry
    })}\n`,
    "utf8"
  );
}

async function collectCodexConfigState(): Promise<{
  codexConfigProfiles: string[];
  activeCodexConfigProfile?: string;
}> {
  const snapshot = await readCodexConfigSnapshot(config.codexProfilesRoot, config.codex.liveDirectory);

  return {
    codexConfigProfiles: snapshot.profiles,
    activeCodexConfigProfile: snapshot.activeProfileName
  };
}

function buildPlanPrompt(task: TaskSnapshot, isGitRepository: boolean): string {
  const workspaceLabel = isGitRepository ? "repository" : "local folder";
  const deliveryInstruction = task.deliveryMode === "direct_commit"
    ? isGitRepository
      ? "Delivery mode: direct_submit with Git available. The implementation should end with a local `git add -A` and `git commit` once the requested changes are done and the relevant checks pass, unless the user explicitly asked not to commit or the work is still blocked. That successful local commit marks the task completed. It must not push or create a PR/MR automatically."
      : "Delivery mode: direct_submit in a plain local folder. Git is not initialized here, so implementation must not run Git. Saving the requested file changes and summarizing validation marks the task completed."
    : isGitRepository
      ? "Delivery mode: review_required. The implementation must stop before any commit, push, or PR/MR and wait for explicit approval."
      : "Delivery mode: review_required in a plain local folder. Git is not initialized here, so implementation must not run Git; finish by summarizing the changed files and checks.";

  return [
    `Inspect the ${workspaceLabel} and the user's request, then reply with a concise numbered implementation plan only.`,
    "Do not modify any files.",
    isGitRepository ? "Do not commit, push, or change git state." : "Do not run Git.",
    deliveryInstruction,
    `User request: ${task.prompt}`
  ].join("\n\n");
}

function shouldUseCurrentBranch(task: Pick<TaskSnapshot, "branchMode" | "executionBranch">): boolean {
  return task.branchMode === "current_branch" && !task.executionBranch;
}

function resolveExpectedTaskBranch(task: Pick<TaskSnapshot, "executionBranch" | "branchName">): string {
  const branchName = task.executionBranch ?? task.branchName;
  if (branchName?.trim()) {
    return branchName;
  }

  throw new Error("The task does not have a resolved execution branch yet.");
}

async function ensureWorkspace(task: TaskSnapshot, signal?: AbortSignal): Promise<{
  workspacePath: string;
  branchName?: string;
  isGitRepository: boolean;
  reviewPlatform?: "github" | "gitlab";
  reviewTargetBranches?: string[];
}> {
  const preferredBranchName = task.executionBranch ?? task.branchName;
  const useCurrentBranch = shouldUseCurrentBranch(task);

  if (task.executorSession?.cwd && !isLegacyManagedWorktree(task.executorSession.cwd)) {
    try {
      await fs.access(task.executorSession.cwd);
      const prepared = await repositories.prepareWorkspace(task.id, task.executorSession.cwd, task.baseBranch, {
        preferredBranchName,
        useCurrentBranch,
        resumeExistingBranch: true,
        signal
      });
      return {
        workspacePath: prepared.workspacePath,
        branchName: prepared.branchName,
        isGitRepository: prepared.isGitRepository,
        reviewPlatform: prepared.reviewPlatform,
        reviewTargetBranches: prepared.reviewTargetBranches
      };
    } catch (error) {
      if (isTaskCanceledError(error)) {
        throw error;
      }
      // Fall back to resolving the configured repository path if the saved path is gone.
    }
  }

  const prepared = await repositories.prepareWorkspace(task.id, task.repo, task.baseBranch, {
    preferredBranchName,
    useCurrentBranch,
    resumeExistingBranch: Boolean(task.executorSession?.cwd),
    signal
  });
  return {
    workspacePath: prepared.workspacePath,
    branchName: prepared.branchName,
    isGitRepository: prepared.isGitRepository,
    reviewPlatform: prepared.reviewPlatform,
    reviewTargetBranches: prepared.reviewTargetBranches
  };
}

function describePreparedWorkspace(prepared: {
  workspacePath: string;
  branchName?: string;
  isGitRepository: boolean;
}): string {
  if (!prepared.isGitRepository) {
    return `Using local directory ${prepared.workspacePath}. Git has not been initialized there yet.`;
  }

  return `Prepared repository at ${prepared.workspacePath} on branch ${prepared.branchName || "(detached HEAD)"}.`;
}

function describeCleanWorkspaceInspection(inspection: {
  sourceRepoPath: string;
  currentBranch?: string;
  isGitRepository: boolean;
}): string {
  if (!inspection.isGitRepository) {
    return `Directory ${inspection.sourceRepoPath} exists and is not a Git repository yet. No dirty Git state was found.`;
  }

  return `No uncommitted local changes were found in ${inspection.sourceRepoPath} on ${inspection.currentBranch || "(detached HEAD)"}.`;
}

async function sendRunnerLog(runnerId: string, taskId: string, payload: RunnerLogPayload): Promise<void> {
  await taskHistory.recordRunnerLog(taskId, payload);
  try {
    await client.log(runnerId, taskId, payload);
  } catch (error) {
    terminateIfRunnerInstanceWasSuperseded(error);
    console.error(`[runner] failed to sync runner log ${payload.kind} for ${taskId}`, error);
  }
}

function withAssignmentIdentity<T extends object>(
  assignment: Pick<RunnerAssignment, "id" | "claimToken">,
  payload: T
): T & { commandId: string; claimToken: string } {
  return {
    ...payload,
    commandId: assignment.id,
    claimToken: assignment.claimToken
  };
}

function terminateIfRunnerInstanceWasSuperseded(error: unknown): void {
  if (!isRunnerInstanceMismatchError(error)) {
    return;
  }

  console.error(
    `[runner] shutting down stale instance ${client.instanceId} for ${config.runnerId}; another process is now active`
  );
  process.exit(0);
}

async function syncLatestSnapshot(taskId: string): Promise<TaskSnapshot | undefined> {
  try {
    const snapshot = await client.fetchTask(taskId);
    await taskHistory.syncSnapshot(snapshot);
    return snapshot;
  } catch (error) {
    console.error(`[runner] failed to refresh task snapshot for ${taskId}`, error);
    return undefined;
  }
}

async function maybePublishReport(
  assignment: Pick<RunnerAssignment, "id" | "claimToken">,
  snapshot: TaskSnapshot,
  signal?: AbortSignal
): Promise<{
  reportURL?: string;
  lastPublishedAt?: string;
  latestResultSummary?: string;
}> {
  try {
    const published = await reportPublisher.publish(snapshot, { signal });
    if (config.reports.repoURL.trim()) {
      if (published.remoteSyncError) {
        const detail =
          `Task report was written locally as \`${published.reportRelativePath}\`, ` +
          `but syncing to the reports repository failed: ${published.remoteSyncError}`;
        await sendRunnerLog(snapshot.runnerId ?? config.runnerId, snapshot.id, withAssignmentIdentity(assignment, {
          kind: "report.publish_failed",
          title: "Report sync failed",
          detail,
          summary: "Task report sync failed, but the task is continuing without a remote report link."
        }));
      } else {
        const detail = published.reportURL
          ? `Uploaded task report to [${published.reportRelativePath}](${published.reportURL}).`
          : `Uploaded task report to \`${published.reportRelativePath}\` in the reports repository.`;
        await sendRunnerLog(snapshot.runnerId ?? config.runnerId, snapshot.id, withAssignmentIdentity(assignment, {
          kind: "report.published",
          title: "Report uploaded",
          detail
        }));
      }
    }
    return {
      reportURL: published.reportURL,
      lastPublishedAt: published.publishedAt,
      latestResultSummary: published.latestResultSummary
    };
  } catch (error) {
    if (isTaskCanceledError(error)) {
      throw error;
    }

    const detail = `Task report publishing failed unexpectedly: ${error instanceof Error ? error.message : "Unknown report publishing failure"}`;
    await sendRunnerLog(snapshot.runnerId ?? config.runnerId, snapshot.id, withAssignmentIdentity(assignment, {
      kind: "report.publish_failed",
      title: "Report sync failed",
      detail,
      summary: "Task report sync failed, but the task is continuing without a remote report link."
    }));
    return {
      latestResultSummary: snapshot.latestResultSummary ?? snapshot.summary
    };
  }
}

async function cleanupLocalTaskHistory(): Promise<void> {
  const removedTaskIds = await taskHistory.cleanupExpiredTasks(config.localTaskRetentionDays);
  if (removedTaskIds.length > 0) {
    console.log(
      `[runner] cleaned ${removedTaskIds.length} expired local task entr${removedTaskIds.length === 1 ? "y" : "ies"} from ${config.tasksDir}`
    );
  }
}

function startTaskStopWatcher(assignment: RunnerAssignment, abortController: AbortController): () => void {
  const interval = setInterval(() => {
    if (abortController.signal.aborted) {
      return;
    }

    void client.fetchTask(assignment.taskId)
      .then((snapshot) => {
        if (snapshot.stopRequestedAt && !abortController.signal.aborted) {
          abortController.abort();
        }
      })
      .catch((error) => {
        console.error(`[runner] failed to poll stop state for ${assignment.taskId}`, error);
      });
  }, 2000);

  return () => clearInterval(interval);
}

function dirtyWorkspaceSummary(currentBranch?: string): string {
  return `Repository has uncommitted local changes on ${currentBranch || "(detached HEAD)"}. Choose how to proceed before Codex edits this repo.`;
}

function didImplementationCreateLocalCommit(before?: WorkspaceGitState, after?: WorkspaceGitState): boolean {
  if (!before || !after) {
    return false;
  }

  return before.headCommit !== after.headCommit && !after.hasUncommittedChanges;
}

async function completeDirtyWorkspaceDetected(
  assignment: RunnerAssignment,
  inspection: {
    sourceRepoPath: string;
    currentBranch?: string;
    statusSummary?: string;
    reviewPlatform?: "github" | "gitlab";
    reviewTargetBranches?: string[];
  },
  signal?: AbortSignal
): Promise<void> {
  await taskHistory.recordExecutionMapping(assignment.taskId, {
    workspacePath: inspection.sourceRepoPath,
    executionBranch: inspection.currentBranch
  });

  const dirtyWorkspaceSnapshot = await reportPublisher.captureDirtyWorkspaceSnapshot(inspection.sourceRepoPath, signal);
  const baseSummary = dirtyWorkspaceSummary(inspection.currentBranch);
  const dirtySnapshot: TaskSnapshot = {
    ...assignment.task,
    status: "awaiting_human_input",
    summary: baseSummary,
    executionBranch: inspection.currentBranch ?? assignment.task.executionBranch,
    reviewPlatform: inspection.reviewPlatform ?? assignment.task.reviewPlatform,
    reviewTargetBranches: inspection.reviewTargetBranches ?? assignment.task.reviewTargetBranches,
    dirtyWorkspace: {
      state: "pending_decision",
      currentBranch: inspection.currentBranch ?? assignment.task.executionBranch,
      statusSummary: inspection.statusSummary,
      detectedAt: now()
    },
    updatedAt: now()
  };
  const published = await reportPublisher.publish(dirtySnapshot, {
    dirtyWorkspaceSnapshot,
    signal,
    skipRemoteSync: true
  });
  const completion: RunnerCompletionPayload = {
    outcome: "dirty_workspace_detected",
    summary: baseSummary,
    currentBranch: inspection.currentBranch,
    statusSummary: inspection.statusSummary,
    reviewPlatform: inspection.reviewPlatform,
    reviewTargetBranches: inspection.reviewTargetBranches,
    ...published
  };
  await taskHistory.recordCompletion(
    assignment.taskId,
    completion,
    deriveSnapshotAfterCompletion(assignment.task, assignment.runnerId, completion)
  );
  await client.complete(assignment.runnerId, assignment.taskId, withAssignmentIdentity(assignment, completion));
  await syncLatestSnapshot(assignment.taskId);
}

async function completePlanningTurn(
  assignment: RunnerAssignment,
  workspacePath: string,
  isGitRepository: boolean,
  executionBranch: string | undefined,
  signal?: AbortSignal
): Promise<void> {
  throwIfTaskStopRequested(signal);
  await sendRunnerLog(assignment.runnerId, assignment.taskId, withAssignmentIdentity(assignment, {
    kind: "codex.plan_started",
    title: "Codex planning started",
    detail: "Starting the Codex planning turn in the prepared project folder.",
    executionBranch,
    status: "running",
    summary: "Codex is generating the initial plan in the project folder."
  }));

  const result = await runCodex({
    cwd: workspacePath,
    prompt: buildPlanPrompt(assignment.task, isGitRepository),
    threadId: assignment.task.executionMode === "resume_thread" ? assignment.task.resumeThreadId : undefined,
    mode: "plan",
    skipGitRepoCheck: !isGitRepository,
    materializedFromHistory: assignment.task.executionMode === "resume_thread",
    codexHome: config.codexHome,
    timeoutMs: config.codexRunTimeoutMs,
    signal,
    onEvent: createLocalCodexEventHandler(assignment, workspacePath)
  });

  const completion: RunnerCompletionPayload = {
    outcome: "plan_ready",
    planSummary: result.finalMessage,
    session: {
      executorType: "codex_cli",
      threadId: result.threadId,
      cwd: workspacePath,
      materializedFromHistory: assignment.task.executionMode === "resume_thread",
      lastTurnAt: now()
    }
  };
  const codexOutputPath = await taskHistory.recordCodexTurnOutput(assignment.taskId, "planning-turn", result.stdoutLines);
  const derivedSnapshot = {
    ...deriveSnapshotAfterCompletion(assignment.task, assignment.runnerId, completion),
    executionBranch: executionBranch ?? assignment.task.executionBranch
  };
  await taskHistory.recordCompletion(
    assignment.taskId,
    completion,
    derivedSnapshot,
    codexOutputPath
  );

  throwIfTaskStopRequested(signal);
  const published = await maybePublishReport(assignment, derivedSnapshot, signal);
  const reportedCompletion: RunnerCompletionPayload = {
    ...completion,
    reportURL: published.reportURL,
    lastPublishedAt: published.lastPublishedAt
  };

  await client.complete(assignment.runnerId, assignment.taskId, withAssignmentIdentity(assignment, reportedCompletion));
  await syncLatestSnapshot(assignment.taskId);
}

function createLocalCodexEventHandler(
  assignment: RunnerAssignment,
  workspacePath: string
): (event: CodexRunEvent) => Promise<void> {
  const materializedFromHistory = assignment.task.executionMode === "resume_thread";
  let linkedThreadId = assignment.task.executorSession?.threadId;
  let lastProgressMessage = "";

  return async (event: CodexRunEvent) => {
    if (event.threadId && event.threadId !== linkedThreadId) {
      linkedThreadId = event.threadId;
      await taskHistory.recordRunnerLog(assignment.taskId, {
        kind: "codex.session_attached",
        title: "Codex session attached",
        detail: `Streaming live Codex session ${event.threadId} from ${workspacePath}.`,
        summary: "Mac is streaming the live Codex session locally.",
        session: {
          executorType: "codex_cli",
          threadId: event.threadId,
          cwd: workspacePath,
          materializedFromHistory,
          lastTurnAt: now()
        }
      });
    }

    const message = event.message?.trim();
    if (!message || message === lastProgressMessage) {
      return;
    }

    lastProgressMessage = message;
    await taskHistory.recordCodexProgress(assignment.taskId, message);
  };
}

async function runPlanAssignment(assignment: RunnerAssignment, signal?: AbortSignal): Promise<void> {
  throwIfTaskStopRequested(signal);
  await sendRunnerLog(assignment.runnerId, assignment.taskId, withAssignmentIdentity(assignment, {
    kind: "workspace.preparing",
    title: "Repository preparing",
    detail: assignment.task.branchMode === "current_branch"
      ? "Resolving the source repository and preparing the real repo on its current checked-out branch."
      : "Resolving the source repository and switching the real repo to this task branch."
  }));

  const inspection = await repositories.inspectWorkspace(assignment.task.repo, signal);
  throwIfTaskStopRequested(signal);
  if (inspection.hasUncommittedChanges) {
    await completeDirtyWorkspaceDetected(assignment, inspection, signal);
    return;
  }

  const prepared = await repositories.prepareWorkspace(assignment.task.id, assignment.task.repo, assignment.task.baseBranch, {
    preferredBranchName: assignment.task.branchName,
    useCurrentBranch: shouldUseCurrentBranch(assignment.task),
    signal
  });
  await taskHistory.recordExecutionMapping(assignment.taskId, {
    workspacePath: prepared.workspacePath,
    executionBranch: prepared.branchName
  });

  await sendRunnerLog(assignment.runnerId, assignment.taskId, withAssignmentIdentity(assignment, {
    kind: "workspace.ready",
    title: "Repository ready",
    detail: describePreparedWorkspace(prepared),
    branchName: prepared.branchName,
    executionBranch: prepared.branchName,
    reviewPlatform: prepared.reviewPlatform,
    reviewTargetBranches: prepared.reviewTargetBranches,
    summary: "Repository ready. Starting the Codex planning turn."
  }));

  await completePlanningTurn(assignment, prepared.workspacePath, prepared.isGitRepository, prepared.branchName, signal);
}

async function runDirtyWorkspaceResolutionAssignment(
  assignment: RunnerAssignment,
  decision: DirtyWorkspaceDecision,
  signal?: AbortSignal
): Promise<void> {
  throwIfTaskStopRequested(signal);
  const inspection = await repositories.inspectWorkspace(assignment.task.repo, signal);
  throwIfTaskStopRequested(signal);

  if (!inspection.hasUncommittedChanges && decision !== "clear_and_continue") {
    const prepared = await repositories.prepareWorkspace(assignment.task.id, inspection.sourceRepoPath, assignment.task.baseBranch, {
      preferredBranchName: assignment.task.branchName,
      useCurrentBranch: shouldUseCurrentBranch(assignment.task),
      resumeExistingBranch: Boolean(assignment.task.executorSession?.cwd),
      signal
    });
    await taskHistory.recordExecutionMapping(assignment.taskId, {
      workspacePath: prepared.workspacePath,
      executionBranch: prepared.branchName
    });
    await sendRunnerLog(assignment.runnerId, assignment.taskId, withAssignmentIdentity(assignment, {
      kind: "workspace.ready",
      title: "Repository ready",
      detail: describePreparedWorkspace(prepared),
      branchName: assignment.task.branchName ?? prepared.branchName,
      executionBranch: prepared.branchName,
      reviewPlatform: prepared.reviewPlatform,
      reviewTargetBranches: prepared.reviewTargetBranches,
      summary: "Repository ready. Starting the Codex planning turn."
    }));
    await completePlanningTurn(assignment, prepared.workspacePath, prepared.isGitRepository, prepared.branchName, signal);
    return;
  }

  if (decision === "clear_and_continue") {
    await sendRunnerLog(assignment.runnerId, assignment.taskId, withAssignmentIdentity(assignment, {
      kind: "workspace.clearing",
      title: "Clearing repository state",
      detail: `Discarding local changes in ${inspection.sourceRepoPath} before creating the task branch.`,
      summary: "Clearing local changes before starting a fresh planning turn."
    }));

    await repositories.discardAllChanges(inspection.sourceRepoPath, signal);
    const prepared = await repositories.prepareWorkspace(assignment.task.id, inspection.sourceRepoPath, assignment.task.baseBranch, {
      preferredBranchName: assignment.task.branchName,
      useCurrentBranch: shouldUseCurrentBranch(assignment.task),
      signal
    });
    await taskHistory.recordExecutionMapping(assignment.taskId, {
      workspacePath: prepared.workspacePath,
      executionBranch: prepared.branchName
    });
    await sendRunnerLog(assignment.runnerId, assignment.taskId, withAssignmentIdentity(assignment, {
      kind: "workspace.ready",
      title: "Repository ready",
      detail: prepared.isGitRepository
        ? `Cleared local changes and prepared ${prepared.workspacePath} on branch ${prepared.branchName || "(detached HEAD)"}.`
        : `Cleared local files as requested and continued in ${prepared.workspacePath}. Git has not been initialized there yet.`,
      branchName: prepared.branchName,
      executionBranch: prepared.branchName,
      reviewPlatform: prepared.reviewPlatform,
      reviewTargetBranches: prepared.reviewTargetBranches,
      summary: "Repository ready. Starting the Codex planning turn."
    }));
    await completePlanningTurn(assignment, prepared.workspacePath, prepared.isGitRepository, prepared.branchName, signal);
    return;
  }

  const executionBranch = inspection.currentBranch ?? assignment.task.executionBranch;
  await taskHistory.recordExecutionMapping(assignment.taskId, {
    workspacePath: inspection.sourceRepoPath,
    executionBranch
  });
  await sendRunnerLog(assignment.runnerId, assignment.taskId, withAssignmentIdentity(assignment, {
    kind: decision === "plan_only" ? "workspace.plan_only_ready" : "workspace.current_workspace_ready",
    title: decision === "plan_only" ? "Current workspace plan only" : "Current workspace selected",
    detail: decision === "plan_only"
      ? `Planning against ${inspection.sourceRepoPath} on ${executionBranch || "(detached HEAD)"} without editing files.`
      : `Planning against the current dirty workspace at ${inspection.sourceRepoPath} on ${executionBranch || "(detached HEAD)"}.`,
    branchName: assignment.task.branchName ?? executionBranch,
    executionBranch,
    reviewPlatform: inspection.reviewPlatform,
    reviewTargetBranches: inspection.reviewTargetBranches,
    summary: decision === "plan_only"
      ? "Generating a read-only plan from the current workspace state."
      : "Starting the planning turn against the current workspace state."
  }));
  await completePlanningTurn(assignment, inspection.sourceRepoPath, inspection.isGitRepository, executionBranch, signal);
}

async function runWorkspaceInspectionAssignment(assignment: RunnerAssignment, signal?: AbortSignal): Promise<void> {
  throwIfTaskStopRequested(signal);
  await sendRunnerLog(assignment.runnerId, assignment.taskId, withAssignmentIdentity(assignment, {
    kind: "workspace.inspecting",
    title: "Workspace inspection started",
    detail: "Checking the current repository state for local changes.",
    summary: "Inspecting the current repository state."
  }));

  const inspection = await repositories.inspectWorkspace(assignment.task.repo, signal);
  throwIfTaskStopRequested(signal);
  if (inspection.hasUncommittedChanges) {
    await completeDirtyWorkspaceDetected(assignment, inspection, signal);
    return;
  }

  const cleanSummary = "Workspace is clean. No dirty workspace action is required.";
  const executionBranch = inspection.currentBranch ?? assignment.task.executionBranch;

  await taskHistory.recordExecutionMapping(assignment.taskId, {
    workspacePath: inspection.sourceRepoPath,
    executionBranch
  });
  await sendRunnerLog(assignment.runnerId, assignment.taskId, withAssignmentIdentity(assignment, {
    kind: "workspace.clean",
    title: "Workspace clean",
    detail: describeCleanWorkspaceInspection(inspection),
    executionBranch,
    reviewPlatform: inspection.reviewPlatform,
    reviewTargetBranches: inspection.reviewTargetBranches,
    summary: cleanSummary
  }));

  const completion: RunnerCompletionPayload = {
    outcome: "workspace_inspected_clean",
    summary: cleanSummary,
    currentBranch: inspection.currentBranch,
    statusSummary: inspection.statusSummary,
    reviewPlatform: inspection.reviewPlatform,
    reviewTargetBranches: inspection.reviewTargetBranches
  };
  await taskHistory.recordCompletion(
    assignment.taskId,
    completion,
    deriveSnapshotAfterCompletion(assignment.task, assignment.runnerId, completion)
  );
  await client.complete(assignment.runnerId, assignment.taskId, withAssignmentIdentity(assignment, completion));
  await syncLatestSnapshot(assignment.taskId);
}

async function runImplementationAssignment(assignment: RunnerAssignment, signal?: AbortSignal): Promise<void> {
  throwIfTaskStopRequested(signal);
  const workspace = await ensureWorkspace(assignment.task, signal);
  await taskHistory.recordExecutionMapping(assignment.taskId, {
    workspacePath: workspace.workspacePath,
    executionBranch: workspace.branchName
  });
  const turn = prepareImplementationTurn(assignment.task, assignment.prompt ?? assignment.task.prompt, {
    isGitRepository: workspace.isGitRepository
  });
  const allowedProtectedGitKinds = new Set<ProtectedGitCommandKind>(assignment.allowedProtectedGitCommandKinds ?? []);
  if (assignment.protectedGitCommand) {
    allowedProtectedGitKinds.add(assignment.protectedGitCommand.kind);
  }

  await sendRunnerLog(assignment.runnerId, assignment.taskId, withAssignmentIdentity(assignment, {
    kind: "codex.turn_started",
    title: "Codex turn started",
    detail: turn.startsFreshThread
      ? "Starting a fresh writable Codex session from the approved plan in the real project repository."
      : "Resuming the existing writable Codex session in the real project repository.",
    branchName: workspace.branchName,
    executionBranch: workspace.branchName,
    reviewPlatform: workspace.reviewPlatform,
    reviewTargetBranches: workspace.reviewTargetBranches,
    status: "running",
    summary: "Codex is executing the approved turn in the project repository on the Mac."
  }));

  if (assignment.protectedGitCommand) {
    await sendRunnerLog(assignment.runnerId, assignment.taskId, withAssignmentIdentity(assignment, {
      kind: "git.protected_command_executing",
      title: "Executing approved destructive Git command",
      detail: `Runner is executing approved command: git ${assignment.protectedGitCommand.args.join(" ")}.`,
      summary: "Executing the approved destructive Git command before resuming Codex."
    }));
    await repositories.executeProtectedGitCommand(workspace.workspacePath, assignment.protectedGitCommand, signal);
  }

  const implementationGitStateBeforeTurn = assignment.task.deliveryMode === "direct_commit"
    ? await repositories.inspectWorkspaceGitState(workspace.workspacePath, signal)
    : undefined;

  const gitGuard = await createGitGuardEnvironment({
    allowedKinds: Array.from(allowedProtectedGitKinds)
  });

  try {
    const result = await runCodex({
      cwd: workspace.workspacePath,
      prompt: turn.prompt,
      threadId: turn.threadId,
      mode: "implement",
      skipGitRepoCheck: !workspace.isGitRepository,
      materializedFromHistory: assignment.task.executionMode === "resume_thread",
      codexHome: config.codexHome,
      extraEnv: gitGuard.extraEnv,
      timeoutMs: config.codexRunTimeoutMs,
      signal,
      onEvent: createLocalCodexEventHandler(assignment, workspace.workspacePath)
    });

    const blockedProtectedGitCommand = await readBlockedProtectedGitCommand(gitGuard.requestPath);
    if (blockedProtectedGitCommand) {
      const codexOutputPath = await taskHistory.recordCodexTurnOutput(assignment.taskId, "implementation-turn", result.stdoutLines);
      const completion: RunnerCompletionPayload = {
        outcome: "protected_git_command_blocked",
        summary: `Codex requested git ${blockedProtectedGitCommand.args.join(" ")}. Waiting for approval before the runner can continue.`,
        protectedGitCommand: blockedProtectedGitCommand,
        session: {
          executorType: "codex_cli",
          threadId: result.threadId,
          cwd: workspace.workspacePath,
          materializedFromHistory: assignment.task.executionMode === "resume_thread",
          lastTurnAt: now()
        }
      };
      const derivedSnapshot = deriveSnapshotAfterCompletion(assignment.task, assignment.runnerId, completion);
      await taskHistory.recordCompletion(assignment.taskId, completion, derivedSnapshot, codexOutputPath);
      await client.complete(assignment.runnerId, assignment.taskId, withAssignmentIdentity(assignment, completion));
      await syncLatestSnapshot(assignment.taskId);
      return;
    }

    const implementationGitStateAfterTurn = assignment.task.deliveryMode === "direct_commit"
      ? await repositories.inspectWorkspaceGitState(workspace.workspacePath, signal)
      : undefined;
    const baseCompletion: RunnerCompletionPayload = {
      outcome: "turn_complete",
      summary: result.finalMessage,
      ...(assignment.task.deliveryMode === "direct_commit"
        ? {
            implementationCommitCreated: didImplementationCreateLocalCommit(
              implementationGitStateBeforeTurn,
              implementationGitStateAfterTurn
            ),
            workspaceIsGitRepository: workspace.isGitRepository
          }
        : {}),
      session: {
        executorType: "codex_cli",
        threadId: result.threadId,
        cwd: workspace.workspacePath,
        materializedFromHistory: assignment.task.executionMode === "resume_thread",
        lastTurnAt: now()
      }
    };

    const codexOutputPath = await taskHistory.recordCodexTurnOutput(assignment.taskId, "implementation-turn", result.stdoutLines);

    throwIfTaskStopRequested(signal);
    let latestResultSummary = baseCompletion.summary;
    try {
      const autoPushDecision = workspace.isGitRepository
        ? await attemptAutoPush(assignment.task, workspace.workspacePath, repositories, signal)
        : { outcome: "disabled" as const };
      if (autoPushDecision.outcome === "pushed") {
        await sendRunnerLog(assignment.runnerId, assignment.taskId, withAssignmentIdentity(assignment, {
          kind: "git.auto_push_completed",
          title: "Auto-push completed",
          detail: autoPushDecision.detail,
          summary: autoPushDecision.detail
        }));
        latestResultSummary = buildLatestResultSummary(baseCompletion.summary, autoPushDecision) ?? baseCompletion.summary;
      } else if (autoPushDecision.outcome === "skipped") {
        await sendRunnerLog(assignment.runnerId, assignment.taskId, withAssignmentIdentity(assignment, {
          kind: "git.auto_push_skipped",
          title: "Auto-push skipped",
          detail: autoPushDecision.detail,
          summary: autoPushDecision.detail
        }));
        latestResultSummary = buildLatestResultSummary(baseCompletion.summary, autoPushDecision) ?? baseCompletion.summary;
      }
    } catch (error) {
      if (isTaskCanceledError(error)) {
        throw error;
      }

      const message = error instanceof Error ? error.message : "Unknown auto-push failure";
      const detail = `Auto-push failed after the implementation turn: ${message}`;
      await sendRunnerLog(assignment.runnerId, assignment.taskId, withAssignmentIdentity(assignment, {
        kind: "git.auto_push_failed",
        title: "Auto-push failed",
        detail,
        summary: detail
      }));
      latestResultSummary = `${baseCompletion.summary}\n\n${detail}`;
    }

    const completionWithLatestResult: RunnerCompletionPayload = {
      ...baseCompletion,
      latestResultSummary
    };
    const derivedSnapshot = deriveSnapshotAfterCompletion(assignment.task, assignment.runnerId, completionWithLatestResult);
    await taskHistory.recordCompletion(assignment.taskId, completionWithLatestResult, derivedSnapshot, codexOutputPath);

    const published = await maybePublishReport(assignment, derivedSnapshot, signal);
    const completion: RunnerCompletionPayload = {
      ...completionWithLatestResult,
      ...published
    };

    await client.complete(assignment.runnerId, assignment.taskId, withAssignmentIdentity(assignment, completion));
    await syncLatestSnapshot(assignment.taskId);
  } catch (error) {
    const blockedProtectedGitCommand = await readBlockedProtectedGitCommand(gitGuard.requestPath);
    if (!blockedProtectedGitCommand) {
      throw error;
    }

    const codexOutputPath = error instanceof CodexRunFailedError
      ? await taskHistory.recordCodexTurnOutput(assignment.taskId, "implementation-turn", error.stdoutLines)
      : undefined;
    const completion: RunnerCompletionPayload = {
      outcome: "protected_git_command_blocked",
      summary: `Codex requested git ${blockedProtectedGitCommand.args.join(" ")}. Waiting for approval before the runner can continue.`,
      protectedGitCommand: blockedProtectedGitCommand,
      session: error instanceof CodexRunFailedError && error.threadId
        ? {
            executorType: "codex_cli",
            threadId: error.threadId,
            cwd: workspace.workspacePath,
            materializedFromHistory: assignment.task.executionMode === "resume_thread",
            lastTurnAt: now()
          }
        : undefined
    };
    const derivedSnapshot = deriveSnapshotAfterCompletion(assignment.task, assignment.runnerId, completion);
    await taskHistory.recordCompletion(assignment.taskId, completion, derivedSnapshot, codexOutputPath);
    await client.complete(assignment.runnerId, assignment.taskId, withAssignmentIdentity(assignment, completion));
    await syncLatestSnapshot(assignment.taskId);
  } finally {
    await gitGuard.cleanup();
  }
}

function openCodexApp(workspacePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("codex", ["app", workspacePath], {
      detached: true,
      stdio: "ignore"
    });

    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

async function runOpenInAppAssignment(assignment: RunnerAssignment, signal?: AbortSignal): Promise<void> {
  throwIfTaskStopRequested(signal);
  const workspace = await ensureWorkspace(assignment.task, signal);
  await taskHistory.recordExecutionMapping(assignment.taskId, {
    workspacePath: workspace.workspacePath,
    executionBranch: workspace.branchName
  });
  await openCodexApp(workspace.workspacePath);

  const threadSuffix = assignment.task.executorSession?.threadId
    ? ` Existing Codex thread: ${assignment.task.executorSession.threadId}.`
    : "";

  const completion: RunnerCompletionPayload = {
    outcome: "handoff_completed",
    summary: `Opened Codex App for ${workspace.workspacePath}.${threadSuffix}`.trim()
  };
  await taskHistory.recordCompletion(
    assignment.taskId,
    completion,
    deriveSnapshotAfterCompletion(assignment.task, assignment.runnerId, completion)
  );
  await client.complete(assignment.runnerId, assignment.taskId, withAssignmentIdentity(assignment, completion));
  await syncLatestSnapshot(assignment.taskId);
}

async function runGitAssignment(assignment: RunnerAssignment, action: GitAction, signal?: AbortSignal): Promise<void> {
  throwIfTaskStopRequested(signal);
  const cwd = assignment.task.executorSession?.cwd;
  if (!cwd) {
    throw new Error("The task does not have an active worktree for Git operations");
  }

  await fs.access(cwd);
  throwIfTaskStopRequested(signal);
  const expectedBranch = resolveExpectedTaskBranch(assignment.task);
  const activeBranch = action === "create_pr"
    ? await repositories.ensureReviewReadyBranch(cwd, expectedBranch, signal)
    : await repositories.ensureActiveBranch(cwd, expectedBranch, signal);

  let summary = "";
  switch (action) {
    case "commit": {
      const message = assignment.commitMessage?.trim() || "chore: apply remote agent workflow changes";
      await repositories.commitAll(cwd, message, signal);
      summary = `Commit created on ${activeBranch} with message: ${message}`;
      break;
    }
    case "rebase":
      await repositories.rebaseOntoBase(cwd, assignment.task.baseBranch, signal);
      summary = `Rebased branch ${activeBranch} onto ${assignment.task.baseBranch}.`;
      break;
    case "push": {
      const branch = await repositories.pushCurrentBranch(cwd, signal);
      summary = `Pushed branch ${branch} to origin.`;
      break;
    }
    case "create_pr": {
      const targetBranch = assignment.targetBranch?.trim() || assignment.task.baseBranch;
      let createdCommit = false;
      if (assignment.reviewMode === "commit_and_review") {
        const commitMessage = assignment.commitMessage?.trim() || "chore: prepare review request";
        try {
          await repositories.commitAll(cwd, commitMessage, signal);
          createdCommit = true;
        } catch (error) {
          if (!(error instanceof Error) || error.message !== "No staged changes are available to commit") {
            throw error;
          }
        }
      }
      throwIfTaskStopRequested(signal);
      const review = await repositories.createReviewRequest(
        cwd,
        targetBranch,
        assignment.prTitle?.trim() || assignment.task.title,
        `Created by RemoteAgentWorkbench for task ${assignment.task.id}.`,
        signal
      );
      summary = assignment.reviewMode === "commit_and_review"
        ? createdCommit
          ? `Committed current changes and created a draft ${review.platform === "gitlab" ? "merge request" : "pull request"} into ${targetBranch}: ${review.url}`
          : `No new local changes needed a commit. Created a draft ${review.platform === "gitlab" ? "merge request" : "pull request"} into ${targetBranch}: ${review.url}`
        : `Draft ${review.platform === "gitlab" ? "merge request" : "pull request"} into ${targetBranch} created: ${review.url}`;
      break;
    }
  }

  const baseCompletion: RunnerCompletionPayload = {
    outcome: "git_completed",
    action,
    summary
  };
  const derivedSnapshot = deriveSnapshotAfterCompletion(assignment.task, assignment.runnerId, baseCompletion);
  await taskHistory.recordCompletion(assignment.taskId, baseCompletion, derivedSnapshot);

  throwIfTaskStopRequested(signal);
  const published = await maybePublishReport(assignment, derivedSnapshot, signal);
  const completion: RunnerCompletionPayload = {
    ...baseCompletion,
    ...published
  };

  await client.complete(assignment.runnerId, assignment.taskId, withAssignmentIdentity(assignment, completion));
  await syncLatestSnapshot(assignment.taskId);
}

async function runUtilityAssignment(assignment: UtilityRunnerAssignment): Promise<void> {
  switch (assignment.kind) {
    case "create_directory": {
      const targetPath = path.resolve(assignment.absolutePath);
      const existed = await fs.access(targetPath)
        .then(() => true)
        .catch(() => false);

      await fs.mkdir(targetPath, { recursive: true });
      let projectMessage = "";
      if (assignment.createProject !== false) {
        const project = await projectCatalog.upsertDirectoryProject({
          absolutePath: targetPath,
          name: assignment.projectName,
          baseBranch: assignment.projectBaseBranch,
          deliveryMode: assignment.projectDeliveryMode,
          autoPush: assignment.projectAutoPush,
          defaultTaskTitle: assignment.projectDefaultTaskTitle,
          defaultPrompt: assignment.projectDefaultPrompt
        });
        await projectCatalog.syncIfChanged(client, assignment.runnerId, { force: true });
        projectMessage = ` Added ${project.name} to Projects.`;
      }
      await client.completeUtility(assignment.runnerId, assignment.id, {
        claimToken: assignment.claimToken,
        outcome: "completed",
        absolutePath: targetPath,
        message: `${existed ? `Directory already existed at ${targetPath}.` : `Created directory at ${targetPath}.`}${projectMessage}`
      });
      return;
    }
    case "switch_codex_profile": {
      const profileName = assignment.profileName?.trim() || assignment.label.trim();
      const result = await switchCodexProfile(
        config.codexProfilesRoot,
        config.codex.liveDirectory,
        profileName
      );
      await restartCodexApp({
        timeoutMs: config.codex.restartTimeoutMs,
        pollIntervalMs: config.codex.restartPollIntervalMs
      });
      await client.completeUtility(assignment.runnerId, assignment.id, {
        claimToken: assignment.claimToken,
        outcome: "completed",
        absolutePath: result.profileDirectory,
        message: `Activated Codex config ${result.profileName} and restarted Codex.`,
        codexConfigProfiles: result.snapshot.profiles,
        activeCodexConfigProfile: result.snapshot.activeProfileName
      });
      return;
    }
    case "create_codex_profile": {
      const profileName = assignment.profileName?.trim() || assignment.label.trim();
      const baseURL = assignment.baseURL?.trim();
      const apiKey = assignment.apiKey?.trim();
      if (!baseURL || !apiKey) {
        throw new Error(`Codex config creation payload is incomplete for ${profileName}`);
      }

      const result = await createCodexProfile({
        profilesRoot: config.codexProfilesRoot,
        liveCodexDirectory: config.codex.liveDirectory,
        templateProfileName: config.codexProfileTemplate,
        profileName,
        baseURL,
        apiKey
      });
      await restartCodexApp({
        timeoutMs: config.codex.restartTimeoutMs,
        pollIntervalMs: config.codex.restartPollIntervalMs
      });
      await client.completeUtility(assignment.runnerId, assignment.id, {
        claimToken: assignment.claimToken,
        outcome: "completed",
        absolutePath: result.profileDirectory,
        message: `Saved and activated Codex config ${result.profileName}, then restarted Codex.`,
        codexConfigProfiles: result.snapshot.profiles,
        activeCodexConfigProfile: result.snapshot.activeProfileName
      });
      return;
    }
    case "delete_codex_profile": {
      const profileName = assignment.profileName?.trim() || assignment.label.trim();
      const result = await deleteCodexProfile(
        config.codexProfilesRoot,
        config.codex.liveDirectory,
        profileName
      );
      await client.completeUtility(assignment.runnerId, assignment.id, {
        claimToken: assignment.claimToken,
        outcome: "completed",
        absolutePath: result.profileDirectory,
        message: `Deleted Codex config ${result.profileName}.`,
        codexConfigProfiles: result.snapshot.profiles,
        activeCodexConfigProfile: result.snapshot.activeProfileName
      });
      return;
    }
  }
}

async function handleAssignment(assignment: RunnerAssignment, signal?: AbortSignal): Promise<void> {
  switch (assignment.kind) {
    case "generate_plan":
      await runPlanAssignment(assignment, signal);
      return;
    case "resolve_dirty_workspace":
      await runDirtyWorkspaceResolutionAssignment(assignment, assignment.dirtyWorkspaceDecision ?? "continue_current_workspace", signal);
      return;
    case "inspect_workspace":
      await runWorkspaceInspectionAssignment(assignment, signal);
      return;
    case "continue_prompt":
      await runImplementationAssignment(assignment, signal);
      return;
    case "open_in_codex_app":
      await runOpenInAppAssignment(assignment, signal);
      return;
    default:
      await runGitAssignment(assignment, assignment.kind.replace("git.", "") as GitAction, signal);
  }
}

async function runAssignmentWithRepositoryIsolation(assignment: RunnerAssignment): Promise<void> {
  const repoRoot = await repositories.resolveExecutionRepo(assignment.task.repo);
  const abortController = new AbortController();
  const stopWatcher = startTaskStopWatcher(assignment, abortController);

  try {
    await lockManager.withLock(
      `repo:${repoRoot}`,
      `${assignment.taskId}:${assignment.kind}`,
      async () => {
        throwIfTaskStopRequested(abortController.signal);
        await handleAssignment(assignment, abortController.signal);
      },
      { timeoutMs: 300_000, pollIntervalMs: 750 }
    );
  } finally {
    stopWatcher();
  }
}

async function registerRunner(versions: Awaited<ReturnType<typeof detectVersions>>, capabilities: string[]): Promise<void> {
  const codexConfigState = await collectCodexConfigState();
  await client.hello({
    id: config.runnerId,
    name: config.runnerName,
    platform: config.runnerPlatform,
    labels: config.runnerLabels,
    capabilities,
    version: versions.runnerVersion,
    hostname: versions.hostname,
    ...codexConfigState
  });

  await projectCatalog.syncIfChanged(client, config.runnerId, { force: true });
  await directoryCatalog.syncIfChanged(client, config.runnerId, { force: true });

  console.log(`[runner] registered ${config.runnerId} -> ${config.serverBaseURL}`);
  console.log(`[runner] data root ${config.dataRoot}`);
  if (versions.codexVersion) {
    console.log(`[runner] ${versions.codexVersion}`);
  }
  if (versions.xcodeVersion) {
    console.log(`[runner] ${versions.xcodeVersion}`);
  }
}

async function maybeRecoverMissingRunner(
  error: unknown,
  versions: Awaited<ReturnType<typeof detectVersions>>,
  capabilities: string[]
): Promise<boolean> {
  terminateIfRunnerInstanceWasSuperseded(error);
  const message = error instanceof Error ? error.message : "";
  if (!message.includes("Control plane request failed (404)")) {
    return false;
  }

  try {
    await registerRunner(versions, capabilities);
    return true;
  } catch (registerError) {
    console.error("[runner] re-register failed", registerError);
    return false;
  }
}

async function start(): Promise<void> {
  const lockKey = `runner-instance:${config.runnerId}`;
  const lockOwner = `runner:${config.runnerId}:pid:${process.pid}`;

  await lockManager.withLock(
    lockKey,
    lockOwner,
    async () => {
      console.log(`[runner] single-instance lock acquired for ${config.runnerId} (pid ${process.pid})`);

      await repositories.ensureDirectories();
      await fs.mkdir(path.dirname(runnerJournalPath), { recursive: true });
      await fs.mkdir(config.tasksDir, { recursive: true });
      await cleanupLocalTaskHistory();
      await projectCatalog.ensureSeeded();
      await directoryCatalog.ensureSeeded();
      const recoveredLocks = await lockManager.cleanupStaleLocks();
      if (recoveredLocks.length > 0) {
        console.log(`[runner] recovered ${recoveredLocks.length} stale lock(s) from ${config.lockRootDir}`);
      }

      const versions = await detectVersions();
      let capabilities = await detectCapabilities();
      let currentAssignment:
        | {
            taskId: string;
            commandId: string;
            commandKind: string;
            startedAt: string;
          }
        | undefined;

      await registerRunner(versions, capabilities);

      const heartbeat = async () => {
        try {
          const latestCapabilities = await detectCapabilities();
          if (!sameCapabilities(latestCapabilities, capabilities)) {
            capabilities = latestCapabilities;
            await registerRunner(versions, capabilities);
          }

          const codexConfigState = await collectCodexConfigState();
          await client.heartbeat(config.runnerId, {
            currentTaskId: currentAssignment?.taskId,
            currentCommandId: currentAssignment?.commandId,
            currentCommandKind: currentAssignment?.commandKind,
            currentCommandStartedAt: currentAssignment?.startedAt,
            version: versions.runnerVersion,
            hostname: versions.hostname,
            ...codexConfigState
          });
          await projectCatalog.syncIfChanged(client, config.runnerId);
          await directoryCatalog.syncIfChanged(client, config.runnerId);
          console.log(`[runner] heartbeat ok @ ${formatBeijingDateTime(new Date())}`);
        } catch (error) {
          console.error("[runner] heartbeat failed", error);
          await maybeRecoverMissingRunner(error, versions, capabilities);
        }
      };

      await heartbeat();
      setInterval(() => {
        void heartbeat();
      }, config.heartbeatIntervalMs);

      while (true) {
        try {
          const assignment = await client.claim(config.runnerId);
          if (!assignment) {
            const utilityAssignment = await client.claimUtility(config.runnerId);
            if (!utilityAssignment) {
              await delay(config.pollIntervalMs);
              continue;
            }

            console.log(`[runner] claimed utility ${utilityAssignment.kind} for ${utilityAssignment.absolutePath}`);
            await appendRunnerJournal({
              event: "utility_claimed",
              commandId: utilityAssignment.id,
              runnerId: utilityAssignment.runnerId,
              kind: utilityAssignment.kind,
              presetId: utilityAssignment.presetId,
              label: utilityAssignment.label,
              rootPath: utilityAssignment.rootPath,
              relativePath: utilityAssignment.relativePath,
              absolutePath: utilityAssignment.absolutePath
            });

            try {
              await runUtilityAssignment(utilityAssignment);
              console.log(`[runner] completed utility ${utilityAssignment.kind} for ${utilityAssignment.absolutePath}`);
              await appendRunnerJournal({
                event: "utility_completed",
                commandId: utilityAssignment.id,
                runnerId: utilityAssignment.runnerId,
                kind: utilityAssignment.kind,
                absolutePath: utilityAssignment.absolutePath
              });
              await heartbeat();
            } catch (error) {
              const message = error instanceof Error ? error.message : "Unknown utility error";
              console.error(`[runner] utility failed ${utilityAssignment.id}`, error);
              await appendRunnerJournal({
                event: "utility_failed",
                commandId: utilityAssignment.id,
                runnerId: utilityAssignment.runnerId,
                kind: utilityAssignment.kind,
                absolutePath: utilityAssignment.absolutePath,
                error: message
              });
              await client.completeUtility(utilityAssignment.runnerId, utilityAssignment.id, {
                claimToken: utilityAssignment.claimToken,
                outcome: "failed",
                absolutePath: utilityAssignment.absolutePath,
                message
              });
              await heartbeat();
            }

            continue;
          }

          currentAssignment = {
            taskId: assignment.taskId,
            commandId: assignment.id,
            commandKind: assignment.kind,
            startedAt: new Date().toISOString()
          };
          console.log(`[runner] claimed ${assignment.kind} for ${assignment.taskId}`);
          await appendRunnerJournal({
            event: "assignment_claimed",
            taskId: assignment.taskId,
            runnerId: assignment.runnerId,
            kind: assignment.kind,
            title: assignment.task.title,
            repo: assignment.task.repo,
            baseBranch: assignment.task.baseBranch,
            projectId: assignment.task.projectId,
            projectName: assignment.task.projectName,
            deliveryMode: assignment.task.deliveryMode,
            executionMode: assignment.task.executionMode,
            resumeThreadId: assignment.task.resumeThreadId,
            prompt: assignment.prompt ?? assignment.task.prompt,
            commitMessage: assignment.commitMessage,
            dirtyWorkspaceDecision: assignment.dirtyWorkspaceDecision,
            existingThreadId: assignment.task.executorSession?.threadId,
            existingWorkspace: assignment.task.executorSession?.cwd
          });
          await taskHistory.recordAssignmentClaimed(assignment);

          try {
            await runAssignmentWithRepositoryIsolation(assignment);
            console.log(`[runner] completed ${assignment.kind} for ${assignment.taskId}`);
            await appendRunnerJournal({
              event: "assignment_completed",
              taskId: assignment.taskId,
              runnerId: assignment.runnerId,
              kind: assignment.kind
            });
            await cleanupLocalTaskHistory();
          } catch (error) {
            const message = error instanceof Error ? error.message : "Unknown runner error";
            if (isTaskCanceledError(error)) {
              console.log(`[runner] assignment canceled ${assignment.taskId}`);
              await appendRunnerJournal({
                event: "assignment_canceled",
                taskId: assignment.taskId,
                runnerId: assignment.runnerId,
                kind: assignment.kind,
                error: message
              });

              const canceled: RunnerCompletionPayload = {
                outcome: "canceled",
                summary: "Task canceled from iPhone. Local execution stopped on the Mac runner.",
                detail: message
              };
              await taskHistory.recordCompletion(
                assignment.taskId,
                canceled,
                deriveSnapshotAfterCompletion(assignment.task, assignment.runnerId, canceled)
              );
              await client.complete(assignment.runnerId, assignment.taskId, withAssignmentIdentity(assignment, canceled));
              await syncLatestSnapshot(assignment.taskId);
              await cleanupLocalTaskHistory();
              continue;
            }

            terminateIfRunnerInstanceWasSuperseded(error);
            console.error(`[runner] assignment failed ${assignment.taskId}`, error);
            await appendRunnerJournal({
              event: "assignment_failed",
              taskId: assignment.taskId,
              runnerId: assignment.runnerId,
              kind: assignment.kind,
              error: message
            });
            await taskHistory.recordAssignmentFailed(assignment.taskId, message);

            const failure: RunnerCompletionPayload = {
              outcome: "failed",
              summary: `Runner failed while executing ${assignment.kind}.`,
              detail: message
            };
            await taskHistory.recordCompletion(
              assignment.taskId,
              failure,
              deriveSnapshotAfterCompletion(assignment.task, assignment.runnerId, failure)
            );
            await client.complete(assignment.runnerId, assignment.taskId, withAssignmentIdentity(assignment, failure));
            await syncLatestSnapshot(assignment.taskId);
            await cleanupLocalTaskHistory();
          } finally {
            currentAssignment = undefined;
          }
        } catch (error) {
          terminateIfRunnerInstanceWasSuperseded(error);
          console.error("[runner] polling failed", error);
          await maybeRecoverMissingRunner(error, versions, capabilities);
          await delay(config.pollIntervalMs);
        }
      }
    },
    {
      timeoutMs: Number.POSITIVE_INFINITY,
      pollIntervalMs: 1000
    }
  );
}

start().catch((error) => {
  console.error("[runner] fatal startup error", error);
  process.exit(1);
});
