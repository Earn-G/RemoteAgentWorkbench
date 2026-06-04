import os from "node:os";
import path from "node:path";

export const DEFAULT_RUNNER_VERSION = "0.1.0";
export const DEFAULT_CODEX_PROTECTED_PROFILE_NAMES = ["1000", "plus"] as const;

type RunnerPlatform = "macOS";

export interface RunnerIdentityConfig {
  id: string;
  name: string;
  platform: RunnerPlatform;
  labels: string[];
  capabilities: string[];
  version: string;
}

export interface RunnerTimingConfig {
  heartbeatIntervalMs: number;
  pollIntervalMs: number;
  localTaskRetentionDays: number;
  codexRunTimeoutMs: number;
  gitPushTimeoutMs: number;
}

export interface WorkbenchPathsConfig {
  dataRoot: string;
  repoCacheDir: string;
  workspaceDir: string;
  tasksDir: string;
  lockRootDir: string;
  requestJournalPath: string;
  projectsFilePath: string;
  directoriesFilePath: string;
}

export interface GitLabConfig {
  baseURL: string;
  token: string;
}

export interface ReportPublishingConfig {
  repoURL: string;
  branch: string;
  repoDir: string;
  publicBaseURL: string;
  rootDir: string;
}

export interface CodexConfig {
  configuredHome: string;
  liveDirectory: string;
  profilesRoot: string;
  profileTemplate: string;
  protectedProfileNames: string[];
  restartTimeoutMs: number;
  restartPollIntervalMs: number;
}

export interface RunnerConfigSummary {
  serverBaseURL: string;
  runnerSharedSecretConfigured: boolean;
  identity: RunnerIdentityConfig;
  timings: RunnerTimingConfig;
  paths: WorkbenchPathsConfig;
  gitlab: {
    baseURL: string;
    tokenConfigured: boolean;
  };
  reports: {
    repoURL: string;
    branch: string;
    repoDir: string;
    publicBaseURL: string;
    rootDir: string;
    enabled: boolean;
  };
  codex: CodexConfig;
}

function expandHomeDirectory(input: string, homeDirectory = os.homedir()): string {
  const trimmed = input.trim();
  if (trimmed === "~") {
    return homeDirectory;
  }
  if (trimmed.startsWith("~/")) {
    return path.join(homeDirectory, trimmed.slice(2));
  }
  return trimmed;
}

function normalizePath(input: string, homeDirectory = os.homedir()): string {
  const expanded = expandHomeDirectory(input, homeDirectory);
  return path.resolve(expanded);
}

function normalizeOptionalPath(input: string | undefined, homeDirectory = os.homedir()): string {
  if (!input || input.trim().length === 0) {
    return "";
  }
  return normalizePath(input, homeDirectory);
}

function normalizeRequiredPath(value: string | undefined, fallback: string, fieldName: string): string {
  const candidate = value?.trim().length ? value : fallback;
  const normalized = normalizeOptionalPath(candidate);
  if (!normalized) {
    throw new Error(`[runner config] ${fieldName} must not be empty`);
  }
  return normalized;
}

function normalizeOptionalURL(value: string | undefined, fieldName: string): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return "";
  }
  try {
    return new URL(trimmed).toString().replace(/\/$/, "");
  } catch {
    throw new Error(`[runner config] ${fieldName} must be a valid URL`);
  }
}

function normalizeRequiredURL(value: string | undefined, fallback: string, fieldName: string): string {
  return normalizeOptionalURL(value?.trim().length ? value : fallback, fieldName);
}

function normalizePositiveInteger(value: string | undefined, fallback: number, fieldName: string): number {
  const candidate = Number(value ?? fallback);
  if (!Number.isInteger(candidate) || candidate <= 0) {
    throw new Error(`[runner config] ${fieldName} must be a positive integer`);
  }
  return candidate;
}

function splitCSV(input: string | undefined, fallback: string[]): string[] {
  const candidate = input?.trim();
  if (!candidate) {
    return [...fallback];
  }
  const unique = Array.from(new Set(candidate.split(",").map((value) => value.trim()).filter(Boolean)));
  return unique.length > 0 ? unique : [...fallback];
}

function resolveLiveCodexDirectory(configuredCodexHome: string, homeDirectory = os.homedir()): string {
  const normalized = normalizeOptionalPath(configuredCodexHome, homeDirectory);
  return normalized || path.join(homeDirectory, ".codex");
}

export class RunnerConfig {
  readonly identity: RunnerIdentityConfig;
  readonly timings: RunnerTimingConfig;
  readonly paths: WorkbenchPathsConfig;
  readonly gitlab: GitLabConfig;
  readonly reports: ReportPublishingConfig;
  readonly codex: CodexConfig;

  serverBaseURL: string;
  runnerSharedSecret: string;
  runnerId: string;
  runnerName: string;
  runnerPlatform: RunnerPlatform;
  runnerLabels: string[];
  runnerCapabilities: string[];
  runnerVersion: string;
  heartbeatIntervalMs: number;
  pollIntervalMs: number;
  dataRoot: string;
  repoCacheDir: string;
  workspaceDir: string;
  tasksDir: string;
  localTaskRetentionDays: number;
  projectsFilePath: string;
  directoriesFilePath: string;
  codexHome: string;
  codexProfilesRoot: string;
  codexProfileTemplate: string;
  lockRootDir: string;
  codexRunTimeoutMs: number;
  gitPushTimeoutMs: number;

  constructor(input: {
    serverBaseURL: string;
    runnerSharedSecret: string;
    identity: RunnerIdentityConfig;
    timings: RunnerTimingConfig;
    paths: WorkbenchPathsConfig;
    gitlab: GitLabConfig;
    reports: ReportPublishingConfig;
    codex: CodexConfig;
  }) {
    this.serverBaseURL = input.serverBaseURL;
    this.runnerSharedSecret = input.runnerSharedSecret;
    this.identity = input.identity;
    this.timings = input.timings;
    this.paths = input.paths;
    this.gitlab = input.gitlab;
    this.reports = input.reports;
    this.codex = input.codex;

    this.runnerId = input.identity.id;
    this.runnerName = input.identity.name;
    this.runnerPlatform = input.identity.platform;
    this.runnerLabels = input.identity.labels;
    this.runnerCapabilities = input.identity.capabilities;
    this.runnerVersion = input.identity.version;

    this.heartbeatIntervalMs = input.timings.heartbeatIntervalMs;
    this.pollIntervalMs = input.timings.pollIntervalMs;
    this.localTaskRetentionDays = input.timings.localTaskRetentionDays;
    this.codexRunTimeoutMs = input.timings.codexRunTimeoutMs;
    this.gitPushTimeoutMs = input.timings.gitPushTimeoutMs;

    this.dataRoot = input.paths.dataRoot;
    this.repoCacheDir = input.paths.repoCacheDir;
    this.workspaceDir = input.paths.workspaceDir;
    this.tasksDir = input.paths.tasksDir;
    this.lockRootDir = input.paths.lockRootDir;
    this.projectsFilePath = input.paths.projectsFilePath;
    this.directoriesFilePath = input.paths.directoriesFilePath;

    this.codexHome = input.codex.configuredHome;
    this.codexProfilesRoot = input.codex.profilesRoot;
    this.codexProfileTemplate = input.codex.profileTemplate;
  }

  toSummary(): RunnerConfigSummary {
    return {
      serverBaseURL: this.serverBaseURL,
      runnerSharedSecretConfigured: this.runnerSharedSecret.trim().length > 0,
      identity: {
        ...this.identity,
        labels: [...this.identity.labels],
        capabilities: [...this.identity.capabilities]
      },
      timings: { ...this.timings },
      paths: { ...this.paths },
      gitlab: {
        baseURL: this.gitlab.baseURL,
        tokenConfigured: this.gitlab.token.trim().length > 0
      },
      reports: {
        repoURL: this.reports.repoURL,
        branch: this.reports.branch,
        repoDir: this.reports.repoDir,
        publicBaseURL: this.reports.publicBaseURL,
        rootDir: this.reports.rootDir,
        enabled: this.reports.repoURL.trim().length > 0
      },
      codex: {
        ...this.codex,
        protectedProfileNames: [...this.codex.protectedProfileNames]
      }
    };
  }
}

export function createRunnerConfig(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  const homeDirectory = os.homedir();
  const dataRoot = normalizeRequiredPath(
    env.RUNNER_DATA_ROOT,
    path.join(homeDirectory, "RemoteAgentWorkbenchData"),
    "RUNNER_DATA_ROOT"
  );

  const paths: WorkbenchPathsConfig = {
    dataRoot,
    repoCacheDir: normalizeRequiredPath(env.RUNNER_REPO_CACHE_DIR, path.join(dataRoot, "repos"), "RUNNER_REPO_CACHE_DIR"),
    workspaceDir: normalizeRequiredPath(env.RUNNER_WORKSPACE_DIR, path.join(dataRoot, "worktrees"), "RUNNER_WORKSPACE_DIR"),
    tasksDir: normalizeRequiredPath(env.RUNNER_TASKS_DIR, path.join(dataRoot, "tasks"), "RUNNER_TASKS_DIR"),
    lockRootDir: normalizeRequiredPath(env.RUNNER_LOCK_ROOT_DIR, path.join(dataRoot, "locks"), "RUNNER_LOCK_ROOT_DIR"),
    requestJournalPath: normalizeRequiredPath(
      env.RUNNER_REQUEST_JOURNAL_PATH,
      path.join(dataRoot, "logs", "runner-requests.jsonl"),
      "RUNNER_REQUEST_JOURNAL_PATH"
    ),
    projectsFilePath: normalizeRequiredPath(
      env.RUNNER_PROJECTS_FILE,
      path.join(dataRoot, "projects.json"),
      "RUNNER_PROJECTS_FILE"
    ),
    directoriesFilePath: normalizeRequiredPath(
      env.RUNNER_DIRECTORIES_FILE,
      path.join(dataRoot, "directories.json"),
      "RUNNER_DIRECTORIES_FILE"
    )
  };

  const codexConfiguredHome = normalizeOptionalPath(env.RUNNER_CODEX_HOME, homeDirectory);
  const codex: CodexConfig = {
    configuredHome: codexConfiguredHome,
    liveDirectory: resolveLiveCodexDirectory(codexConfiguredHome, homeDirectory),
    profilesRoot: normalizeRequiredPath(
      env.RUNNER_CODEX_PROFILES_ROOT,
      path.join(homeDirectory, "Desktop", "codex config"),
      "RUNNER_CODEX_PROFILES_ROOT"
    ),
    profileTemplate: env.RUNNER_CODEX_PROFILE_TEMPLATE?.trim() || "1000",
    protectedProfileNames: [...DEFAULT_CODEX_PROTECTED_PROFILE_NAMES],
    restartTimeoutMs: normalizePositiveInteger(
      env.RUNNER_CODEX_RESTART_TIMEOUT_MS,
      5000,
      "RUNNER_CODEX_RESTART_TIMEOUT_MS"
    ),
    restartPollIntervalMs: normalizePositiveInteger(
      env.RUNNER_CODEX_RESTART_POLL_INTERVAL_MS,
      100,
      "RUNNER_CODEX_RESTART_POLL_INTERVAL_MS"
    )
  };

  const identity: RunnerIdentityConfig = {
    id: env.RUNNER_ID?.trim() || "runner-local-mac",
    name: env.RUNNER_NAME?.trim() || "Local Mac Runner",
    platform: "macOS",
    labels: splitCSV(env.RUNNER_LABELS, ["local", "mac", "codex"]),
    capabilities: splitCSV(env.RUNNER_CAPABILITIES, ["codex_app_server", "codex_cli", "git_guard", "xcodebuild"]),
    version: env.RUNNER_VERSION?.trim() || DEFAULT_RUNNER_VERSION
  };

  const timings: RunnerTimingConfig = {
    heartbeatIntervalMs: normalizePositiveInteger(
      env.RUNNER_HEARTBEAT_INTERVAL_MS,
      15000,
      "RUNNER_HEARTBEAT_INTERVAL_MS"
    ),
    pollIntervalMs: normalizePositiveInteger(env.RUNNER_POLL_INTERVAL_MS, 4000, "RUNNER_POLL_INTERVAL_MS"),
    localTaskRetentionDays: normalizePositiveInteger(
      env.RUNNER_LOCAL_TASK_RETENTION_DAYS,
      30,
      "RUNNER_LOCAL_TASK_RETENTION_DAYS"
    ),
    gitPushTimeoutMs: normalizePositiveInteger(
      env.RUNNER_GIT_PUSH_TIMEOUT_MS,
      120000,
      "RUNNER_GIT_PUSH_TIMEOUT_MS"
    ),
    codexRunTimeoutMs: normalizePositiveInteger(
      env.RUNNER_CODEX_RUN_TIMEOUT_MS,
      1800000,
      "RUNNER_CODEX_RUN_TIMEOUT_MS"
    )
  };

  const gitlab: GitLabConfig = {
    baseURL: normalizeRequiredURL(env.GITLAB_BASE_URL, "https://gitlab.com", "GITLAB_BASE_URL"),
    token: env.GITLAB_TOKEN?.trim() ?? ""
  };

  const reports: ReportPublishingConfig = {
    repoURL: env.RUNNER_REPORTS_REPO_URL?.trim() ?? "",
    branch: env.RUNNER_REPORTS_BRANCH?.trim() || "main",
    repoDir: normalizeRequiredPath(
      env.RUNNER_REPORTS_REPO_DIR,
      path.join(dataRoot, "report-publisher"),
      "RUNNER_REPORTS_REPO_DIR"
    ),
    publicBaseURL: normalizeOptionalURL(env.RUNNER_REPORTS_PUBLIC_BASE_URL, "RUNNER_REPORTS_PUBLIC_BASE_URL"),
    rootDir: env.RUNNER_REPORTS_ROOT_DIR?.trim() || "plans"
  };

  return new RunnerConfig({
    serverBaseURL: normalizeRequiredURL(env.SERVER_BASE_URL, "http://127.0.0.1:8787", "SERVER_BASE_URL"),
    runnerSharedSecret: env.RUNNER_SHARED_SECRET?.trim() ?? "",
    identity,
    timings,
    paths,
    gitlab,
    reports,
    codex
  });
}

export const config = createRunnerConfig();
