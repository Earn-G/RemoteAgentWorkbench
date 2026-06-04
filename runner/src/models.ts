export type GitAction = "commit" | "rebase" | "push" | "create_pr";
export type ProtectedGitCommandKind = "reset_hard" | "clean_fd";
export type ReviewMode = "review_only" | "commit_and_review";
export type TaskExecutionMode = "new_thread" | "resume_thread";
export type DeliveryMode = "review_required" | "direct_commit";
export type TaskBranchMode = "current_branch" | "new_branch";
export type DirtyWorkspaceDecision = "clear_and_continue" | "continue_current_workspace" | "plan_only" | "cancel";
export type DirtyWorkspaceState = "pending_decision";
export type RunnerCommandKind =
  | "generate_plan"
  | "continue_prompt"
  | "open_in_codex_app"
  | "inspect_workspace"
  | "resolve_dirty_workspace"
  | `git.${GitAction}`;
export type ReviewPlatform = "github" | "gitlab";

export interface ProjectRecord {
  id: string;
  name: string;
  repo: string;
  baseBranch: string;
  deliveryMode: DeliveryMode;
  autoPush: boolean;
  defaultTaskTitle: string;
  defaultPrompt: string;
  isFeatured: boolean;
  runnerId: string;
  createdAt: string;
  updatedAt: string;
  lastSyncedAt: string;
}

export interface ProjectSummary extends ProjectRecord {
  recentTasksCount: number;
  pendingApprovalsCount: number;
  latestTaskId?: string;
  latestTaskTitle?: string;
  latestTaskStatus?: string;
  latestTaskUpdatedAt?: string;
  latestReportURL?: string;
  latestResultSummary?: string;
}

export interface DirectoryPresetRecord {
  id: string;
  label: string;
  rootPath: string;
  runnerId: string;
  createdAt: string;
  updatedAt: string;
}

export interface ApprovalRequest {
  id: string;
  taskId: string;
  type: string;
  title: string;
  detail: string;
  status: "pending" | "approved" | "denied";
  payload: Record<string, string>;
  createdAt: string;
  resolvedAt?: string;
}

export interface Artifact {
  id: string;
  taskId: string;
  kind: "plan" | "diff" | "tests" | "git" | "handoff";
  title: string;
  summary: string;
  createdAt: string;
}

export interface TaskEvent {
  id: string;
  taskId: string;
  createdAt: string;
  kind: string;
  title: string;
  detail: string;
}

export interface ExecutorSession {
  sessionAlias: string;
  executorType: "codex_app_server" | "codex_cli";
  runnerId: string;
  threadId: string;
  cwd: string;
  materializedFromHistory: boolean;
  lastTurnAt: string;
}

export interface TaskSnapshot {
  id: string;
  workflowKey: string;
  deliveryMode: DeliveryMode;
  autoPush: boolean;
  title: string;
  prompt: string;
  repo: string;
  baseBranch: string;
  branchMode: TaskBranchMode;
  branchName?: string;
  executionBranch?: string;
  reviewPlatform?: ReviewPlatform;
  reviewTargetBranches?: string[];
  dirtyWorkspace?: {
    state: DirtyWorkspaceState;
    currentBranch?: string;
    statusSummary?: string;
    detectedAt: string;
    snapshotPublishedAt?: string;
    lastDecision?: DirtyWorkspaceDecision;
  };
  projectId?: string;
  projectName?: string;
  executionMode: TaskExecutionMode;
  resumeThreadId?: string;
  stopRequestedAt?: string;
  status: string;
  runnerId?: string;
  sessionAlias: string;
  summary: string;
  reportURL?: string;
  lastPublishedAt?: string;
  latestResultSummary?: string;
  createdAt: string;
  updatedAt: string;
  approvals: ApprovalRequest[];
  artifacts: Artifact[];
  events: TaskEvent[];
  executorSession?: ExecutorSession;
}

export interface RunnerAssignment {
  id: string;
  taskId: string;
  runnerId: string;
  claimToken: string;
  kind: RunnerCommandKind;
  prompt?: string;
  commitMessage?: string;
  prTitle?: string;
  targetBranch?: string;
  reviewMode?: ReviewMode;
  dirtyWorkspaceDecision?: DirtyWorkspaceDecision;
  protectedGitCommand?: ProtectedGitCommand;
  allowedProtectedGitCommandKinds?: ProtectedGitCommandKind[];
  task: TaskSnapshot;
}

export interface ProtectedGitCommand {
  kind: ProtectedGitCommandKind;
  args: string[];
}

export interface UtilityRunnerAssignment {
  id: string;
  runnerId: string;
  claimToken: string;
  kind: "create_directory" | "switch_codex_profile" | "create_codex_profile" | "delete_codex_profile";
  presetId: string;
  label: string;
  rootPath: string;
  relativePath: string;
  absolutePath: string;
  createdAt: string;
  createProject?: boolean;
  projectName?: string;
  projectBaseBranch?: string;
  projectDeliveryMode?: DeliveryMode;
  projectAutoPush?: boolean;
  projectDefaultTaskTitle?: string;
  projectDefaultPrompt?: string;
  profileName?: string;
  baseURL?: string;
  apiKey?: string;
}

export interface RunnerSessionPatch {
  executorType?: "codex_app_server" | "codex_cli";
  threadId?: string;
  cwd?: string;
  materializedFromHistory?: boolean;
  lastTurnAt?: string;
}

export interface RunnerLogPayload {
  commandId?: string;
  claimToken?: string;
  kind: string;
  title: string;
  detail: string;
  status?: string;
  summary?: string;
  branchName?: string;
  executionBranch?: string;
  reviewPlatform?: ReviewPlatform;
  reviewTargetBranches?: string[];
  artifact?: {
    kind: Artifact["kind"];
    title: string;
    summary: string;
  };
  session?: RunnerSessionPatch;
}

export type RunnerCompletionPayload =
  | {
      commandId?: string;
      claimToken?: string;
      outcome: "plan_ready";
      planSummary: string;
      reportURL?: string;
      lastPublishedAt?: string;
      session: {
        executorType: "codex_app_server" | "codex_cli";
        threadId: string;
        cwd: string;
        materializedFromHistory: boolean;
        lastTurnAt: string;
      };
    }
  | {
      commandId?: string;
      claimToken?: string;
      outcome: "turn_complete";
      summary: string;
      testsSummary?: string;
      implementationCommitCreated?: boolean;
      workspaceIsGitRepository?: boolean;
      session?: RunnerSessionPatch;
      reportURL?: string;
      lastPublishedAt?: string;
      latestResultSummary?: string;
    }
  | {
      commandId?: string;
      claimToken?: string;
      outcome: "handoff_completed";
      summary: string;
    }
  | {
      commandId?: string;
      claimToken?: string;
      outcome: "git_completed";
      action: GitAction;
      summary: string;
      reportURL?: string;
      lastPublishedAt?: string;
      latestResultSummary?: string;
    }
  | {
      commandId?: string;
      claimToken?: string;
      outcome: "dirty_workspace_detected";
      summary: string;
      currentBranch?: string;
      statusSummary?: string;
      reviewPlatform?: ReviewPlatform;
      reviewTargetBranches?: string[];
      reportURL?: string;
      lastPublishedAt?: string;
      latestResultSummary?: string;
    }
  | {
      commandId?: string;
      claimToken?: string;
      outcome: "workspace_inspected_clean";
      summary: string;
      currentBranch?: string;
      statusSummary?: string;
      reviewPlatform?: ReviewPlatform;
      reviewTargetBranches?: string[];
      reportURL?: string;
      lastPublishedAt?: string;
      latestResultSummary?: string;
    }
  | {
      commandId?: string;
      claimToken?: string;
      outcome: "protected_git_command_blocked";
      summary: string;
      protectedGitCommand: ProtectedGitCommand;
      session?: RunnerSessionPatch;
    }
  | {
      commandId?: string;
      claimToken?: string;
      outcome: "failed";
      summary: string;
      detail?: string;
    }
  | {
      commandId?: string;
      claimToken?: string;
      outcome: "canceled";
      summary: string;
      detail?: string;
    };

export interface UtilityCompletionPayload {
  claimToken?: string;
  outcome: "completed" | "failed";
  message?: string;
  absolutePath?: string;
  codexConfigProfiles?: string[];
  activeCodexConfigProfile?: string;
}
