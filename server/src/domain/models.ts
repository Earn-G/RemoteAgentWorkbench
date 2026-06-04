import { z } from "zod";

export const taskStatusValues = [
  "draft",
  "queued",
  "preparing_workspace",
  "awaiting_plan_approval",
  "running",
  "awaiting_human_input",
  "awaiting_git_approval",
  "blocked_conflict",
  "completed",
  "failed",
  "canceled"
] as const;

export const approvalStatusValues = ["pending", "approved", "denied"] as const;
export const gitActionValues = ["commit", "rebase", "push", "create_pr"] as const;
export const protectedGitCommandKindValues = ["reset_hard", "clean_fd"] as const;
export const reviewModeValues = ["review_only", "commit_and_review"] as const;
export const taskExecutionModeValues = ["new_thread", "resume_thread"] as const;
export const reviewPlatformValues = ["github", "gitlab"] as const;
export const deliveryModeValues = ["review_required", "direct_commit"] as const;
export const taskBranchModeValues = ["current_branch", "new_branch"] as const;
export const dirtyWorkspaceDecisionValues = [
  "clear_and_continue",
  "continue_current_workspace",
  "plan_only",
  "cancel"
] as const;
export const dirtyWorkspaceStateValues = ["pending_decision"] as const;

const genericBranchStopWords = new Set([
  "a",
  "an",
  "and",
  "app",
  "bug",
  "bugfix",
  "change",
  "changes",
  "chore",
  "code",
  "continue",
  "do",
  "doc",
  "docs",
  "feature",
  "fix",
  "for",
  "hotfix",
  "implement",
  "implementation",
  "in",
  "issue",
  "make",
  "of",
  "on",
  "please",
  "refactor",
  "requested",
  "request",
  "task",
  "the",
  "this",
  "test",
  "tests",
  "to",
  "update",
  "with",
  "work"
]);

function looksLikePlaceholderRepo(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "~/code/your-repo" || normalized === "/path/to/your/repo" || normalized === "your-repo";
}

function remoteHostAndPath(repoRef: string): { host: string; projectPath: string } | undefined {
  const trimmed = repoRef.trim();
  if (!trimmed || trimmed.startsWith("/") || trimmed.startsWith("~/") || /^[A-Za-z]:[\\/]/.test(trimmed)) {
    return undefined;
  }

  const sshMatch = trimmed.match(/^[^@]+@([^:]+):(.+)$/);
  if (sshMatch) {
    return {
      host: sshMatch[1]!.toLowerCase(),
      projectPath: sshMatch[2]!.replace(/\.git$/i, "").replace(/^\/+/, "")
    };
  }

  try {
    const url = new URL(trimmed);
    return {
      host: url.hostname.toLowerCase(),
      projectPath: url.pathname.replace(/\.git$/i, "").replace(/^\/+/, "")
    };
  } catch {
    return undefined;
  }
}

export function inferReviewPlatformFromRepoRef(repoRef: string): ReviewPlatform | undefined {
  const target = remoteHostAndPath(repoRef);
  if (!target?.projectPath) {
    return undefined;
  }

  if (target.host === "gitlab.com" || target.host.includes("gitlab")) {
    return "gitlab";
  }

  if (target.host === "github.com" || target.host.includes("github")) {
    return "github";
  }

  return undefined;
}

function branchWords(value: string, excludedWords?: Set<string>): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((word) => word.trim())
    .filter((word) => word.length > 0)
    .filter((word) => !genericBranchStopWords.has(word))
    .filter((word) => !excludedWords?.has(word));
}

function normalizeBranchDirection(value: string): string | undefined {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  return normalized.length > 0 ? normalized : undefined;
}

function inferBranchDirection(input: { title: string; prompt: string }): string {
  const text = `${input.title} ${input.prompt}`.toLowerCase();
  if (/(bug|fix|error|crash|regression|broken|failure)/.test(text)) {
    return "bugfix";
  }
  if (/(refactor|cleanup|clean up|simplify)/.test(text)) {
    return "refactor";
  }
  if (/(doc|docs|readme|document)/.test(text)) {
    return "docs";
  }
  if (/(test|spec|coverage)/.test(text)) {
    return "test";
  }
  if (/(chore|deps|dependency|build|ci|release|bump)/.test(text)) {
    return "chore";
  }
  return "feature";
}

function buildBranchLeaf(input: { title: string; prompt: string; projectName?: string }): string {
  const excludedWords = new Set(branchWords(input.projectName ?? ""));
  const promptWords = branchWords(input.prompt, excludedWords);
  const titleWords = branchWords(input.title, excludedWords);
  const words = [...promptWords, ...titleWords];
  const uniqueWords = words.filter((word, index) => words.indexOf(word) === index);
  const selectedWords = uniqueWords.slice(0, 4);

  if (selectedWords.length > 0) {
    return selectedWords.join("_");
  }

  return "task_update";
}

function normalizeBranchLeaf(value: string, excludedWords?: Set<string>): string | undefined {
  const words = branchWords(value, excludedWords).slice(0, 4);
  return words.length > 0 ? words.join("_") : undefined;
}

export function normalizeRequestedBranchName(
  value: string | undefined,
  input: { title: string; prompt: string; projectName?: string }
): string | undefined {
  const rawValue = value?.trim();
  if (!rawValue) {
    return undefined;
  }

  const parts = rawValue.split("/").map((part) => part.trim()).filter(Boolean);
  const inferredDirection = inferBranchDirection(input);
  const direction = normalizeBranchDirection(parts.length > 1 ? parts[0] : inferredDirection);
  const excludedWords = new Set(branchWords(input.projectName ?? ""));
  const leafSource = parts.length > 1 ? parts.slice(1).join("_") : parts[0] ?? "";
  const leaf = normalizeBranchLeaf(leafSource, excludedWords);

  if (!direction || !leaf) {
    return undefined;
  }

  return `${direction}/${leaf}`;
}

export function resolveTaskBranchName(input: { branchName?: string; title: string; prompt: string; projectName?: string }): string {
  const requested = normalizeRequestedBranchName(input.branchName, input);
  if (requested) {
    return requested;
  }

  return `${inferBranchDirection(input)}/${buildBranchLeaf(input)}`;
}

export type TaskStatus = (typeof taskStatusValues)[number];
export type ApprovalStatus = (typeof approvalStatusValues)[number];
export type GitAction = (typeof gitActionValues)[number];
export type ProtectedGitCommandKind = (typeof protectedGitCommandKindValues)[number];
export type ReviewMode = (typeof reviewModeValues)[number];
export type TaskExecutionMode = (typeof taskExecutionModeValues)[number];
export type ReviewPlatform = (typeof reviewPlatformValues)[number];
export type DeliveryMode = (typeof deliveryModeValues)[number];
export type TaskBranchMode = (typeof taskBranchModeValues)[number];
export type DirtyWorkspaceDecision = (typeof dirtyWorkspaceDecisionValues)[number];
export type DirtyWorkspaceState = (typeof dirtyWorkspaceStateValues)[number];

export type WorkflowKey = "coding_session";

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
  latestTaskStatus?: TaskStatus;
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

export interface DirectoryCreationReceipt {
  requestId: string;
  presetId: string;
  runnerId: string;
  relativePath: string;
  absolutePath: string;
  createProject: boolean;
  projectName?: string;
  summary: string;
}

export interface WorkflowDefinition {
  key: WorkflowKey;
  displayName: string;
  description: string;
  availableActions: string[];
}

export interface RunnerInfo {
  id: string;
  name: string;
  platform: "macOS";
  isOnline: boolean;
  labels: string[];
  capabilities: string[];
  currentTaskId?: string;
  currentCommandId?: string;
  currentCommandKind?: string;
  currentCommandStartedAt?: string;
  lastHeartbeatAt: string;
  version?: string;
  hostname?: string;
  codexConfigProfiles?: string[];
  activeCodexConfigProfile?: string;
}

export interface CodexConfigState {
  runnerId?: string;
  profiles: string[];
  activeProfileName?: string;
  pendingAction?: "switch" | "create" | "delete";
  pendingProfileName?: string;
}

export interface CodexConfigActionReceipt {
  requestId: string;
  runnerId: string;
  profileName: string;
  summary: string;
}

export interface TaskEvent {
  id: string;
  taskId: string;
  createdAt: string;
  kind: string;
  title: string;
  detail: string;
}

export interface Artifact {
  id: string;
  taskId: string;
  kind: "plan" | "diff" | "tests" | "git" | "handoff";
  title: string;
  summary: string;
  createdAt: string;
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

export interface ApprovalRequest {
  id: string;
  taskId: string;
  type: "plan.execute" | `git.${GitAction}` | `protected_git.${ProtectedGitCommandKind}`;
  title: string;
  detail: string;
  status: ApprovalStatus;
  payload: Record<string, string>;
  createdAt: string;
  resolvedAt?: string;
}

export interface TaskRecord {
  id: string;
  workflowKey: WorkflowKey;
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
  status: TaskStatus;
  runnerId?: string;
  sessionAlias: string;
  summary: string;
  reportURL?: string;
  lastPublishedAt?: string;
  latestResultSummary?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskSnapshot extends TaskRecord {
  approvals: ApprovalRequest[];
  artifacts: Artifact[];
  events: TaskEvent[];
  executorSession?: ExecutorSession;
}

export const createTaskSchema = z
  .object({
    workflowKey: z.literal("coding_session"),
    deliveryMode: z.enum(deliveryModeValues).default("review_required"),
    autoPush: z.boolean().default(true),
    title: z.string().trim().min(1),
    prompt: z.string().trim().min(1),
    repo: z.string().trim().min(1),
    baseBranch: z.string().trim().min(1).default("main"),
    branchMode: z.enum(taskBranchModeValues).default("new_branch"),
    branchName: z.string().trim().min(1).optional(),
    projectId: z.string().trim().min(1).optional(),
    projectName: z.string().trim().min(1).optional(),
    executionMode: z.enum(taskExecutionModeValues).default("new_thread"),
    resumeThreadId: z.string().trim().min(1).optional(),
    allowParallel: z.boolean().optional()
  })
  .superRefine((value, context) => {
    if (looksLikePlaceholderRepo(value.repo)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "repo must be a real local repository path or a real Git remote",
        path: ["repo"]
      });
    }

    if (value.branchMode === "current_branch" && value.branchName) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "branchName must be empty when branchMode is current_branch",
        path: ["branchName"]
      });
    }

    if (value.branchMode === "new_branch" && value.branchName && !normalizeRequestedBranchName(value.branchName, value)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "branchName must look like direction/change_summary, for example bugfix/detail_number_display",
        path: ["branchName"]
      });
    }
  });

export const taskMessageSchema = z.object({
  message: z.string().trim().min(1)
});

export const createProjectTaskSchema = z
  .object({
    deliveryMode: z.enum(deliveryModeValues).optional(),
    autoPush: z.boolean().optional(),
    title: z.string().trim().min(1),
    prompt: z.string().trim().min(1),
    branchMode: z.enum(taskBranchModeValues).default("new_branch"),
    branchName: z.string().trim().min(1).optional(),
    executionMode: z.enum(taskExecutionModeValues).default("new_thread"),
    resumeThreadId: z.string().trim().min(1).optional(),
    allowParallel: z.boolean().optional()
  })
  .superRefine((value, context) => {
    if (value.branchMode === "current_branch" && value.branchName) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "branchName must be empty when branchMode is current_branch",
        path: ["branchName"]
      });
    }

    if (value.branchMode === "new_branch" && value.branchName && !normalizeRequestedBranchName(value.branchName, value)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "branchName must look like direction/change_summary, for example feature/item_ui",
        path: ["branchName"]
      });
    }
  });

export const gitActionSchema = z.object({
  message: z.string().trim().optional(),
  title: z.string().trim().optional(),
  targetBranch: z.string().trim().min(1).optional(),
  reviewMode: z.enum(reviewModeValues).optional()
});

export const dirtyWorkspaceDecisionSchema = z.object({
  decision: z.enum(dirtyWorkspaceDecisionValues)
});

export const approvalDecisionSchema = z.object({
  decision: z.enum(["approve", "deny"])
});

export const protectedGitCommandSchema = z.object({
  kind: z.enum(protectedGitCommandKindValues),
  args: z.array(z.string().trim().min(1)).min(2).max(20)
});

export const pairingStartSchema = z.object({
  deviceName: z.string().trim().min(1),
  platform: z.literal("ios")
});

export const pairingCompleteSchema = z.object({
  code: z.string().trim().min(1)
});

export const runnerHelloSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  platform: z.literal("macOS"),
  labels: z.array(z.string().trim().min(1)).default([]),
  capabilities: z.array(z.string().trim().min(1)).default([]),
  version: z.string().trim().min(1).optional(),
  hostname: z.string().trim().min(1).optional(),
  codexConfigProfiles: z.array(z.string().trim().min(1)).max(100).optional(),
  activeCodexConfigProfile: z.string().trim().min(1).optional()
});

export const runnerHeartbeatSchema = z.object({
  currentTaskId: z.string().trim().min(1).optional(),
  currentCommandId: z.string().trim().min(1).optional(),
  currentCommandKind: z.string().trim().min(1).optional(),
  currentCommandStartedAt: z.string().datetime().optional(),
  version: z.string().trim().min(1).optional(),
  hostname: z.string().trim().min(1).optional(),
  codexConfigProfiles: z.array(z.string().trim().min(1)).max(100).optional(),
  activeCodexConfigProfile: z.string().trim().min(1).optional()
});

const runnerCommandIdentitySchema = z.object({
  commandId: z.string().trim().min(1).optional(),
  claimToken: z.string().trim().min(1).optional()
});

export const runnerProjectSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  repo: z.string().trim().min(1),
  baseBranch: z.string().trim().min(1),
  deliveryMode: z.enum(deliveryModeValues).default("review_required"),
  autoPush: z.boolean().default(true),
  defaultTaskTitle: z.string().trim().min(1),
  defaultPrompt: z.string().trim().min(1),
  isFeatured: z.boolean().default(false)
});

export const runnerProjectSyncSchema = z.object({
  projects: z.array(runnerProjectSchema).max(100)
});

export const runnerDirectoryPresetSchema = z.object({
  id: z.string().trim().min(1),
  label: z.string().trim().min(1),
  rootPath: z.string().trim().min(1)
});

export const runnerDirectorySyncSchema = z.object({
  presets: z.array(runnerDirectoryPresetSchema).max(100)
});

export const createDirectorySchema = z
  .object({
    presetId: z.string().trim().min(1),
    relativePath: z.string().trim().min(1),
    createProject: z.boolean().default(true),
    projectName: z.string().trim().min(1).optional(),
    baseBranch: z.string().trim().min(1).default("main"),
    deliveryMode: z.enum(deliveryModeValues).default("direct_commit"),
    autoPush: z.boolean().default(false),
    defaultTaskTitle: z.string().trim().min(1).optional(),
    defaultPrompt: z.string().trim().optional()
  })
  .superRefine((value, context) => {
    if (value.relativePath.startsWith("/") || value.relativePath.startsWith("~")) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "relativePath must stay relative to the selected directory preset",
        path: ["relativePath"]
      });
    }

    if (value.relativePath.split(/[\\/]+/).some((segment) => segment === "..")) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "relativePath cannot contain parent-directory traversal",
        path: ["relativePath"]
      });
    }
  });

export const switchCodexConfigSchema = z.object({
  profileName: z.string().trim().min(1)
}).superRefine((value, context) => {
  if (value.profileName.toLowerCase() === "none") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "profileName cannot be none",
      path: ["profileName"]
    });
  }

  if (/[\\/]/.test(value.profileName) || value.profileName === "." || value.profileName === "..") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "profileName must not contain path separators",
      path: ["profileName"]
    });
  }
});

export const deleteCodexConfigSchema = z.object({
  profileName: z.string().trim().min(1)
}).superRefine((value, context) => {
  if (value.profileName.toLowerCase() === "none") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "profileName cannot be none",
      path: ["profileName"]
    });
  }

  if (/[\\/]/.test(value.profileName) || value.profileName === "." || value.profileName === "..") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "profileName must not contain path separators",
      path: ["profileName"]
    });
  }
});

export const createCodexConfigSchema = z.object({
  profileName: z.string().trim().min(1),
  baseURL: z.string().trim().url(),
  apiKey: z.string().trim().min(1)
}).superRefine((value, context) => {
  if (value.profileName.toLowerCase() === "none") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "profileName cannot be none",
      path: ["profileName"]
    });
  }

  if (/[\\/]/.test(value.profileName) || value.profileName === "." || value.profileName === "..") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "profileName must not contain path separators",
      path: ["profileName"]
    });
  }
});

export const runnerUtilityCompletionSchema = z.object({
  claimToken: z.string().trim().min(1).optional(),
  outcome: z.enum(["completed", "failed"]),
  message: z.string().trim().optional(),
  absolutePath: z.string().trim().min(1).optional(),
  codexConfigProfiles: z.array(z.string().trim().min(1)).max(100).optional(),
  activeCodexConfigProfile: z.string().trim().min(1).optional()
});

export const artifactInputSchema = z.object({
  kind: z.enum(["plan", "diff", "tests", "git", "handoff"]),
  title: z.string().trim().min(1),
  summary: z.string().trim().min(1)
});

export const runnerSessionStateSchema = z.object({
  executorType: z.enum(["codex_app_server", "codex_cli"]),
  threadId: z.string().trim().min(1),
  cwd: z.string().trim().min(1),
  materializedFromHistory: z.boolean(),
  lastTurnAt: z.string().trim().min(1)
});

export const runnerSessionPatchSchema = runnerSessionStateSchema.partial();

export const runnerLogSchema = runnerCommandIdentitySchema.extend({
  kind: z.string().trim().min(1),
  title: z.string().trim().min(1),
  detail: z.string().trim().min(1),
  status: z.enum(taskStatusValues).optional(),
  summary: z.string().trim().min(1).optional(),
  branchName: z.string().trim().min(1).optional(),
  executionBranch: z.string().trim().min(1).optional(),
  reviewPlatform: z.enum(reviewPlatformValues).optional(),
  reviewTargetBranches: z.array(z.string().trim().min(1)).max(100).optional(),
  artifact: artifactInputSchema.optional(),
  session: runnerSessionPatchSchema.optional()
});

export const runnerCompletionSchema = z.discriminatedUnion("outcome", [
  runnerCommandIdentitySchema.extend({
    outcome: z.literal("plan_ready"),
    planSummary: z.string().trim().min(1),
    reportURL: z.string().trim().url().optional(),
    lastPublishedAt: z.string().trim().min(1).optional(),
    session: runnerSessionStateSchema
  }),
  runnerCommandIdentitySchema.extend({
    outcome: z.literal("turn_complete"),
    summary: z.string().trim().min(1),
    testsSummary: z.string().trim().min(1).optional(),
    implementationCommitCreated: z.boolean().optional(),
    workspaceIsGitRepository: z.boolean().optional(),
    session: runnerSessionPatchSchema.optional(),
    reportURL: z.string().trim().url().optional(),
    lastPublishedAt: z.string().trim().min(1).optional(),
    latestResultSummary: z.string().trim().min(1).optional()
  }),
  runnerCommandIdentitySchema.extend({
    outcome: z.literal("handoff_completed"),
    summary: z.string().trim().min(1)
  }),
  runnerCommandIdentitySchema.extend({
    outcome: z.literal("git_completed"),
    action: z.enum(gitActionValues),
    summary: z.string().trim().min(1),
    reportURL: z.string().trim().url().optional(),
    lastPublishedAt: z.string().trim().min(1).optional(),
    latestResultSummary: z.string().trim().min(1).optional()
  }),
  runnerCommandIdentitySchema.extend({
    outcome: z.literal("dirty_workspace_detected"),
    summary: z.string().trim().min(1),
    currentBranch: z.string().trim().min(1).optional(),
    statusSummary: z.string().trim().min(1).optional(),
    reviewPlatform: z.enum(reviewPlatformValues).optional(),
    reviewTargetBranches: z.array(z.string().trim().min(1)).max(100).optional(),
    reportURL: z.string().trim().url().optional(),
    lastPublishedAt: z.string().trim().min(1).optional(),
    latestResultSummary: z.string().trim().min(1).optional()
  }),
  runnerCommandIdentitySchema.extend({
    outcome: z.literal("workspace_inspected_clean"),
    summary: z.string().trim().min(1),
    currentBranch: z.string().trim().min(1).optional(),
    statusSummary: z.string().trim().min(1).optional(),
    reviewPlatform: z.enum(reviewPlatformValues).optional(),
    reviewTargetBranches: z.array(z.string().trim().min(1)).max(100).optional(),
    reportURL: z.string().trim().url().optional(),
    lastPublishedAt: z.string().trim().min(1).optional(),
    latestResultSummary: z.string().trim().min(1).optional()
  }),
  runnerCommandIdentitySchema.extend({
    outcome: z.literal("protected_git_command_blocked"),
    summary: z.string().trim().min(1),
    protectedGitCommand: protectedGitCommandSchema,
    session: runnerSessionPatchSchema.optional()
  }),
  runnerCommandIdentitySchema.extend({
    outcome: z.literal("failed"),
    summary: z.string().trim().min(1),
    detail: z.string().trim().min(1).optional()
  }),
  runnerCommandIdentitySchema.extend({
    outcome: z.literal("canceled"),
    summary: z.string().trim().min(1),
    detail: z.string().trim().min(1).optional()
  })
]);

export type RunnerLogInput = z.infer<typeof runnerLogSchema>;
export type RunnerCompletionInput = z.infer<typeof runnerCompletionSchema>;

export type RunnerCommandKind =
  | "generate_plan"
  | "continue_prompt"
  | "open_in_codex_app"
  | "inspect_workspace"
  | "resolve_dirty_workspace"
  | `git.${GitAction}`;

export interface ProtectedGitCommand {
  kind: ProtectedGitCommandKind;
  args: string[];
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
