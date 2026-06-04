import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { inferReviewPlatformFromRepoRef, resolveTaskBranchName } from "../domain/models.js";
import type {
  ApprovalRequest,
  Artifact,
  CodexConfigActionReceipt,
  CodexConfigState,
  DeliveryMode,
  DirectoryCreationReceipt,
  DirectoryPresetRecord,
  DirtyWorkspaceDecision,
  ExecutorSession,
  GitAction,
  ProjectRecord,
  ProjectSummary,
  ProtectedGitCommand,
  ProtectedGitCommandKind,
  ReviewMode,
  RunnerAssignment,
  RunnerCommandKind,
  RunnerCompletionInput,
  RunnerInfo,
  TaskBranchMode,
  RunnerLogInput,
  TaskEvent,
  TaskExecutionMode,
  TaskRecord,
  TaskSnapshot,
  TaskStatus,
  UtilityRunnerAssignment,
  WorkflowDefinition
} from "../domain/models.js";
import { config } from "../config.js";
import { SqliteStore, type PendingCommandRecord, type UtilityCommandRecord } from "./sqliteStore.js";

interface CreateTaskInput {
  workflowKey: "coding_session";
  deliveryMode: DeliveryMode;
  autoPush: boolean;
  title: string;
  prompt: string;
  repo: string;
  baseBranch: string;
  branchMode?: TaskBranchMode;
  branchName?: string;
  projectId?: string;
  projectName?: string;
  executionMode: TaskExecutionMode;
  resumeThreadId?: string;
  allowParallel?: boolean;
}

interface CreateProjectTaskInput {
  deliveryMode?: DeliveryMode;
  autoPush?: boolean;
  title: string;
  prompt: string;
  branchMode?: TaskBranchMode;
  branchName?: string;
  executionMode: TaskExecutionMode;
  resumeThreadId?: string;
  allowParallel?: boolean;
}

interface CreateDirectoryInput {
  presetId: string;
  relativePath: string;
  createProject?: boolean;
  projectName?: string;
  baseBranch?: string;
  deliveryMode?: DeliveryMode;
  autoPush?: boolean;
  defaultTaskTitle?: string;
  defaultPrompt?: string;
}

interface ListTasksOptions {
  projectId?: string;
  limit?: number;
  status?: TaskStatus;
  cursor?: string;
}

interface GetTaskOptions {
  includeArtifacts?: boolean;
  includeEvents?: boolean;
  artifactLimit?: number;
  eventLimit?: number;
}

interface TaskStreamPayload {
  event?: TaskEvent;
  snapshot: TaskSnapshot;
}

interface EnqueueCommandOptions {
  prompt?: string;
  commitMessage?: string;
  prTitle?: string;
  targetBranch?: string;
  reviewMode?: ReviewMode;
  dirtyWorkspaceDecision?: DirtyWorkspaceDecision;
  protectedGitCommand?: ProtectedGitCommand;
  allowedProtectedGitCommandKinds?: ProtectedGitCommandKind[];
}

interface UtilityCompletionInput {
  claimToken?: string;
  outcome: "completed" | "failed";
  message?: string;
  absolutePath?: string;
  codexConfigProfiles?: string[];
  activeCodexConfigProfile?: string;
}

const MAX_EVENTS_PER_TASK = 20;
const MAX_ARTIFACTS_PER_TASK = 3;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const PROTECTED_CODEX_PROFILE_NAMES = new Set(["1000", "plus"]);

const workflows: WorkflowDefinition[] = [
  {
    key: "coding_session",
    displayName: "Coding Session",
    description: "手机发起任务，Mac Runner 会准备 worktree，并通过 Codex CLI 执行计划、改码与 Git 审批流。",
    availableActions: ["continue", "open_in_codex_app", "inspect_workspace", "commit", "rebase", "push", "create_pr"]
  }
];

function now(): string {
  return new Date().toISOString();
}

function shortId(): string {
  return randomUUID().split("-")[0];
}

function gitActionFromKind(kind: RunnerCommandKind): GitAction | undefined {
  if (kind.startsWith("git.")) {
    return kind.replace("git.", "") as GitAction;
  }
  return undefined;
}

function protectedGitApprovalType(kind: ProtectedGitCommandKind): `protected_git.${ProtectedGitCommandKind}` {
  return `protected_git.${kind}`;
}

function protectedGitKindFromApprovalType(type: ApprovalRequest["type"]): ProtectedGitCommandKind | undefined {
  if (!type.startsWith("protected_git.")) {
    return undefined;
  }
  return type.replace("protected_git.", "") as ProtectedGitCommandKind;
}

function protectedGitCommandTitle(kind: ProtectedGitCommandKind): string {
  return kind === "reset_hard" ? "Approve git reset --hard" : "Approve git clean -fd";
}

function protectedGitCommandSummary(command: ProtectedGitCommand): string {
  return `git ${command.args.join(" ")}`;
}

function summarizeFailure(detail: string | undefined, fallback: string): string {
  const candidates = (detail ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const preferred =
    candidates.find((line) => /^(fatal:|error:)/i.test(line)) ??
    candidates.find((line) => !/^command failed:/i.test(line)) ??
    candidates[0];

  if (!preferred) {
    return fallback;
  }

  return preferred.length > 180 ? `${preferred.slice(0, 177)}...` : preferred;
}

function approvedPlanExecutionPrompt(deliveryMode: DeliveryMode): string {
  if (deliveryMode === "direct_commit") {
    return [
      "Implement the plan you just prepared.",
      "Make the requested changes and run the relevant checks.",
      "If this workspace is a Git repository and the work is ready after checks pass, finish with a local `git add -A` and `git commit`.",
      "If this is a plain local folder without Git, do not run Git; save the files, run the checks you can, and summarize the completed work.",
      "Do not push or create a PR/MR unless the user explicitly requests that."
    ].join(" ");
  }

  return "Implement the approved plan. Make the requested changes, run the relevant checks, and summarize the result without committing or pushing.";
}

function requiresExplicitPlanApproval(deliveryMode: DeliveryMode): boolean {
  return deliveryMode !== "direct_commit";
}

function summarizeTurnCompletion(
  task: Pick<TaskRecord, "deliveryMode">,
  input: Extract<RunnerCompletionInput, { outcome: "turn_complete" }>
): string {
  if (task.deliveryMode === "direct_commit" && input.workspaceIsGitRepository === false) {
    return "Implementation turn finished in a plain local folder. This direct-submit task is now completed without Git.";
  }

  if (task.deliveryMode === "direct_commit" && input.implementationCommitCreated) {
    return "Implementation turn finished with a local commit. This direct-commit task is now completed.";
  }

  if (task.deliveryMode === "direct_commit") {
    return "Implementation turn finished without a local commit, so the task is waiting for your next instruction.";
  }

  return "Implementation turn finished. This task is now completed, and push or review delivery remains optional.";
}

function resolveTurnCompletionStatus(
  task: Pick<TaskRecord, "deliveryMode">,
  input: Extract<RunnerCompletionInput, { outcome: "turn_complete" }>
): TaskStatus {
  if (task.deliveryMode === "direct_commit" && (input.implementationCommitCreated || input.workspaceIsGitRepository === false)) {
    return "completed";
  }

  return task.deliveryMode === "review_required" ? "completed" : "awaiting_human_input";
}

function summarizeGitCompletion(
  task: Pick<TaskRecord, "deliveryMode">,
  input: Extract<RunnerCompletionInput, { outcome: "git_completed" }>
): string {
  if (input.action === "commit" && task.deliveryMode === "direct_commit") {
    return "Local commit created. This direct-commit task is now completed.";
  }

  return input.summary;
}

function summarizeManualTaskCompletion(task: Pick<TaskRecord, "deliveryMode">): string {
  if (task.deliveryMode === "direct_commit") {
    return "Task marked completed from iPhone without creating a local commit. Repository state was not changed.";
  }

  return "Task marked completed from iPhone. Push or create review later if you want a delivery step from this same task.";
}

function resolveGitCompletionStatus(
  task: Pick<TaskRecord, "deliveryMode">,
  input: Extract<RunnerCompletionInput, { outcome: "git_completed" }>
): TaskStatus {
  if (input.action === "push" || input.action === "create_pr") {
    return "completed";
  }

  if (input.action === "commit" && task.deliveryMode === "direct_commit") {
    return "completed";
  }

  return "awaiting_human_input";
}

const terminalTaskStatuses = new Set<TaskStatus>(["completed", "failed", "canceled"]);

function isTerminalTaskStatus(status: TaskStatus): boolean {
  return terminalTaskStatuses.has(status);
}

function normalizeRepoIdentity(repo: string): string {
  const trimmed = repo.trim();
  if (!trimmed) {
    return "";
  }

  if (trimmed.startsWith("/") || trimmed.startsWith("~/") || /^[A-Za-z]:[\\/]/.test(trimmed)) {
    const normalized = path.normalize(trimmed).replace(/[\\/]+$/, "");
    return normalized || path.sep;
  }

  return trimmed
    .replace(/\.git$/i, "")
    .replace(/\/+$/g, "")
    .toLowerCase();
}

function normalizeRelativeDirectoryPath(input: string): string {
  const normalized = input
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join("/");

  if (!normalized) {
    throw new Error("relativePath must not be empty");
  }

  if (normalized.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new Error("relativePath must stay inside the selected directory preset");
  }

  return normalized;
}

function directoryPresetStorageId(runnerId: string, presetId: string): string {
  return `${runnerId}:${presetId}`;
}

function resolveDirectoryTarget(rootPath: string, relativePath: string): string {
  const normalizedRoot = path.resolve(rootPath);
  const target = path.resolve(normalizedRoot, relativePath);
  const relative = path.relative(normalizedRoot, target);

  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("relativePath must stay inside the selected directory preset");
  }

  return target;
}

const taskStatusPriority: Record<TaskStatus, number> = {
  awaiting_plan_approval: 0,
  awaiting_git_approval: 0,
  failed: 2,
  blocked_conflict: 3,
  awaiting_human_input: 4,
  running: 5,
  preparing_workspace: 6,
  queued: 7,
  draft: 8,
  completed: 9,
  canceled: 10
};

export class TaskService {
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly approvals = new Map<string, ApprovalRequest>();
  private readonly artifacts = new Map<string, Artifact[]>();
  private readonly events = new Map<string, TaskEvent[]>();
  private readonly sessions = new Map<string, ExecutorSession>();
  private readonly runners = new Map<string, RunnerInfo>();
  private readonly runnerInstances = new Map<string, string>();
  private readonly commands = new Map<string, PendingCommandRecord>();
  private readonly projects = new Map<string, ProjectRecord>();
  private readonly directoryPresets = new Map<string, DirectoryPresetRecord>();
  private readonly utilityCommands = new Map<string, UtilityCommandRecord>();
  private readonly bus = new EventEmitter();
  private readonly store: SqliteStore;
  private readonly retentionDays: number;
  private lastCleanupAt = 0;
  private recoveringStaleClaims = false;
  private recoveringStaleUtilityClaims = false;

  constructor(options?: { storagePath?: string; retentionDays?: number }) {
    this.store = new SqliteStore(options?.storagePath ?? config.database.path);
    this.retentionDays = options?.retentionDays ?? config.database.taskRetentionDays;

    const state = this.store.loadState();
    for (const project of state.projects) {
      this.projects.set(project.id, project);
    }
    for (const preset of state.directoryPresets) {
      this.directoryPresets.set(preset.id, preset);
    }
    for (const runner of state.runners) {
      this.runners.set(runner.id, runner);
    }
    for (const task of state.tasks) {
      this.tasks.set(task.id, task);
    }
    for (const approval of state.approvals) {
      this.approvals.set(approval.id, approval);
    }
    for (const artifact of state.artifacts) {
      const taskArtifacts = this.artifacts.get(artifact.taskId) ?? [];
      taskArtifacts.push(artifact);
      this.artifacts.set(artifact.taskId, taskArtifacts);
    }
    for (const event of state.events) {
      const taskEvents = this.events.get(event.taskId) ?? [];
      taskEvents.push(event);
      this.events.set(event.taskId, taskEvents);
    }
    for (const session of state.sessions) {
      this.sessions.set(session.sessionAlias, session);
    }
    for (const command of state.commands) {
      this.commands.set(command.id, command);
    }
    for (const command of state.utilityCommands) {
      if (command.kind === "create_codex_profile") {
        if (!command.baseURL || !command.apiKey) {
          this.store.deleteUtilityCommand(command.id);
          continue;
        }

        // Keep legacy in-flight requests working in memory, but scrub secrets from SQLite.
        this.store.upsertUtilityCommand(command);
      }
      this.utilityCommands.set(command.id, command);
    }

    this.cleanupExpiredData();
  }

  listWorkflows(): WorkflowDefinition[] {
    return workflows;
  }

  listProjects(): ProjectSummary[] {
    this.maybeCleanupExpiredData();

    return Array.from(this.projects.values())
      .map((project) => this.buildProjectSummary(project))
      .sort((lhs, rhs) => {
        if (lhs.isFeatured !== rhs.isFeatured) {
          return lhs.isFeatured ? -1 : 1;
        }
        const lhsKey = lhs.latestTaskUpdatedAt ?? lhs.updatedAt;
        const rhsKey = rhs.latestTaskUpdatedAt ?? rhs.updatedAt;
        return rhsKey.localeCompare(lhsKey);
      });
  }

  listDirectoryPresets(): DirectoryPresetRecord[] {
    this.maybeCleanupExpiredData();

    return Array.from(this.directoryPresets.values()).sort((lhs, rhs) => {
      const runnerComparison = lhs.runnerId.localeCompare(rhs.runnerId);
      if (runnerComparison !== 0) {
        return runnerComparison;
      }

      const labelComparison = lhs.label.localeCompare(rhs.label);
      if (labelComparison !== 0) {
        return labelComparison;
      }

      return lhs.id.localeCompare(rhs.id);
    });
  }

  getProject(projectId: string): ProjectSummary | undefined {
    this.maybeCleanupExpiredData();
    const project = this.projects.get(projectId);
    if (!project) {
      return undefined;
    }

    return this.buildProjectSummary(project);
  }

  syncRunnerDirectoryPresets(
    runnerId: string,
    presets: Array<Omit<DirectoryPresetRecord, "runnerId" | "createdAt" | "updatedAt">>,
    runnerInstanceId?: string
  ): DirectoryPresetRecord[] {
    this.ensureRunnerInstance(runnerId, runnerInstanceId, { adoptIfUnknown: true });
    this.requireKnownRunner(runnerId);
    const syncedAt = now();
    const keepIds: string[] = [];

    for (const input of presets) {
      const presetId = directoryPresetStorageId(runnerId, input.id);
      const existing = this.directoryPresets.get(presetId);
      const preset: DirectoryPresetRecord = {
        id: presetId,
        label: input.label,
        rootPath: input.rootPath,
        runnerId,
        createdAt: existing?.createdAt ?? syncedAt,
        updatedAt: syncedAt
      };

      keepIds.push(preset.id);
      this.directoryPresets.set(preset.id, preset);
      this.store.upsertDirectoryPreset(preset);
    }

    const removed = this.store.deleteDirectoryPresetsByRunnerExcept(runnerId, keepIds);
    for (const presetId of removed) {
      this.directoryPresets.delete(presetId);
    }

    return this.listDirectoryPresets();
  }

  listRunners(): RunnerInfo[] {
    return Array.from(this.runners.values())
      .map((runner) => this.withFreshness(runner))
      .sort((lhs, rhs) => rhs.lastHeartbeatAt.localeCompare(lhs.lastHeartbeatAt));
  }

  getCodexConfigState(): CodexConfigState {
    this.recoverStaleUtilityClaims();
    const persisted = this.store.loadCodexConfigProjection();
    const runners = persisted.runners
      .map((candidate) => this.withFreshness(candidate))
      .sort((lhs, rhs) => rhs.lastHeartbeatAt.localeCompare(lhs.lastHeartbeatAt));
    const runner = this.resolvePreferredCodexConfigRunner(runners);
    if (!runner) {
      return {
        profiles: []
      };
    }

    const runnersById = new Map(runners.map((candidate) => [candidate.id, candidate]));
    const pending = persisted.utilityCommands
      .filter((command) => command.runnerId === runner.id && !command.completedAt)
      .filter((command) => this.isCodexConfigUtilityCommand(command))
      .filter((command) => {
        if (!command.claimedAt) {
          return true;
        }

        return runnersById.get(command.runnerId)?.isOnline ?? false;
      })
      .sort((lhs, rhs) => lhs.createdAt.localeCompare(rhs.createdAt))[0];

    return {
      runnerId: runner.id,
      profiles: runner.codexConfigProfiles ?? [],
      activeProfileName: runner.activeCodexConfigProfile,
      pendingAction: pending?.kind === "create_codex_profile"
        ? "create"
        : pending?.kind === "switch_codex_profile"
          ? "switch"
          : pending?.kind === "delete_codex_profile"
            ? "delete"
            : undefined,
      pendingProfileName: pending?.profileName ?? pending?.label
    };
  }

  listTasks(options?: ListTasksOptions): TaskRecord[] {
    this.maybeCleanupExpiredData();

    let items = Array.from(this.tasks.values());
    if (options?.projectId) {
      items = items.filter((task) => this.taskMatchesProject(task, options.projectId!));
    }
    if (options?.status) {
      items = items.filter((task) => task.status === options.status);
    }

    items.sort((lhs, rhs) => {
      const priorityDifference = this.taskPriority(lhs) - this.taskPriority(rhs);
      if (priorityDifference !== 0) {
        return priorityDifference;
      }

      const updatedAtDifference = rhs.updatedAt.localeCompare(lhs.updatedAt);
      if (updatedAtDifference !== 0) {
        return updatedAtDifference;
      }

      return lhs.id.localeCompare(rhs.id);
    });

    if (options?.cursor) {
      const cursorIndex = items.findIndex((task) => `${task.updatedAt}|${task.id}` === options.cursor || task.id === options.cursor);
      if (cursorIndex >= 0) {
        items = items.slice(cursorIndex + 1);
      }
    }

    if (options?.limit && options.limit > 0) {
      items = items.slice(0, options.limit);
    }

    return items;
  }

  listApprovals(): ApprovalRequest[] {
    this.maybeCleanupExpiredData();

    return Array.from(this.approvals.values()).sort((lhs, rhs) => rhs.createdAt.localeCompare(lhs.createdAt));
  }

  getTask(taskId: string, options?: GetTaskOptions): TaskSnapshot | undefined {
    this.maybeCleanupExpiredData();

    const task = this.tasks.get(taskId);
    if (!task) {
      return undefined;
    }

    const artifacts = options?.includeArtifacts === false
      ? []
      : (this.artifacts.get(taskId) ?? []);
    const events = options?.includeEvents === false
      ? []
      : (this.events.get(taskId) ?? []);

    return {
      ...task,
      approvals: this.listApprovalsForTask(taskId),
      artifacts: options?.artifactLimit && options.artifactLimit > 0
        ? artifacts.slice(0, options.artifactLimit)
        : artifacts,
      events: options?.eventLimit && options.eventLimit > 0
        ? events.slice(-options.eventLimit)
        : events,
      executorSession: this.sessions.get(task.sessionAlias)
    };
  }

  getTaskStatusView(taskId: string): TaskSnapshot | undefined {
    return this.getTask(taskId, {
      includeArtifacts: false,
      eventLimit: 1
    });
  }

  upsertRunner(input: Omit<RunnerInfo, "isOnline" | "lastHeartbeatAt">, runnerInstanceId?: string): RunnerInfo {
    const previous = this.runners.get(input.id);
    const runner: RunnerInfo = {
      ...previous,
      ...input,
      isOnline: true,
      lastHeartbeatAt: now()
    };
    if (runnerInstanceId?.trim()) {
      this.runnerInstances.set(input.id, runnerInstanceId.trim());
    }
    this.runners.set(runner.id, runner);
    this.store.upsertRunner(runner);
    return this.withFreshness(runner);
  }

  syncRunnerProjects(
    runnerId: string,
    projects: Array<Omit<ProjectRecord, "runnerId" | "createdAt" | "updatedAt" | "lastSyncedAt">>,
    runnerInstanceId?: string
  ): ProjectSummary[] {
    this.ensureRunnerInstance(runnerId, runnerInstanceId, { adoptIfUnknown: true });
    this.requireKnownRunner(runnerId);
    const syncedAt = now();
    const keepIds: string[] = [];

    for (const input of projects) {
      const existing = this.projects.get(input.id);
      const project: ProjectRecord = {
        id: input.id,
        name: input.name,
        repo: input.repo,
        baseBranch: input.baseBranch,
        deliveryMode: input.deliveryMode,
        autoPush: input.autoPush,
        defaultTaskTitle: input.defaultTaskTitle,
        defaultPrompt: input.defaultPrompt,
        isFeatured: input.isFeatured,
        runnerId,
        createdAt: existing?.createdAt ?? syncedAt,
        updatedAt: syncedAt,
        lastSyncedAt: syncedAt
      };

      keepIds.push(project.id);
      this.projects.set(project.id, project);
      this.store.upsertProject(project);
    }

    const removed = this.store.deleteProjectsByRunnerExcept(runnerId, keepIds);
    for (const projectId of removed) {
      this.projects.delete(projectId);
    }

    return this.listProjects();
  }

  heartbeatRunner(
    runnerId: string,
    patch: Pick<
      RunnerInfo,
      | "currentTaskId"
      | "currentCommandId"
      | "currentCommandKind"
      | "currentCommandStartedAt"
      | "version"
      | "hostname"
      | "codexConfigProfiles"
      | "activeCodexConfigProfile"
    >,
    runnerInstanceId?: string
  ): RunnerInfo {
    this.ensureRunnerInstance(runnerId, runnerInstanceId, { adoptIfUnknown: true });
    const runner = this.runners.get(runnerId);
    if (!runner) {
      throw new Error(`Runner ${runnerId} not found`);
    }

    runner.currentTaskId = patch.currentTaskId;
    runner.currentCommandId = patch.currentCommandId;
    runner.currentCommandKind = patch.currentCommandKind;
    runner.currentCommandStartedAt = patch.currentCommandStartedAt;
    runner.version = patch.version ?? runner.version;
    runner.hostname = patch.hostname ?? runner.hostname;
    runner.codexConfigProfiles = patch.codexConfigProfiles ?? runner.codexConfigProfiles;
    runner.activeCodexConfigProfile = patch.activeCodexConfigProfile ?? runner.activeCodexConfigProfile;
    runner.lastHeartbeatAt = now();
    runner.isOnline = true;
    this.store.upsertRunner(runner);
    return this.withFreshness(runner);
  }

  subscribe(taskId: string, listener: (payload: TaskStreamPayload) => void): () => void {
    this.bus.on(taskId, listener);
    return () => {
      this.bus.off(taskId, listener);
    };
  }

  createTask(input: CreateTaskInput): TaskSnapshot {
    const runner = input.projectId ? this.requireProjectRunner(input.projectId) : this.requireRunner();
    this.ensureRepositoryAvailableForNewTask(input.repo, {
      allowParallel: input.allowParallel
    });
    const createdAt = now();
    const taskId = `task_${shortId()}`;
    const planApprovalRequired = requiresExplicitPlanApproval(input.deliveryMode);
    const branchMode = input.deliveryMode === "direct_commit"
      ? "current_branch"
      : input.branchMode ?? "new_branch";
    const branchName = branchMode === "new_branch"
      ? resolveTaskBranchName({
          branchName: input.branchName,
          title: input.title,
          prompt: input.prompt,
          projectName: input.projectName
        })
      : undefined;
    const task: TaskRecord = {
      id: taskId,
      workflowKey: input.workflowKey,
      deliveryMode: input.deliveryMode,
      autoPush: input.autoPush,
      title: input.title,
      prompt: input.prompt,
      repo: input.repo,
      baseBranch: input.baseBranch,
      branchMode,
      branchName,
      reviewPlatform: inferReviewPlatformFromRepoRef(input.repo),
      reviewTargetBranches: [input.baseBranch],
      projectId: input.projectId,
      projectName: input.projectName,
      executionMode: input.executionMode,
      resumeThreadId: input.resumeThreadId?.trim() || undefined,
      status: "queued",
      runnerId: runner.id,
      sessionAlias: `session_${shortId()}`,
      summary: planApprovalRequired
        ? "Task queued. Waiting for the Mac runner to prepare the workspace and generate an initial plan."
        : "Task queued. Waiting for the Mac runner to prepare the workspace, draft the plan, and start implementation automatically.",
      createdAt,
      updatedAt: createdAt
    };

    this.tasks.set(task.id, task);
    this.events.set(task.id, []);
    this.artifacts.set(task.id, []);
    this.store.upsertTask(task);
    this.enqueueCommand(task.id, runner.id, "generate_plan", { prompt: input.prompt });
    this.publish(
      task.id,
      "task.created",
      "Task created",
      task.branchMode === "current_branch"
        ? `Created coding session for ${input.repo} on the repository's current checked-out branch.`
        : `Created coding session for ${input.repo} on branch ${task.branchName}.`
    );
    return this.getTask(task.id)!;
  }

  createTaskForProject(projectId: string, input: CreateProjectTaskInput): TaskSnapshot {
    const project = this.projects.get(projectId);
    if (!project) {
      throw new Error(`Project ${projectId} not found`);
    }

    return this.createTask({
      workflowKey: "coding_session",
      deliveryMode: input.deliveryMode ?? project.deliveryMode,
      autoPush: input.autoPush ?? project.autoPush,
      title: input.title,
      prompt: input.prompt,
      repo: project.repo,
      baseBranch: project.baseBranch,
      branchMode: input.branchMode,
      branchName: input.branchName,
      projectId: project.id,
      projectName: project.name,
      executionMode: input.executionMode,
      resumeThreadId: input.resumeThreadId,
      allowParallel: input.allowParallel
    });
  }

  addUserMessage(taskId: string, message: string): TaskSnapshot {
    const task = this.requireTask(taskId);
    this.ensureTaskHasNoPendingDirtyWorkspace(task);
    this.ensureTaskReadyForQueue(taskId);
    this.publish(taskId, "user.message", "User follow-up", message);
    this.setTaskState(taskId, "queued", "Follow-up queued. Waiting for the Mac runner to execute the next Codex turn.");
    this.enqueueCommand(taskId, this.requireTaskRunner(task).id, "continue_prompt", { prompt: message });
    return this.getTask(taskId)!;
  }

  continueTask(taskId: string): TaskSnapshot {
    return this.addUserMessage(taskId, "Please continue the implementation based on the latest approved plan.");
  }

  completeTask(taskId: string): TaskSnapshot {
    const task = this.requireTask(taskId);
    if (task.status === "completed") {
      return this.getTask(taskId)!;
    }

    this.ensureTaskHasNoPendingDirtyWorkspace(task);
    if (task.status !== "awaiting_human_input") {
      throw new Error(`Task ${taskId} can only be manually completed while waiting for input`);
    }

    this.ensureTaskReadyForQueue(taskId);
    const summary = summarizeManualTaskCompletion(task);
    this.setTaskState(taskId, "completed", summary);
    this.publish(taskId, "task.completed_manual", "Task marked completed", summary);
    return this.getTask(taskId)!;
  }

  openInCodexApp(taskId: string): TaskSnapshot {
    const task = this.requireTask(taskId);
    this.ensureTaskHasNoPendingDirtyWorkspace(task);
    this.ensureTaskReadyForQueue(taskId);
    this.setTaskState(taskId, "queued", "Desktop handoff queued. Waiting for the Mac runner to open the workspace in Codex App.");
    this.enqueueCommand(taskId, this.requireTaskRunner(task).id, "open_in_codex_app");
    this.publish(taskId, "handoff.requested", "Open in Codex App requested", "The task will be opened locally on the active Mac runner.");
    return this.getTask(taskId)!;
  }

  inspectWorkspace(taskId: string): TaskSnapshot {
    const task = this.requireTask(taskId);
    this.ensureTaskHasNoPendingDirtyWorkspace(task);
    this.ensureTaskReadyForQueue(taskId);
    this.setTaskState(taskId, "queued", "Workspace recheck queued. Waiting for the Mac runner to inspect the current repository state.");
    this.enqueueCommand(taskId, this.requireTaskRunner(task).id, "inspect_workspace");
    this.publish(taskId, "workspace.inspect_requested", "Workspace recheck requested", "The Mac runner will re-check the current repository state and refresh the dirty workspace options if needed.");
    return this.getTask(taskId)!;
  }

  resolveDirtyWorkspaceDecision(taskId: string, decision: DirtyWorkspaceDecision): TaskSnapshot {
    const task = this.requireTask(taskId);
    const dirtyWorkspace = task.dirtyWorkspace;
    if (dirtyWorkspace?.state !== "pending_decision") {
      throw new Error(`Task ${taskId} does not have a pending dirty workspace decision`);
    }

    if (decision === "cancel") {
      task.dirtyWorkspace = undefined;
      task.executionBranch = dirtyWorkspace.currentBranch ?? task.executionBranch;
      this.store.upsertTask(task);
      this.setTaskState(taskId, "canceled", "Task canceled because the repository had uncommitted local changes.");
      this.publish(taskId, "workspace.dirty_canceled", "Dirty workspace task canceled", "The task was canceled without touching the repository.");
      return this.getTask(taskId)!;
    }

    this.ensureTaskReadyForQueue(taskId);
    task.dirtyWorkspace = {
      ...dirtyWorkspace,
      lastDecision: decision
    };
    this.store.upsertTask(task);

    const summary = {
      clear_and_continue: "Dirty workspace decision queued. The runner will clear local changes, switch to the task branch, and generate a fresh plan.",
      continue_current_workspace: "Dirty workspace decision queued. The runner will stay on the current branch and generate a plan against the existing local changes.",
      plan_only: "Dirty workspace decision queued. The runner will inspect the current local changes and generate a plan without editing files."
    }[decision];

    this.setTaskState(taskId, "queued", summary);
    this.enqueueCommand(taskId, this.requireTaskRunner(task).id, "resolve_dirty_workspace", {
      dirtyWorkspaceDecision: decision
    });
    this.publish(taskId, "workspace.dirty_decision_queued", "Dirty workspace decision queued", summary);
    return this.getTask(taskId)!;
  }

  requestGitAction(
    taskId: string,
    action: GitAction,
    message?: string,
    prTitle?: string,
    targetBranch?: string,
    reviewMode?: ReviewMode
  ): TaskSnapshot {
    const task = this.requireTask(taskId);
    this.ensureTaskHasNoPendingDirtyWorkspace(task);
    this.ensureTaskReadyForQueue(taskId);
    const reviewLabel = this.reviewRequestLabel(task);
    const sourceBranch = task.executionBranch ?? task.branchName;
    const resolvedTargetBranch = targetBranch?.trim() || task.baseBranch;
    const resolvedReviewMode: ReviewMode = reviewMode ?? "review_only";
    if (action === "create_pr") {
      if (task.deliveryMode === "direct_commit") {
        throw new Error("This task uses direct_commit delivery and does not support PR/MR creation from the task detail actions.");
      }
      this.ensureTaskCanCreateReview(task);
    }
    const title = {
      commit: "Approve commit",
      rebase: "Approve rebase",
      push: "Approve push",
      create_pr: `Approve create ${reviewLabel}`
    }[action];
    const detail = {
      commit: message?.trim()
        ? `Commit all current changes on ${sourceBranch} with message: ${message}`
        : `Create a commit from the current staged and unstaged changes on ${sourceBranch}.`,
      rebase: `Rebase ${sourceBranch} onto the latest ${task.baseBranch}.`,
      push: `Push branch ${sourceBranch} to origin.`,
      create_pr: resolvedReviewMode === "commit_and_review"
        ? `Commit the current changes on ${sourceBranch}${message?.trim() ? ` with message: ${message.trim()}` : ""}, then create a draft ${reviewLabel} into ${resolvedTargetBranch}${(prTitle?.trim() || task.title).trim() ? ` with title: ${(prTitle?.trim() || task.title).trim()}` : ""}.`
        : `Create a draft ${reviewLabel} from ${sourceBranch} into ${resolvedTargetBranch}${(prTitle?.trim() || task.title).trim() ? ` with title: ${(prTitle?.trim() || task.title).trim()}` : ""}.`
    }[action];

    this.setTaskState(taskId, "awaiting_git_approval", `Waiting for approval to ${action.replace("_", " ")}.`);
    this.createApproval(
      taskId,
      `git.${action}`,
      title,
      detail,
      {
        ...(message?.trim() ? { message: message.trim() } : {}),
        ...(action === "create_pr"
          ? {
              title: (prTitle?.trim() || task.title).trim(),
              targetBranch: resolvedTargetBranch,
              reviewMode: resolvedReviewMode,
              ...(resolvedReviewMode === "commit_and_review" && message?.trim() ? { message: message.trim() } : {})
            }
          : {})
      }
    );
    this.publish(taskId, "git.approval_requested", title, detail);
    return this.getTask(taskId)!;
  }

  resolveApproval(approvalId: string, decision: "approve" | "deny"): ApprovalRequest {
    const approval = this.approvals.get(approvalId);
    if (!approval) {
      throw new Error(`Approval ${approvalId} not found`);
    }

    if (approval.status !== "pending") {
      return approval;
    }

    approval.status = decision === "approve" ? "approved" : "denied";
    approval.resolvedAt = now();
    this.store.upsertApproval(approval);
    this.publish(approval.taskId, "approval.resolved", approval.title, `Decision: ${decision}`);

    if (approval.type === "plan.execute") {
      if (decision === "approve") {
        const task = this.requireTask(approval.taskId);
        this.ensureTaskReadyForQueue(task.id, { allowPendingApprovals: true });
        this.setTaskState(task.id, "queued", "Plan approved. Waiting for the Mac runner to execute the implementation turn.");
        this.enqueueCommand(task.id, this.requireTaskRunner(task).id, "continue_prompt", {
          prompt: approvedPlanExecutionPrompt(task.deliveryMode)
        });
      } else {
        this.setTaskState(approval.taskId, "awaiting_human_input", "Plan approval denied. Waiting for your next instruction.");
      }
      return approval;
    }

    const protectedGitKind = protectedGitKindFromApprovalType(approval.type);
    if (protectedGitKind) {
      if (decision === "deny") {
        this.setTaskState(approval.taskId, "awaiting_human_input", `Protected Git command ${protectedGitKind.replace("_", " ")} was denied.`);
        return approval;
      }

      const task = this.requireTask(approval.taskId);
      this.ensureTaskReadyForQueue(task.id, { allowPendingApprovals: true });
      const protectedGitCommand = JSON.parse(approval.payload.protectedGitCommandJson ?? "{}") as ProtectedGitCommand;
      const prompt = [
        `The previously blocked destructive Git command is now approved: ${protectedGitCommandSummary(protectedGitCommand)}.`,
        "The runner already has permission to execute it for this turn.",
        "Continue the implementation, and do not request any additional destructive Git commands unless they are strictly necessary."
      ].join("\n\n");
      this.setTaskState(task.id, "queued", `Protected Git command approved. Waiting for the Mac runner to resume Codex and continue the task.`);
      this.enqueueCommand(task.id, this.requireTaskRunner(task).id, "continue_prompt", {
        prompt,
        protectedGitCommand,
        allowedProtectedGitCommandKinds: [protectedGitKind]
      });
      this.publish(task.id, "git.queued", "Protected Git command queued", approval.detail);
      return approval;
    }

    const gitAction = approval.type.replace("git.", "") as GitAction;
    if (decision === "deny") {
      this.setTaskState(approval.taskId, "awaiting_human_input", `Git action ${gitAction} was denied.`);
      return approval;
    }

    const task = this.requireTask(approval.taskId);
    this.ensureTaskReadyForQueue(task.id, { allowPendingApprovals: true });
    this.setTaskState(task.id, "queued", `Git action approved. Waiting for the Mac runner to ${gitAction.replace("_", " ")}.`);
    this.enqueueCommand(task.id, this.requireTaskRunner(task).id, `git.${gitAction}`, {
      commitMessage: approval.payload.message,
      prTitle: approval.payload.title,
      targetBranch: approval.payload.targetBranch,
      reviewMode: approval.payload.reviewMode as ReviewMode | undefined
    });
    this.publish(task.id, "git.queued", "Git action queued", approval.detail);
    return approval;
  }

  stopTask(taskId: string): TaskSnapshot {
    this.recoverStaleClaimedCommands();
    const task = this.requireTask(taskId);
    const activeCommand = Array.from(this.commands.values()).find((candidate) => candidate.taskId === taskId && !candidate.completedAt);
    const pendingApprovals = this.listApprovalsForTask(taskId).filter((approval) => approval.status === "pending");

    if (task.status === "canceled") {
      return this.getTask(taskId)!;
    }

    if (activeCommand?.claimedAt) {
      if (!task.stopRequestedAt) {
        task.stopRequestedAt = now();
        this.store.upsertTask(task);
      }
      this.setTaskState(taskId, task.status, "Stop requested. Waiting for the Mac runner to halt local work.");
      this.publish(taskId, "task.stop_requested", "Stop requested", "iPhone requested that the Mac runner stop this task.");
      return this.getTask(taskId)!;
    }

    for (const approval of pendingApprovals) {
      approval.status = "denied";
      approval.resolvedAt = now();
      this.store.upsertApproval(approval);
    }

    if (activeCommand) {
      this.commands.delete(activeCommand.id);
      this.store.deleteCommand(activeCommand.id);
    }

    task.stopRequestedAt = undefined;
    task.dirtyWorkspace = undefined;
    this.store.upsertTask(task);
    this.setTaskState(taskId, "canceled", "Task canceled from iPhone before the Mac runner finished.");
    this.publish(taskId, "task.canceled", "Task canceled", "The task was canceled before the Mac runner started or resumed local execution.");
    return this.getTask(taskId)!;
  }

  deleteTaskRecord(taskId: string): void {
    this.recoverStaleClaimedCommands();
    const task = this.requireTask(taskId);

    if (!isTerminalTaskStatus(task.status)) {
      throw new Error(`Task ${taskId} must be completed, failed, or canceled before it can be deleted`);
    }

    const runner = task.runnerId ? this.runners.get(task.runnerId) : undefined;
    if (runner?.currentTaskId === taskId) {
      throw new Error(`Task ${taskId} is still owned by the Mac runner and cannot be deleted yet`);
    }

    for (const approval of Array.from(this.approvals.values())) {
      if (approval.taskId === taskId) {
        this.approvals.delete(approval.id);
      }
    }

    for (const command of Array.from(this.commands.values())) {
      if (command.taskId === taskId) {
        this.commands.delete(command.id);
      }
    }

    this.tasks.delete(taskId);
    this.events.delete(taskId);
    this.artifacts.delete(taskId);
    this.sessions.delete(task.sessionAlias);
    this.store.deleteTask(taskId);
  }

  requestDirectoryCreation(input: CreateDirectoryInput): DirectoryCreationReceipt {
    this.recoverStaleUtilityClaims();
    const { presetId, relativePath } = input;
    const preset = this.directoryPresets.get(presetId);
    if (!preset) {
      throw new Error(`Directory preset ${presetId} not found`);
    }

    const runner = this.withFreshness(this.requireKnownRunner(preset.runnerId));
    if (!runner.isOnline) {
      throw new Error(`No online runner is currently available for directory preset ${preset.label}`);
    }

    const normalizedRelativePath = normalizeRelativeDirectoryPath(relativePath);
    const absolutePath = resolveDirectoryTarget(preset.rootPath, normalizedRelativePath);
    const createProject = input.createProject !== false;
    const projectName = input.projectName?.trim() || path.basename(normalizedRelativePath) || normalizedRelativePath;
    const baseBranch = input.baseBranch?.trim() || "main";
    const defaultTaskTitle = input.defaultTaskTitle?.trim() || `Work on ${projectName}`;
    const defaultPrompt = input.defaultPrompt?.trim() || `Describe the outcome you want in ${projectName}. Mention files to create or change and checks to run.`;
    const command: UtilityCommandRecord = {
      id: `utility_${shortId()}`,
      runnerId: preset.runnerId,
      kind: "create_directory",
      presetId: preset.id,
      label: preset.label,
      rootPath: preset.rootPath,
      relativePath: normalizedRelativePath,
      absolutePath,
      createProject,
      projectName: createProject ? projectName : undefined,
      projectBaseBranch: createProject ? baseBranch : undefined,
      projectDeliveryMode: createProject ? input.deliveryMode ?? "direct_commit" : undefined,
      projectAutoPush: createProject ? input.autoPush ?? false : undefined,
      projectDefaultTaskTitle: createProject ? defaultTaskTitle : undefined,
      projectDefaultPrompt: createProject ? defaultPrompt : undefined,
      createdAt: now()
    };

    this.utilityCommands.set(command.id, command);
    this.store.upsertUtilityCommand(command);

    return {
      requestId: command.id,
      presetId: preset.id,
      runnerId: preset.runnerId,
      relativePath: normalizedRelativePath,
      absolutePath,
      createProject,
      projectName: createProject ? projectName : undefined,
      summary: createProject
        ? `Queued directory creation at ${absolutePath}. The Mac runner will create it and add ${projectName} to Projects shortly.`
        : `Queued directory creation at ${absolutePath}. The Mac runner will create it shortly.`
    };
  }

  switchCodexConfig(profileName: string): CodexConfigActionReceipt {
    this.recoverStaleUtilityClaims();
    const runner = this.requireCodexConfigRunner();
    this.ensureRunnerReadyForCodexConfigCommand(runner);

    const normalizedProfileName = this.findMatchingCodexProfileName(runner, profileName) ?? profileName.trim();
    const command: UtilityCommandRecord = {
      id: `utility_${shortId()}`,
      runnerId: runner.id,
      kind: "switch_codex_profile",
      presetId: "codex_config",
      label: normalizedProfileName,
      rootPath: "codex_config",
      relativePath: normalizedProfileName,
      absolutePath: normalizedProfileName,
      profileName: normalizedProfileName,
      createdAt: now()
    };

    this.utilityCommands.set(command.id, command);
    this.store.upsertUtilityCommand(command);

    return {
      requestId: command.id,
      runnerId: runner.id,
      profileName: normalizedProfileName,
      summary: `Queued Codex config switch to ${normalizedProfileName}. The Mac runner will replace ~/.codex and restart Codex shortly.`
    };
  }

  deleteCodexConfig(profileName: string): CodexConfigActionReceipt {
    this.recoverStaleUtilityClaims();
    const runner = this.requireCodexConfigRunner();
    this.ensureRunnerReadyForCodexConfigCommand(runner);

    const normalizedProfileName = this.ensureCodexProfileCanBeDeleted(runner, profileName.trim());
    const command: UtilityCommandRecord = {
      id: `utility_${shortId()}`,
      runnerId: runner.id,
      kind: "delete_codex_profile",
      presetId: "codex_config",
      label: normalizedProfileName,
      rootPath: "codex_config",
      relativePath: normalizedProfileName,
      absolutePath: normalizedProfileName,
      profileName: normalizedProfileName,
      createdAt: now()
    };

    this.utilityCommands.set(command.id, command);
    this.store.upsertUtilityCommand(command);

    return {
      requestId: command.id,
      runnerId: runner.id,
      profileName: normalizedProfileName,
      summary: `Queued deletion of Codex config ${normalizedProfileName}. The Mac runner will remove it shortly.`
    };
  }

  createCodexConfig(profileName: string, baseURL: string, apiKey: string): CodexConfigActionReceipt {
    this.recoverStaleUtilityClaims();
    const runner = this.requireCodexConfigRunner();
    this.ensureRunnerReadyForCodexConfigCommand(runner);

    const normalizedProfileName = profileName.trim();
    this.ensureCodexProfileNameAvailable(runner, normalizedProfileName);
    const command: UtilityCommandRecord = {
      id: `utility_${shortId()}`,
      runnerId: runner.id,
      kind: "create_codex_profile",
      presetId: "codex_config",
      label: normalizedProfileName,
      rootPath: "codex_config",
      relativePath: normalizedProfileName,
      absolutePath: normalizedProfileName,
      profileName: normalizedProfileName,
      baseURL: baseURL.trim(),
      apiKey: apiKey.trim(),
      createdAt: now()
    };

    this.utilityCommands.set(command.id, command);
    this.store.upsertUtilityCommand(command);

    return {
      requestId: command.id,
      runnerId: runner.id,
      profileName: normalizedProfileName,
      summary: `Queued creation of Codex config ${normalizedProfileName}. The Mac runner will save it, replace ~/.codex, and restart Codex shortly.`
    };
  }

  claimNextUtilityCommand(runnerId: string, runnerInstanceId?: string): UtilityRunnerAssignment | undefined {
    this.recoverStaleUtilityClaims();
    this.ensureRunnerInstance(runnerId, runnerInstanceId, { adoptIfUnknown: true });
    const runner = this.withFreshness(this.requireKnownRunner(runnerId));
    if (!runner.isOnline) {
      return undefined;
    }

    const activeCommand = Array.from(this.utilityCommands.values()).find(
      (candidate) => candidate.runnerId === runnerId && candidate.claimedAt && !candidate.completedAt
    );
    if (activeCommand) {
      return undefined;
    }

    const command = Array.from(this.utilityCommands.values())
      .filter((candidate) => candidate.runnerId === runnerId && !candidate.claimedAt && !candidate.completedAt)
      .sort((lhs, rhs) => lhs.createdAt.localeCompare(rhs.createdAt))[0];

    if (!command) {
      return undefined;
    }

    command.claimedAt = now();
    command.claimToken = `claim_${shortId()}`;
    this.store.upsertUtilityCommand(command);

    return {
      id: command.id,
      runnerId: command.runnerId,
      claimToken: command.claimToken!,
      kind: command.kind,
      presetId: command.presetId,
      label: command.label,
      rootPath: command.rootPath,
      relativePath: command.relativePath,
      absolutePath: command.absolutePath,
      createdAt: command.createdAt,
      createProject: command.createProject,
      projectName: command.projectName,
      projectBaseBranch: command.projectBaseBranch,
      projectDeliveryMode: command.projectDeliveryMode,
      projectAutoPush: command.projectAutoPush,
      projectDefaultTaskTitle: command.projectDefaultTaskTitle,
      projectDefaultPrompt: command.projectDefaultPrompt,
      profileName: command.profileName,
      baseURL: command.baseURL,
      apiKey: command.apiKey
    };
  }

  completeUtilityCommand(
    runnerId: string,
    commandId: string,
    input: UtilityCompletionInput,
    runnerInstanceId?: string
  ): void {
    this.ensureRunnerInstance(runnerId, runnerInstanceId, { adoptIfUnknown: true });
    const command = this.utilityCommands.get(commandId);
    if (!command) {
      throw new Error(`Utility command ${commandId} not found`);
    }

    if (command.runnerId !== runnerId) {
      throw new Error(`Utility command ${commandId} is not assigned to runner ${runnerId}`);
    }

    if (input.claimToken?.trim() && command.claimToken && command.claimToken !== input.claimToken.trim()) {
      throw new Error(`Utility command claim token mismatch for ${commandId}`);
    }

    command.completedAt = now();
    command.lastOutcome = input.outcome;
    command.lastMessage = input.message?.trim() || undefined;
    command.absolutePath = input.absolutePath?.trim() || command.absolutePath;
    if (this.isCodexConfigUtilityCommand(command)) {
      const runner = this.requireKnownRunner(runnerId);
      runner.codexConfigProfiles = input.codexConfigProfiles ?? runner.codexConfigProfiles;
      runner.activeCodexConfigProfile = input.activeCodexConfigProfile ?? runner.activeCodexConfigProfile;
      runner.lastHeartbeatAt = now();
      runner.isOnline = true;
      this.store.upsertRunner(runner);
    }
    this.store.upsertUtilityCommand(command);
    this.utilityCommands.delete(command.id);
    this.store.deleteUtilityCommand(command.id);
  }

  claimNextCommand(runnerId: string, runnerInstanceId?: string): RunnerAssignment | undefined {
    this.recoverStaleClaimedCommands();
    this.ensureRunnerInstance(runnerId, runnerInstanceId, { adoptIfUnknown: true });
    const runner = this.withFreshness(this.requireKnownRunner(runnerId));
    if (!runner.isOnline) {
      return undefined;
    }

    const activeCommand = Array.from(this.commands.values()).find(
      (candidate) => candidate.runnerId === runnerId && candidate.claimedAt && !candidate.completedAt
    );
    if (runner.currentTaskId || activeCommand) {
      return undefined;
    }

    const command = Array.from(this.commands.values())
      .filter((candidate) => candidate.runnerId === runnerId && !candidate.claimedAt && !candidate.completedAt)
      .sort((lhs, rhs) => lhs.createdAt.localeCompare(rhs.createdAt))[0];

    if (!command) {
      return undefined;
    }

    command.claimedAt = now();
    command.claimToken = `claim_${shortId()}`;
    command.completedAt = undefined;
    this.store.upsertCommand(command);
    runner.currentTaskId = command.taskId;
    runner.currentCommandId = command.id;
    runner.currentCommandKind = command.kind;
    runner.currentCommandStartedAt = command.claimedAt;
    runner.lastHeartbeatAt = now();
    this.store.upsertRunner(runner);

    const task = this.requireTask(command.taskId);
    switch (command.kind) {
      case "generate_plan":
        this.setTaskState(task.id, "preparing_workspace", "Runner claimed the task and is preparing the workspace for the initial planning turn.");
        this.publish(task.id, "runner.claimed", "Runner claimed task", `Runner ${runner.name} is preparing the repository and Codex planning session.`);
        break;
      case "continue_prompt":
        this.setTaskState(task.id, "running", "Runner claimed the next Codex turn and is applying the latest instructions.");
        this.publish(task.id, "runner.claimed", "Runner executing turn", `Runner ${runner.name} resumed the Codex session.`);
        break;
      case "open_in_codex_app":
        this.setTaskState(task.id, "running", "Runner is opening the task workspace in Codex App.");
        this.publish(task.id, "handoff.starting", "Desktop handoff starting", `Runner ${runner.name} is opening Codex App.`);
        break;
      case "inspect_workspace":
        this.setTaskState(task.id, "running", "Runner is re-checking the current repository state.");
        this.publish(task.id, "workspace.inspect_started", "Workspace recheck started", `Runner ${runner.name} is checking the repository for local changes.`);
        break;
      case "resolve_dirty_workspace": {
        const dirtyDecision = command.dirtyWorkspaceDecision ?? "continue_current_workspace";
        const summary = {
          clear_and_continue: "Runner is clearing the repository state and preparing a fresh planning turn.",
          continue_current_workspace: "Runner is preparing a planning turn against the current local workspace state.",
          plan_only: "Runner is generating a plan only, without editing files.",
          cancel: "Runner is canceling the task."
        }[dirtyDecision];
        this.setTaskState(task.id, "running", summary);
        this.publish(task.id, "workspace.dirty_resolution_started", "Dirty workspace resolution started", summary);
        break;
      }
      default: {
        const gitAction = gitActionFromKind(command.kind as RunnerCommandKind);
        this.setTaskState(task.id, "running", `Runner is executing Git action: ${gitAction?.replace("_", " ") ?? "unknown"}.`);
        this.publish(task.id, "git.executing", "Git action started", `Runner ${runner.name} started ${gitAction?.replace("_", " ") ?? "the Git action"}.`);
        break;
      }
    }

    return {
      id: command.id,
      taskId: command.taskId,
      runnerId: command.runnerId,
      claimToken: command.claimToken!,
      kind: command.kind as RunnerCommandKind,
      prompt: command.prompt,
      commitMessage: command.commitMessage,
      prTitle: command.prTitle,
      targetBranch: command.targetBranch,
      reviewMode: command.reviewMode,
      dirtyWorkspaceDecision: command.dirtyWorkspaceDecision,
      protectedGitCommand: command.protectedGitCommand,
      allowedProtectedGitCommandKinds: command.allowedProtectedGitCommandKinds,
      task: this.getTask(command.taskId)!
    };
  }

  logRunnerProgress(runnerId: string, taskId: string, input: RunnerLogInput, runnerInstanceId?: string): TaskSnapshot {
    this.ensureRunnerInstance(runnerId, runnerInstanceId, { adoptIfUnknown: true });
    const task = this.requireTask(taskId);
    if (task.runnerId !== runnerId) {
      throw new Error(`Task ${taskId} is not assigned to runner ${runnerId}`);
    }

    const command = this.requireCommandOwnership(runnerId, taskId, input.commandId, input.claimToken, {
      allowCompletedMatch: true
    });
    if (command.completedAt) {
      return this.getTask(taskId)!;
    }

    if (input.session) {
      this.applySessionPatch(task, input.session);
    }

    if (input.status || input.summary) {
      this.setTaskState(taskId, (input.status as TaskStatus | undefined) ?? task.status, input.summary ?? task.summary);
    }

    if (input.branchName?.trim()) {
      task.branchName = input.branchName.trim();
    }

    if (input.executionBranch?.trim()) {
      task.executionBranch = input.executionBranch.trim();
    }

    if (input.reviewPlatform) {
      task.reviewPlatform = input.reviewPlatform;
    }

    if (input.reviewTargetBranches !== undefined) {
      task.reviewTargetBranches = input.reviewTargetBranches;
    }

    if (input.branchName?.trim() || input.executionBranch?.trim() || input.reviewPlatform || input.reviewTargetBranches !== undefined) {
      this.store.upsertTask(task);
    }

    if (input.artifact) {
      this.addArtifact(taskId, input.artifact.kind, input.artifact.title, input.artifact.summary);
    }

    this.publish(taskId, input.kind, input.title, input.detail);
    return this.getTask(taskId)!;
  }

  completeRunnerCommand(
    runnerId: string,
    taskId: string,
    input: RunnerCompletionInput,
    runnerInstanceId?: string
  ): TaskSnapshot {
    this.ensureRunnerInstance(runnerId, runnerInstanceId, { adoptIfUnknown: true });
    const task = this.requireTask(taskId);
    if (task.runnerId !== runnerId) {
      throw new Error(`Task ${taskId} is not assigned to runner ${runnerId}`);
    }

    const command = this.requireCommandOwnership(runnerId, taskId, input.commandId, input.claimToken, {
      allowCompletedMatch: true
    });
    if (command.completedAt) {
      return this.getTask(taskId)!;
    }

    if ("session" in input && input.session) {
      this.applySessionPatch(task, input.session);
    }

    command.claimedAt = undefined;
    command.completedAt = now();
    this.store.upsertCommand(command);
    this.releaseRunner(runnerId, taskId);

    const dirtyWorkspaceDecision = command.kind === "resolve_dirty_workspace" ? command.dirtyWorkspaceDecision : undefined;
    task.stopRequestedAt = undefined;
    this.store.upsertTask(task);

    switch (input.outcome) {
      case "plan_ready":
        this.addArtifact(taskId, "plan", "Execution plan", input.planSummary);
        this.applyReportPatch(task, {
          reportURL: input.reportURL,
          lastPublishedAt: input.lastPublishedAt
        });
        if (dirtyWorkspaceDecision === "plan_only") {
          task.dirtyWorkspace = task.dirtyWorkspace?.state === "pending_decision"
            ? {
                ...task.dirtyWorkspace,
                lastDecision: "plan_only"
              }
            : task.dirtyWorkspace;
          this.store.upsertTask(task);
          this.setTaskState(taskId, "awaiting_human_input", "Plan generated from the current dirty workspace. No files were changed yet.");
          this.publish(taskId, "workspace.dirty_plan_ready", "Plan ready from current workspace", input.planSummary);
          break;
        }

        if (dirtyWorkspaceDecision) {
          task.dirtyWorkspace = undefined;
          this.store.upsertTask(task);
        }
        if (requiresExplicitPlanApproval(task.deliveryMode)) {
          this.setTaskState(taskId, "awaiting_plan_approval", "Codex generated an initial plan and is waiting for approval.");
          this.createApproval(taskId, "plan.execute", "Approve execution plan", "Start the implementation turn on the Mac runner.", {});
          this.publish(taskId, "plan.generated", "Plan ready", input.planSummary);
          break;
        }

        this.setTaskState(taskId, "queued", "Plan captured. Waiting for the Mac runner to start implementation automatically.");
        this.enqueueCommand(taskId, this.requireTaskRunner(task).id, "continue_prompt", {
          prompt: approvedPlanExecutionPrompt(task.deliveryMode)
        });
        this.publish(taskId, "plan.generated", "Plan ready", input.planSummary);
        break;
      case "turn_complete":
        this.addArtifact(taskId, "diff", "Diff summary", input.summary);
        if (input.testsSummary) {
          this.addArtifact(taskId, "tests", "Validation summary", input.testsSummary);
        }
        this.applyReportPatch(task, {
          reportURL: input.reportURL,
          lastPublishedAt: input.lastPublishedAt,
          latestResultSummary: input.latestResultSummary ?? input.summary
        });
        this.setTaskState(taskId, resolveTurnCompletionStatus(task, input), summarizeTurnCompletion(task, input));
        this.publish(taskId, "codex.turn_complete", "Implementation update", input.summary);
        break;
      case "handoff_completed":
        this.addArtifact(taskId, "handoff", "Codex App handoff", input.summary);
        this.setTaskState(taskId, "awaiting_human_input", "The task workspace is now open in Codex App on the Mac runner.");
        this.publish(taskId, "handoff.codex_app", "Codex App opened", input.summary);
        break;
      case "git_completed":
        this.addArtifact(taskId, "git", "Git result", input.summary);
        this.applyReportPatch(task, {
          reportURL: input.reportURL,
          lastPublishedAt: input.lastPublishedAt,
          latestResultSummary: input.latestResultSummary ?? input.summary
        });
        this.setTaskState(taskId, resolveGitCompletionStatus(task, input), summarizeGitCompletion(task, input));
        this.publish(taskId, "git.completed", "Git action completed", input.summary);
        break;
      case "dirty_workspace_detected":
        this.applyReportPatch(task, {
          reportURL: input.reportURL,
          lastPublishedAt: input.lastPublishedAt,
          latestResultSummary: input.latestResultSummary ?? input.summary
        });
        task.executionBranch = input.currentBranch ?? task.executionBranch;
        task.reviewPlatform = input.reviewPlatform ?? task.reviewPlatform;
        task.reviewTargetBranches = input.reviewTargetBranches ?? task.reviewTargetBranches;
        task.dirtyWorkspace = {
          state: "pending_decision",
          currentBranch: input.currentBranch ?? task.executionBranch,
          statusSummary: input.statusSummary,
          detectedAt: now(),
          snapshotPublishedAt: input.lastPublishedAt ?? now()
        };
        this.store.upsertTask(task);
        this.setTaskState(taskId, "awaiting_human_input", input.summary);
        this.publish(taskId, "workspace.dirty_detected", "Dirty workspace detected", input.statusSummary ?? input.summary);
        break;
      case "workspace_inspected_clean":
        this.applyReportPatch(task, {
          reportURL: input.reportURL,
          lastPublishedAt: input.lastPublishedAt,
          latestResultSummary: input.latestResultSummary ?? input.summary
        });
        task.executionBranch = input.currentBranch ?? task.executionBranch;
        task.reviewPlatform = input.reviewPlatform ?? task.reviewPlatform;
        task.reviewTargetBranches = input.reviewTargetBranches ?? task.reviewTargetBranches;
        task.dirtyWorkspace = undefined;
        this.store.upsertTask(task);
        this.setTaskState(taskId, "awaiting_human_input", input.summary);
        if (this.latestEventMatches(taskId, "workspace.clean", "Workspace clean")) {
          this.emitTaskSnapshot(taskId);
        } else {
          this.publish(taskId, "workspace.clean", "Workspace clean", input.statusSummary ?? input.summary);
        }
        break;
      case "protected_git_command_blocked": {
        const protectedCommand = input.protectedGitCommand;
        const commandSummary = protectedGitCommandSummary(protectedCommand);
        const detail = `Codex requested \`${commandSummary}\` while working in ${this.getTask(taskId)?.executorSession?.cwd ?? task.repo}. Approve to let the runner execute it and resume the Codex thread.`;
        this.setTaskState(taskId, "awaiting_git_approval", `Waiting for approval to run ${commandSummary}.`);
        this.createApproval(taskId, protectedGitApprovalType(protectedCommand.kind), protectedGitCommandTitle(protectedCommand.kind), detail, {
          protectedGitCommandJson: JSON.stringify(protectedCommand)
        });
        this.publish(taskId, "git.approval_requested", protectedGitCommandTitle(protectedCommand.kind), detail);
        break;
      }
      case "failed":
        this.setTaskState(taskId, "failed", summarizeFailure(input.detail, input.summary));
        this.publish(taskId, "task.failed", "Runner command failed", input.detail ?? input.summary);
        break;
      case "canceled":
        this.setTaskState(taskId, "canceled", input.summary);
        this.publish(taskId, "task.canceled", "Task canceled", input.detail ?? input.summary);
        break;
    }

    return this.getTask(taskId)!;
  }

  cleanupExpiredData(): void {
    const deletedTaskIds = this.store.cleanupExpiredTasks(this.retentionDays);
    if (deletedTaskIds.length === 0) {
      this.lastCleanupAt = Date.now();
      return;
    }

    for (const taskId of deletedTaskIds) {
      const task = this.tasks.get(taskId);
      if (task) {
        this.sessions.delete(task.sessionAlias);
      }

      this.tasks.delete(taskId);
      this.events.delete(taskId);
      this.artifacts.delete(taskId);

      for (const approval of Array.from(this.approvals.values())) {
        if (approval.taskId === taskId) {
          this.approvals.delete(approval.id);
        }
      }

      for (const command of Array.from(this.commands.values())) {
        if (command.taskId === taskId) {
          this.commands.delete(command.id);
        }
      }
    }

    this.lastCleanupAt = Date.now();
  }

  private maybeCleanupExpiredData(): void {
    this.recoverStaleClaimedCommands();
    this.recoverStaleUtilityClaims();
    if (Date.now() - this.lastCleanupAt < CLEANUP_INTERVAL_MS) {
      return;
    }

    this.cleanupExpiredData();
  }

  private buildProjectSummary(project: ProjectRecord): ProjectSummary {
    const tasks = Array.from(this.tasks.values())
      .filter((task) => this.taskMatchesProject(task, project.id))
      .sort((lhs, rhs) => rhs.updatedAt.localeCompare(lhs.updatedAt));
    const taskIds = new Set(tasks.map((task) => task.id));
    const pendingApprovalsCount = Array.from(this.approvals.values()).filter(
      (approval) => approval.status === "pending" && taskIds.has(approval.taskId)
    ).length;
    const latestTask = tasks[0];

    return {
      ...project,
      recentTasksCount: tasks.length,
      pendingApprovalsCount,
      latestTaskId: latestTask?.id,
      latestTaskTitle: latestTask?.title,
      latestTaskStatus: latestTask?.status,
      latestTaskUpdatedAt: latestTask?.updatedAt,
      latestReportURL: latestTask?.reportURL,
      latestResultSummary: latestTask?.latestResultSummary
    };
  }

  private taskMatchesProject(task: TaskRecord, projectId: string): boolean {
    const project = this.projects.get(projectId);
    if (!project) {
      return false;
    }

    if (task.projectId === project.id) {
      return true;
    }

    if (task.projectName?.trim() && task.projectName === project.name) {
      return true;
    }

    const taskRepoIdentity = normalizeRepoIdentity(task.repo);
    const projectRepoIdentity = normalizeRepoIdentity(project.repo);
    return taskRepoIdentity.length > 0 && taskRepoIdentity === projectRepoIdentity;
  }

  private enqueueCommand(
    taskId: string,
    runnerId: string,
    kind: RunnerCommandKind,
    options: EnqueueCommandOptions = {}
  ): void {
    const command: PendingCommandRecord = {
      id: `cmd_${shortId()}`,
      taskId,
      runnerId,
      kind,
      prompt: options.prompt,
      commitMessage: options.commitMessage,
      prTitle: options.prTitle,
      targetBranch: options.targetBranch,
      reviewMode: options.reviewMode,
      dirtyWorkspaceDecision: options.dirtyWorkspaceDecision,
      protectedGitCommand: options.protectedGitCommand,
      allowedProtectedGitCommandKinds: options.allowedProtectedGitCommandKinds,
      createdAt: now()
    };
    this.commands.set(command.id, command);
    this.store.upsertCommand(command);
  }

  private createApproval(
    taskId: string,
    type: ApprovalRequest["type"],
    title: string,
    detail: string,
    payload: Record<string, string>
  ): ApprovalRequest {
    const approval: ApprovalRequest = {
      id: `approval_${shortId()}`,
      taskId,
      type,
      title,
      detail,
      payload,
      status: "pending",
      createdAt: now()
    };
    this.approvals.set(approval.id, approval);
    this.store.upsertApproval(approval);
    return approval;
  }

  private addArtifact(taskId: string, kind: Artifact["kind"], title: string, summary: string): Artifact {
    const artifact: Artifact = {
      id: `artifact_${shortId()}`,
      taskId,
      kind,
      title,
      summary,
      createdAt: now()
    };
    const artifacts = this.artifacts.get(taskId) ?? [];
    artifacts.unshift(artifact);
    let removedIds: string[] = [];
    if (artifacts.length > MAX_ARTIFACTS_PER_TASK) {
      removedIds = artifacts.splice(MAX_ARTIFACTS_PER_TASK).map((item) => item.id);
    }
    this.artifacts.set(taskId, artifacts);
    this.store.upsertArtifact(artifact);
    this.store.deleteArtifacts(removedIds);
    return artifact;
  }

  private setTaskState(taskId: string, status: TaskStatus, summary: string): void {
    const task = this.requireTask(taskId);
    task.status = status;
    task.summary = summary;
    task.updatedAt = now();
    this.store.upsertTask(task);
  }

  private applyReportPatch(
    task: TaskRecord,
    patch: { reportURL?: string; lastPublishedAt?: string; latestResultSummary?: string }
  ): void {
    let changed = false;

    if (patch.reportURL !== undefined) {
      task.reportURL = patch.reportURL;
      changed = true;
    }

    if (patch.lastPublishedAt !== undefined) {
      task.lastPublishedAt = patch.lastPublishedAt;
      changed = true;
    }

    if (patch.latestResultSummary !== undefined) {
      task.latestResultSummary = patch.latestResultSummary;
      changed = true;
    }

    if (changed) {
      this.store.upsertTask(task);
    }
  }

  private publish(taskId: string, kind: string, title: string, detail: string): void {
    const event: TaskEvent = {
      id: `event_${shortId()}`,
      taskId,
      createdAt: now(),
      kind,
      title,
      detail
    };
    const taskEvents = this.events.get(taskId) ?? [];
    taskEvents.push(event);
    let removedIds: string[] = [];
    if (taskEvents.length > MAX_EVENTS_PER_TASK) {
      removedIds = taskEvents.splice(0, taskEvents.length - MAX_EVENTS_PER_TASK).map((item) => item.id);
    }
    this.events.set(taskId, taskEvents);
    this.store.upsertEvent(event);
    this.store.deleteEvents(removedIds);
    const task = this.tasks.get(taskId);
    if (task) {
      task.updatedAt = event.createdAt;
      this.store.upsertTask(task);
    }
    this.emitTaskSnapshot(taskId, event);
  }

  private emitTaskSnapshot(taskId: string, event?: TaskEvent): void {
    const snapshot = this.getTask(taskId);
    if (!snapshot) {
      return;
    }

    this.bus.emit(taskId, {
      event,
      snapshot
    } satisfies TaskStreamPayload);
  }

  private latestEventMatches(taskId: string, kind: string, title: string): boolean {
    const latestEvent = (this.events.get(taskId) ?? []).at(-1);
    return latestEvent?.kind === kind && latestEvent.title === title;
  }

  private ensureRunnerInstance(
    runnerId: string,
    runnerInstanceId?: string,
    options?: { adoptIfUnknown?: boolean }
  ): void {
    if (!runnerInstanceId?.trim()) {
      return;
    }

    this.requireKnownRunner(runnerId);
    const normalized = runnerInstanceId.trim();
    const activeInstanceId = this.runnerInstances.get(runnerId);
    if (!activeInstanceId) {
      if (options?.adoptIfUnknown) {
        this.runnerInstances.set(runnerId, normalized);
      }
      return;
    }

    if (activeInstanceId !== normalized) {
      throw new Error(`Runner instance mismatch for ${runnerId}`);
    }
  }

  private requireCommandOwnership(
    runnerId: string,
    taskId: string,
    commandId?: string,
    claimToken?: string,
    options?: { allowCompletedMatch?: boolean }
  ): PendingCommandRecord {
    const matchingTaskCommands = Array.from(this.commands.values()).filter(
      (candidate) => candidate.taskId === taskId && candidate.runnerId === runnerId
    );

    const command = commandId
      ? matchingTaskCommands.find((candidate) => candidate.id === commandId)
      : matchingTaskCommands.find((candidate) => candidate.claimedAt && !candidate.completedAt);
    if (!command) {
      throw new Error(`No active runner command found for task ${taskId}`);
    }

    if (claimToken?.trim() && command.claimToken && command.claimToken !== claimToken.trim()) {
      throw new Error(`Runner command claim token mismatch for task ${taskId}`);
    }

    if (command.completedAt) {
      if (options?.allowCompletedMatch) {
        return command;
      }
      throw new Error(`Runner command ${command.id} is already completed`);
    }

    if (!command.claimedAt) {
      throw new Error(`Runner command ${command.id} is not currently claimed`);
    }

    return command;
  }

  private releaseRunner(runnerId: string, taskId: string): void {
    const runner = this.runners.get(runnerId);
    if (!runner) {
      return;
    }

    if (runner.currentTaskId === taskId) {
      runner.currentTaskId = undefined;
      runner.lastHeartbeatAt = now();
      this.store.upsertRunner(runner);
    }
  }

  private applySessionPatch(task: TaskRecord, patch: Partial<Omit<ExecutorSession, "sessionAlias" | "runnerId">>): void {
    const existing = this.sessions.get(task.sessionAlias);
    if (!existing) {
      if (
        !patch.executorType ||
        !patch.threadId ||
        !patch.cwd ||
        patch.materializedFromHistory === undefined ||
        !patch.lastTurnAt
      ) {
        return;
      }

      const nextSession: ExecutorSession = {
        sessionAlias: task.sessionAlias,
        executorType: patch.executorType,
        runnerId: this.requireTaskRunner(task).id,
        threadId: patch.threadId,
        cwd: patch.cwd,
        materializedFromHistory: patch.materializedFromHistory,
        lastTurnAt: patch.lastTurnAt
      };
      this.sessions.set(task.sessionAlias, nextSession);
      this.store.upsertSession(nextSession);
      return;
    }

    const nextSession: ExecutorSession = {
      ...existing,
      ...patch,
      sessionAlias: existing.sessionAlias,
      runnerId: existing.runnerId
    };
    this.sessions.set(task.sessionAlias, nextSession);
    this.store.upsertSession(nextSession);
  }

  private listApprovalsForTask(taskId: string): ApprovalRequest[] {
    return Array.from(this.approvals.values())
      .filter((approval) => approval.taskId === taskId)
      .sort((lhs, rhs) => rhs.createdAt.localeCompare(lhs.createdAt));
  }

  private resolvePreferredCodexConfigRunner(runners: RunnerInfo[] = this.listRunners()): RunnerInfo | undefined {
    return runners[0];
  }

  private isCodexConfigUtilityCommand(command: UtilityCommandRecord): boolean {
    return command.kind === "switch_codex_profile"
      || command.kind === "create_codex_profile"
      || command.kind === "delete_codex_profile";
  }

  private normalizeCodexProfileName(profileName: string): string {
    return profileName.trim().toLocaleLowerCase();
  }

  private findMatchingCodexProfileName(runner: RunnerInfo, profileName: string): string | undefined {
    const normalizedProfileName = this.normalizeCodexProfileName(profileName);
    return (runner.codexConfigProfiles ?? []).find(
      (candidate) => this.normalizeCodexProfileName(candidate) === normalizedProfileName
    );
  }

  private ensureCodexProfileNameAvailable(runner: RunnerInfo, profileName: string): void {
    const normalizedProfileName = this.normalizeCodexProfileName(profileName);
    const existingProfile = this.findMatchingCodexProfileName(runner, profileName);
    if (existingProfile) {
      throw new Error(`Codex config profile ${existingProfile} already exists`);
    }

    const pendingCreate = Array.from(this.utilityCommands.values()).find((command) =>
      command.runnerId === runner.id &&
      command.kind === "create_codex_profile" &&
      !command.completedAt &&
      this.normalizeCodexProfileName(command.profileName ?? command.label) === normalizedProfileName
    );
    if (pendingCreate) {
      throw new Error(`Codex config profile ${profileName.trim()} already has a queued create request`);
    }
  }

  private ensureCodexProfileCanBeDeleted(runner: RunnerInfo, profileName: string): string {
    const existingProfile = this.findMatchingCodexProfileName(runner, profileName);
    if (!existingProfile) {
      throw new Error(`Codex config profile ${profileName.trim()} not found`);
    }

    if (PROTECTED_CODEX_PROFILE_NAMES.has(this.normalizeCodexProfileName(existingProfile))) {
      throw new Error(`Codex config profile ${existingProfile} is protected and cannot be deleted`);
    }

    if (
      runner.activeCodexConfigProfile &&
      this.normalizeCodexProfileName(runner.activeCodexConfigProfile) === this.normalizeCodexProfileName(existingProfile)
    ) {
      throw new Error(`Codex config profile ${existingProfile} is currently active and cannot be deleted`);
    }

    return existingProfile;
  }

  private requireCodexConfigRunner(): RunnerInfo {
    const runner = this.listRunners().find((candidate) => candidate.isOnline);
    if (!runner) {
      throw new Error("No online runner is currently available");
    }
    return runner;
  }

  private ensureRunnerReadyForCodexConfigCommand(runner: RunnerInfo): void {
    if (runner.currentTaskId) {
      throw new Error(`Runner ${runner.id} is busy with task ${runner.currentTaskId}. Wait for it to finish before switching Codex config.`);
    }

    const pendingUtility = Array.from(this.utilityCommands.values())
      .find((command) => command.runnerId === runner.id && !command.completedAt && this.isCodexConfigUtilityCommand(command));
    if (pendingUtility) {
      throw new Error(`Runner ${runner.id} already has a queued Codex config action`);
    }
  }

  private requireRunner(): RunnerInfo {
    const runner = Array.from(this.runners.values())
      .map((candidate) => this.withFreshness(candidate))
      .find((candidate) => candidate.isOnline);
    if (!runner) {
      throw new Error("No online runner is currently available");
    }
    return runner;
  }

  private requireProjectRunner(projectId: string): RunnerInfo {
    const project = this.projects.get(projectId);
    if (!project) {
      throw new Error(`Project ${projectId} not found`);
    }

    const runner = this.withFreshness(this.requireKnownRunner(project.runnerId));
    if (!runner.isOnline) {
      throw new Error(`No online runner is currently available for project ${project.name}`);
    }
    return runner;
  }

  private requireKnownRunner(runnerId: string): RunnerInfo {
    const runner = this.runners.get(runnerId);
    if (!runner) {
      throw new Error(`Runner ${runnerId} not found`);
    }
    return runner;
  }

  private persistTaskRunnerAssignment(task: TaskRecord, runner: RunnerInfo): RunnerInfo {
    if (task.runnerId !== runner.id) {
      task.runnerId = runner.id;
      this.store.upsertTask(task);
    }

    return runner;
  }

  private resolveFallbackRunnerForTask(task: TaskRecord): RunnerInfo {
    if (task.projectId) {
      const project = this.projects.get(task.projectId);
      if (project) {
        const projectRunner = this.runners.get(project.runnerId);
        if (projectRunner) {
          return this.persistTaskRunnerAssignment(task, this.withFreshness(projectRunner));
        }
      }
    }

    const knownRunners = Array.from(this.runners.values())
      .map((candidate) => this.withFreshness(candidate))
      .sort((lhs, rhs) => rhs.lastHeartbeatAt.localeCompare(lhs.lastHeartbeatAt));

    const onlineRunner = knownRunners.find((candidate) => candidate.isOnline);
    if (onlineRunner) {
      return this.persistTaskRunnerAssignment(task, onlineRunner);
    }

    const freshestKnownRunner = knownRunners[0];
    if (freshestKnownRunner) {
      return this.persistTaskRunnerAssignment(task, freshestKnownRunner);
    }

    throw new Error("No online runner is currently available");
  }

  private requireTask(taskId: string): TaskRecord {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }
    return task;
  }

  private requireTaskRunner(task: TaskRecord): RunnerInfo {
    if (task.runnerId) {
      const existingRunner = this.runners.get(task.runnerId);
      if (existingRunner) {
        return this.withFreshness(existingRunner);
      }
    }

    return this.resolveFallbackRunnerForTask(task);
  }

  private requireTaskRunnerCapability(task: TaskRecord, capability: string, message: string): void {
    const runner = this.requireTaskRunner(task);
    if (!runner.capabilities.includes(capability)) {
      throw new Error(message);
    }
  }

  private resolveReviewPlatform(task: TaskRecord) {
    return task.reviewPlatform ?? inferReviewPlatformFromRepoRef(task.repo);
  }

  private reviewRequestLabel(task: TaskRecord): "pull request" | "merge request" | "review request" {
    switch (this.resolveReviewPlatform(task)) {
      case "github":
        return "pull request";
      case "gitlab":
        return "merge request";
      default:
        return "review request";
    }
  }

  private ensureTaskCanCreateReview(task: TaskRecord): void {
    switch (this.resolveReviewPlatform(task)) {
      case "github":
        this.requireTaskRunnerCapability(
          task,
          "github_pr",
          "The assigned Mac runner cannot create pull requests yet. Install GitHub CLI (`gh`) and run `gh auth login` on the runner, then refresh this task."
        );
        return;
      case "gitlab":
        this.requireTaskRunnerCapability(
          task,
          "gitlab_mr",
          "The assigned Mac runner cannot create merge requests yet. Add `GITLAB_TOKEN` on the runner, then refresh this task."
        );
        return;
      default:
        throw new Error(
          "The assigned Mac runner has not identified whether this repository uses GitHub or GitLab yet. Refresh this task after workspace preparation."
        );
    }
  }

  private ensureTaskHasNoPendingDirtyWorkspace(task: TaskRecord): void {
    if (task.dirtyWorkspace?.state === "pending_decision") {
      throw new Error(`Task ${task.id} is waiting for a dirty workspace decision`);
    }
  }

  private ensureRepositoryAvailableForNewTask(repo: string, options?: { allowParallel?: boolean }): void {
    this.recoverStaleClaimedCommands();

    if (options?.allowParallel) {
      return;
    }
    const targetRepo = normalizeRepoIdentity(repo);
    const conflictingTask = Array.from(this.tasks.values())
      .filter((task) => normalizeRepoIdentity(task.repo) === targetRepo)
      .filter((task) => !isTerminalTaskStatus(task.status))
      .sort((lhs, rhs) => rhs.updatedAt.localeCompare(lhs.updatedAt))[0];

    if (!conflictingTask) {
      return;
    }

    throw new Error(
      `Repository ${repo} already has an unfinished task ${conflictingTask.id} (status: ${conflictingTask.status}). Continue, stop, or cancel that task before creating another one.`
    );
  }

  private ensureTaskReadyForQueue(taskId: string, options?: { allowPendingApprovals?: boolean }): void {
    this.recoverStaleClaimedCommands();
    const task = this.requireTask(taskId);
    if (task.stopRequestedAt) {
      throw new Error(`Task ${taskId} already has a stop request in progress`);
    }
    const activeCommand = Array.from(this.commands.values()).find((candidate) => candidate.taskId === taskId && !candidate.completedAt);
    if (activeCommand) {
      const runner = this.runners.get(activeCommand.runnerId);
      const runnerStillOwnsTask = runner?.currentTaskId === taskId;
      const terminalTaskWithoutRunner = isTerminalTaskStatus(task.status) && !runnerStillOwnsTask;

      if (terminalTaskWithoutRunner) {
        this.commands.delete(activeCommand.id);
        this.store.deleteCommand(activeCommand.id);
      } else {
        throw new Error(`Task ${taskId} already has a queued runner command`);
      }
    }

    const refreshedActiveCommand = Array.from(this.commands.values()).find((candidate) => candidate.taskId === taskId && !candidate.completedAt);
    if (refreshedActiveCommand) {
      throw new Error(`Task ${taskId} already has a queued runner command`);
    }

    const pendingApproval = this.listApprovalsForTask(taskId).find((approval) => approval.status === "pending");
    if (pendingApproval && !options?.allowPendingApprovals) {
      throw new Error(`Task ${taskId} already has a pending approval`);
    }
  }

  private withFreshness(runner: RunnerInfo): RunnerInfo {
    const isOnline = Date.now() - Date.parse(runner.lastHeartbeatAt) <= config.runner.offlineThresholdMs;
    const normalized: RunnerInfo = {
      ...runner,
      isOnline
    };
    this.runners.set(runner.id, normalized);
    return normalized;
  }

  private taskPriority(task: TaskRecord): number {
    if (task.dirtyWorkspace?.state === "pending_decision") {
      return 1;
    }

    const hasPendingApproval = this.listApprovalsForTask(task.id).some((approval) => approval.status === "pending");
    if (hasPendingApproval) {
      return 0;
    }

    return taskStatusPriority[task.status];
  }

  private recoverStaleClaimedCommands(): void {
    if (this.recoveringStaleClaims) {
      return;
    }

    this.recoveringStaleClaims = true;

    try {
      for (const command of Array.from(this.commands.values())) {
        if (!command.claimedAt || command.completedAt) {
          continue;
        }

        const runner = this.runners.get(command.runnerId);
        const freshRunner = runner ? this.withFreshness(runner) : undefined;
        const runnerStillOwnsTask = freshRunner?.currentTaskId === command.taskId;
        const claimAgeMs = Date.now() - Date.parse(command.claimedAt);
        const claimTimedOut =
          Boolean(freshRunner?.isOnline && runnerStillOwnsTask) &&
          Number.isFinite(claimAgeMs) &&
          claimAgeMs > config.runner.claimTimeoutMs;
        const staleClaim = !freshRunner || !freshRunner.isOnline || !runnerStillOwnsTask || claimTimedOut;

        if (!staleClaim) {
          continue;
        }

        command.claimedAt = undefined;
        command.claimToken = undefined;
        this.store.upsertCommand(command);

        if (freshRunner?.currentTaskId === command.taskId) {
          freshRunner.currentTaskId = undefined;
          freshRunner.currentCommandId = undefined;
          freshRunner.currentCommandKind = undefined;
          freshRunner.currentCommandStartedAt = undefined;
          freshRunner.lastHeartbeatAt = now();
          this.store.upsertRunner(freshRunner);
        }

        const task = this.tasks.get(command.taskId);
        if (!task) {
          this.commands.delete(command.id);
          this.store.deleteCommand(command.id);
          continue;
        }

        if (["completed", "failed", "canceled"].includes(task.status)) {
          continue;
        }

        const recoverySummary = claimTimedOut
          ? "Recovered a timed-out runner command. Waiting for a Mac runner to resume this task."
          : "Recovered a stale runner claim. Waiting for a Mac runner to resume this task.";
        const recoveryDetail = claimTimedOut
          ? `Runner ${command.runnerId} stayed on ${command.kind} for longer than the configured timeout. The command was re-queued.`
          : `Runner ${command.runnerId} stopped reporting while ${command.kind} was in progress. The command was re-queued.`;

        this.setTaskState(task.id, "queued", recoverySummary);
        this.publish(
          task.id,
          "runner.recovered",
          "Recovered stale runner claim",
          recoveryDetail
        );
      }
    } finally {
      this.recoveringStaleClaims = false;
    }
  }

  private recoverStaleUtilityClaims(): void {
    if (this.recoveringStaleUtilityClaims) {
      return;
    }

    this.recoveringStaleUtilityClaims = true;

    try {
      for (const command of Array.from(this.utilityCommands.values())) {
        if (!command.claimedAt || command.completedAt) {
          continue;
        }

        const runner = this.runners.get(command.runnerId);
        const freshRunner = runner ? this.withFreshness(runner) : undefined;
        const staleClaim = !freshRunner || !freshRunner.isOnline;

        if (!staleClaim) {
          continue;
        }

        command.claimedAt = undefined;
        command.claimToken = undefined;
        command.completedAt = undefined;
        command.lastOutcome = undefined;
        command.lastMessage = undefined;
        this.store.upsertUtilityCommand(command);
      }
    } finally {
      this.recoveringStaleUtilityClaims = false;
    }
  }
}
