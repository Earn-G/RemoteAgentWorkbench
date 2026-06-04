import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "./config.js";
import type { TaskSnapshot } from "./models.js";
import { FileLockManager } from "./fileLock.js";
import { TaskHistoryRecorder } from "./taskHistory.js";
import { formatBeijingDateTime, formatBeijingFileTimestamp } from "./time.js";

const execFileAsync = promisify(execFile);
const GIT_COMMAND_MAX_BUFFER = 10 * 1024 * 1024;

interface GitCommandError extends Error {
  killed?: boolean;
  signal?: NodeJS.Signals | null;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
}

interface ReportCodeDiff {
  branchName?: string;
  baseRef?: string;
  compareRef?: string;
  diffStat?: string;
  diffPatch?: string;
}

interface GitExecOptions {
  signal?: AbortSignal;
  timeout?: number;
}

export interface DirtyWorkspaceSnapshot {
  currentBranch?: string;
  headCommit?: string;
  statusPorcelain?: string;
  trackedDiffStat?: string;
  trackedDiffPatch?: string;
  untrackedFiles?: string[];
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "project";
}

function normalizeRelativeNamespace(value: string): string {
  return value
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && segment !== "." && segment !== "..")
    .map((segment) => slugify(segment))
    .filter(Boolean)
    .join("/") || "unscoped";
}

function maybeGitHubWebBase(repoURL: string): string | undefined {
  const trimmed = repoURL.trim();
  if (!trimmed) {
    return undefined;
  }

  if (trimmed.startsWith("git@github.com:")) {
    return `https://github.com/${trimmed.replace("git@github.com:", "").replace(/\.git$/i, "")}`;
  }

  if (trimmed.startsWith("https://github.com/") || trimmed.startsWith("http://github.com/")) {
    return trimmed.replace(/\.git$/i, "").replace(/^http:\/\//i, "https://");
  }

  return undefined;
}

function maybeGitLabWebBase(repoURL: string): string | undefined {
  const trimmed = repoURL.trim();
  if (!trimmed) {
    return undefined;
  }

  if (trimmed.startsWith("git@gitlab.com:")) {
    return `https://gitlab.com/${trimmed.replace("git@gitlab.com:", "").replace(/\.git$/i, "")}`;
  }

  if (trimmed.startsWith("https://gitlab.com/") || trimmed.startsWith("http://gitlab.com/")) {
    return trimmed.replace(/\.git$/i, "").replace(/^http:\/\//i, "https://");
  }

  return undefined;
}

function repositoryLabel(repoRef: string): string {
  const trimmed = repoRef.trim().replace(/[\\/]+$/, "");
  if (!trimmed) {
    return "project";
  }

  const sshMatch = trimmed.match(/^[^@]+@[^:]+:(.+)$/);
  if (sshMatch?.[1]) {
    return slugify(path.posix.basename(sshMatch[1].replace(/\.git$/i, "")));
  }

  try {
    const url = new URL(trimmed);
    return slugify(path.posix.basename(url.pathname.replace(/\.git$/i, "")));
  } catch {
    return slugify(path.basename(trimmed.replace(/\.git$/i, "")));
  }
}

function reportBranchLabel(task: TaskSnapshot, executionBranch?: string): string {
  return slugify(executionBranch ?? task.executionBranch ?? task.branchName ?? task.baseBranch);
}

function buildReportRelativePath(
  task: TaskSnapshot,
  _rootDir: string | undefined,
  _reportNamespace: string,
  options?: { executionBranch?: string }
): string {
  const fileName = [
    repositoryLabel(task.repo),
    reportBranchLabel(task, options?.executionBranch),
    slugify(task.id),
    formatBeijingFileTimestamp(task.createdAt)
  ].join("_");

  return `${fileName}.md`;
}

function isAbortError(error: unknown): boolean {
  const typed = error as { name?: string; code?: number | string };
  return typed?.name === "AbortError" || typed?.code === "ABORT_ERR";
}

async function execGit(args: string[], cwd?: string, options?: GitExecOptions): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    ...(cwd ? { cwd } : {}),
    ...(options?.signal ? { signal: options.signal } : {}),
    ...(options?.timeout ? { timeout: options.timeout } : {}),
    maxBuffer: GIT_COMMAND_MAX_BUFFER
  });
  return stdout.toString().trim();
}

async function execGitRaw(args: string[], cwd?: string, options?: GitExecOptions): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    ...(cwd ? { cwd } : {}),
    ...(options?.signal ? { signal: options.signal } : {}),
    ...(options?.timeout ? { timeout: options.timeout } : {}),
    maxBuffer: GIT_COMMAND_MAX_BUFFER
  });
  return stdout.toString();
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function renderProcessOutput(value: string | Buffer | undefined): string {
  if (!value) {
    return "";
  }

  return value.toString().trim();
}

function normalizeGitErrorDetail(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("Command failed:"))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function errorIncludesAny(haystack: string, needles: string[]): boolean {
  return needles.some((needle) => haystack.includes(needle));
}

async function hasPrePushHook(repoPath: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const hookPath = await execGit(["-C", repoPath, "rev-parse", "--git-path", "hooks/pre-push"], undefined, { signal });
    const resolvedHookPath = path.isAbsolute(hookPath) ? hookPath : path.join(repoPath, hookPath);
    return pathExists(resolvedHookPath);
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    return false;
  }
}

function describeReportPushFailure(error: unknown, branchName: string, hookPresent: boolean): string {
  const typed = error as GitCommandError;
  const detail = normalizeGitErrorDetail([
    renderProcessOutput(typed.stderr),
    renderProcessOutput(typed.stdout),
    typed.message ?? ""
  ].join("\n"));
  const detailLower = detail.toLowerCase();
  const timedOut = typed.killed === true || typed.signal === "SIGTERM" || detailLower.includes("timed out");
  const hookNote = hookPresent ? " A local pre-push hook is present in the reports repository." : "";

  if (timedOut) {
    return (
      "The runner timed out while pushing the reports repository. " +
      "This usually means a local Git hook is scanning too much history or waiting for interactive input." +
      " The runner does not bypass Git hooks automatically." +
      hookNote
    );
  }

  if (
    errorIncludesAny(detailLower, [
      "permission denied",
      "authentication failed",
      "could not read from remote repository",
      "not authorized",
      "repository not found",
      "access denied"
    ])
  ) {
    return "The runner could not authenticate to the reports repository origin. Check the runner's SSH key or HTTPS credentials for that remote.";
  }

  if (errorIncludesAny(detailLower, ["protected branch", "pre-receive hook declined", "deny updating"])) {
    return "The reports repository rejected the push because of branch protection or a server-side hook.";
  }

  if (
    errorIncludesAny(detailLower, [
      "non-fast-forward",
      "fetch first",
      "updates were rejected because the remote contains work that you do not have locally"
    ])
  ) {
    return (
      `The reports repository branch ${branchName} has remote commits that are missing locally. ` +
      "The runner will not force-push automatically. Fetch or rebase the reports repo, then try again."
    );
  }

  if (errorIncludesAny(detailLower, ["pre-push hook", "pre-push", "hook blocked", "rejected by hook"])) {
    return (
      "A local pre-push hook in the reports repository rejected the push. " +
      "The runner does not bypass Git hooks automatically, so report publication stopped before changing the remote."
    );
  }

  if (detail) {
    return `The runner could not push the reports repository. Git reported: ${detail}`;
  }

  return "The runner could not push the reports repository.";
}

async function resolveBaseRef(repoPath: string, baseBranch: string, signal?: AbortSignal): Promise<string> {
  try {
    await execGit(["-C", repoPath, "rev-parse", "--verify", `origin/${baseBranch}`], undefined, { signal });
    return `origin/${baseBranch}`;
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    return baseBranch;
  }
}

function cleanDiffOutput(value?: string): string | undefined {
  const normalized = value?.trimEnd();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function formatDiffScope(codeDiff: ReportCodeDiff): string {
  return [
    `- Execution Branch: ${codeDiff.branchName ?? "Unknown"}`,
    `- Base Branch: ${codeDiff.baseRef ?? "Unknown"}`,
    `- Compared From: ${codeDiff.compareRef ?? codeDiff.baseRef ?? "Unknown"}`
  ].join("\n");
}

function formatDirtyWorkspaceScope(snapshot: DirtyWorkspaceSnapshot): string {
  return [
    `- Current Branch: ${snapshot.currentBranch ?? "Unknown"}`,
    `- HEAD: ${snapshot.headCommit ?? "Unknown"}`
  ].join("\n");
}

function buildReportMarkdown(
  task: TaskSnapshot,
  events: Array<{ kind: string; title: string; detail: string; recordedAt: string }>,
  options?: {
    codeDiff?: ReportCodeDiff;
    dirtyWorkspaceSnapshot?: DirtyWorkspaceSnapshot;
    executionBranch?: string;
    reportRelativePath?: string;
    publishedAt?: string;
  }
): string {
  const hasKind = (kind: string, accepted: string[]) => accepted.includes(kind);
  const planEvents = events.filter((event) => hasKind(event.kind, ["plan.generated", "plan_ready"]));
  const implementationEvents = events.filter((event) => hasKind(event.kind, ["codex.turn_complete", "turn_complete"]));
  const gitEvents = events.filter((event) => hasKind(event.kind, ["git.completed", "git_completed"]));
  const failureEvents = events.filter((event) => hasKind(event.kind, ["task.failed", "assignment_failed", "failed"]));
  const validationArtifacts = task.artifacts.filter((artifact) => artifact.kind === "tests");
  const latestPlan = planEvents.at(-1);
    const latestPlanText = latestPlan?.detail ?? task.artifacts.find((artifact) => artifact.kind === "plan")?.summary;
    const latestPlanHeading = task.deliveryMode === "direct_commit" ? "## Latest Execution Plan" : "## Latest Approved Plan";

  const sections: string[] = [
    `# ${task.title}`,
    "",
    `- Project: ${task.projectName ?? task.projectId ?? "Unscoped"}`,
    `- Task ID: ${task.id}`,
    `- Status: ${task.status}`,
    `- Runner: ${task.runnerId ?? "Unknown"}`,
    `- Task Updated At: ${formatBeijingDateTime(task.updatedAt)}`,
    `- Report Updated At: ${formatBeijingDateTime(options?.publishedAt ?? task.updatedAt)}`,
    `- Repository: ${task.repo}`,
    `- Base Branch: ${task.baseBranch}`
  ];

  const executionBranch = options?.executionBranch ?? options?.codeDiff?.branchName;
  if (executionBranch) {
    sections.push(`- Execution Branch: ${executionBranch}`);
  }

  if (task.reportURL) {
    sections.push(`- Report URL: ${task.reportURL}`);
  }

  if (options?.reportRelativePath) {
    sections.push(`- Report Path: ${options.reportRelativePath}`);
  }

  if (task.executorSession?.threadId) {
    sections.push(`- Codex Thread: ${task.executorSession.threadId}`);
  }

  if (task.executorSession?.cwd) {
    sections.push(`- Workspace: ${task.executorSession.cwd}`);
  }

  sections.push("", "## Original Request", "", task.prompt);

  if (task.latestResultSummary) {
    sections.push("", "## Latest Result Summary", "", task.latestResultSummary);
  }

  if (latestPlanText) {
    sections.push("", latestPlanHeading, "", latestPlanText);
  }

  if (options?.dirtyWorkspaceSnapshot) {
    sections.push("", "## Dirty Workspace Snapshot", "", formatDirtyWorkspaceScope(options.dirtyWorkspaceSnapshot));

    if (options.dirtyWorkspaceSnapshot.statusPorcelain) {
      sections.push("", "### Git Status", "", "```text", options.dirtyWorkspaceSnapshot.statusPorcelain, "```");
    }

    if (options.dirtyWorkspaceSnapshot.untrackedFiles?.length) {
      sections.push("", "### Untracked Files", "", "```text", options.dirtyWorkspaceSnapshot.untrackedFiles.join("\n"), "```");
    }

    if (options.dirtyWorkspaceSnapshot.trackedDiffStat) {
      sections.push("", "### Working Tree Diff Stat", "", "```text", options.dirtyWorkspaceSnapshot.trackedDiffStat, "```");
    }

    if (options.dirtyWorkspaceSnapshot.trackedDiffPatch) {
      sections.push("", "### Working Tree Diff", "", "```diff", options.dirtyWorkspaceSnapshot.trackedDiffPatch, "```");
    }
  }

  if (implementationEvents.length > 0) {
    sections.push("", "## Implementation Updates");
    implementationEvents.forEach((event, index) => {
      sections.push("", `### Turn ${index + 1} (${formatBeijingDateTime(event.recordedAt)})`, "", event.detail);
    });
  }

  sections.push("", "## Code Diff");
  if (options?.codeDiff) {
    sections.push("", formatDiffScope(options.codeDiff));

    if (options.codeDiff.diffStat) {
      sections.push("", "### Diff Stat", "", "```text", options.codeDiff.diffStat, "```");
    }

    if (options.codeDiff.diffPatch) {
      sections.push("", "### Unified Diff", "", "```diff", options.codeDiff.diffPatch, "```");
    }

    if (!options.codeDiff.diffStat && !options.codeDiff.diffPatch) {
      sections.push("", "No code diff is currently present relative to the task base branch.");
    }
  } else {
    sections.push("", "The runner could not resolve the real repository diff for this task.");
  }

  if (validationArtifacts.length > 0) {
    sections.push("", "## Validation Results");
    validationArtifacts.forEach((artifact) => {
      sections.push("", `### ${artifact.title} (${formatBeijingDateTime(artifact.createdAt)})`, "", artifact.summary);
    });
  }

  if (gitEvents.length > 0) {
    sections.push("", "## Git Actions");
    gitEvents.forEach((event) => {
      sections.push("", `### ${event.title} (${formatBeijingDateTime(event.recordedAt)})`, "", event.detail);
    });
  }

  if (failureEvents.length > 0) {
    sections.push("", "## Failures");
    failureEvents.forEach((event) => {
      sections.push("", `### ${event.title} (${formatBeijingDateTime(event.recordedAt)})`, "", event.detail);
    });
  }

  return `${sections.join("\n")}\n`;
}

export class ReportPublisher {
  private readonly lockManager?: FileLockManager;

  constructor(
    private readonly recorder: TaskHistoryRecorder,
    private readonly options: {
      repoURL: string;
      branch: string;
      repoDir: string;
      publicBaseURL: string;
      rootDir?: string;
      lockManager?: FileLockManager;
      resolveReportNamespace?: (task: TaskSnapshot) => Promise<string> | string;
    }
  ) {
    this.lockManager = options.lockManager;
  }

  async publish(
    snapshot: TaskSnapshot,
    options?: { dirtyWorkspaceSnapshot?: DirtyWorkspaceSnapshot; signal?: AbortSignal; skipRemoteSync?: boolean }
  ): Promise<{
    reportURL?: string;
    publishedAt?: string;
    latestResultSummary?: string;
    reportRelativePath: string;
    remoteSyncError?: string;
  }> {
    const localTask = await this.recorder.loadTask(snapshot.id);
    const events = await this.recorder.loadEvents(snapshot.id);
    const reportNamespace = normalizeRelativeNamespace(
      localTask?.reportNamespace ??
        ((await this.options.resolveReportNamespace?.(snapshot)) ??
          snapshot.projectId ??
          slugify(snapshot.projectName ?? "unscoped"))
    );
    const relativePath = buildReportRelativePath(snapshot, this.options.rootDir, reportNamespace, {
      executionBranch: localTask?.executionBranch
    });
    const publishedAt = new Date().toISOString();
    const codeDiff = await this.captureCodeDiff(snapshot, localTask?.workspacePath, options?.signal);
    const markdown = buildReportMarkdown(snapshot, events, {
      codeDiff,
      dirtyWorkspaceSnapshot: options?.dirtyWorkspaceSnapshot,
      executionBranch: localTask?.executionBranch,
      reportRelativePath: relativePath,
      publishedAt
    });
    await this.recorder.writeReport(snapshot.id, markdown);

    if (options?.dirtyWorkspaceSnapshot?.statusPorcelain) {
      await this.recorder.saveArtifact(snapshot.id, "git", "Dirty workspace status", `${options.dirtyWorkspaceSnapshot.statusPorcelain}\n`);
    }

    if (options?.dirtyWorkspaceSnapshot?.trackedDiffPatch) {
      await this.recorder.saveArtifact(snapshot.id, "diff", "Dirty workspace diff", `${options.dirtyWorkspaceSnapshot.trackedDiffPatch}\n`);
    }
    await this.recorder.recordReportMapping(snapshot.id, {
      reportNamespace,
      reportRelativePath: relativePath
    });

    const localResult = {
      reportRelativePath: relativePath,
      latestResultSummary: snapshot.latestResultSummary ?? snapshot.summary
    };

    if (options?.skipRemoteSync || !this.options.repoURL.trim()) {
      return localResult;
    }

    const publish = async (): Promise<{
      reportURL?: string;
      publishedAt?: string;
      latestResultSummary?: string;
      reportRelativePath: string;
    }> => {
      const signal = options?.signal;
      await this.ensureRepository(signal);
      const absolutePath = path.join(this.options.repoDir, relativePath);
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, markdown, "utf8");

      await execGit(["-C", this.options.repoDir, "add", relativePath], undefined, { signal });
      let hasChanges = false;
      try {
        await execFileAsync("git", ["-C", this.options.repoDir, "diff", "--cached", "--quiet"], {
          ...(signal ? { signal } : {})
        });
      } catch (error) {
        const typed = error as { code?: number };
        if (typed.code === 1) {
          hasChanges = true;
        } else {
          throw error;
        }
      }

      if (hasChanges) {
        await execGit(["-C", this.options.repoDir, "commit", "-m", `docs(report): update ${snapshot.id}`], undefined, { signal });
        await this.pushReportBranch(signal);
      }

      const reportURL = this.buildReportURL(relativePath);
      return {
        reportURL,
        publishedAt,
        ...localResult
      };
    };

    try {
      if (!this.lockManager) {
        return await publish();
      }

      return await this.lockManager.withLock(
        `report-repo:${this.options.repoDir}`,
        `publish:${snapshot.id}`,
        publish,
        { timeoutMs: 180_000, pollIntervalMs: 750 }
      );
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }

      return {
        ...localResult,
        remoteSyncError: error instanceof Error ? error.message : "Unknown reports repository sync failure"
      };
    }
  }

  async captureDirtyWorkspaceSnapshot(workspacePath: string, signal?: AbortSignal): Promise<DirtyWorkspaceSnapshot | undefined> {
    try {
      await fs.access(workspacePath);
      const currentBranch = cleanDiffOutput(await execGit(["-C", workspacePath, "branch", "--show-current"], undefined, { signal }));
      const headCommit = cleanDiffOutput(await execGit(["-C", workspacePath, "rev-parse", "HEAD"], undefined, { signal }));
      const statusPorcelain = cleanDiffOutput(
        await execGitRaw(["-C", workspacePath, "status", "--porcelain=v1", "--branch", "--untracked-files=all"], undefined, { signal })
      );
      const trackedDiffStat = cleanDiffOutput(await execGitRaw(["-C", workspacePath, "diff", "--stat", "--find-renames", "HEAD"], undefined, { signal }));
      const trackedDiffPatch = cleanDiffOutput(await execGitRaw(["-C", workspacePath, "diff", "--find-renames", "HEAD"], undefined, { signal }));
      const untrackedFilesOutput = cleanDiffOutput(await execGitRaw(["-C", workspacePath, "ls-files", "--others", "--exclude-standard"], undefined, { signal }));
      const untrackedFiles = untrackedFilesOutput
        ?.split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);

      return {
        currentBranch,
        headCommit,
        statusPorcelain,
        trackedDiffStat,
        trackedDiffPatch,
        untrackedFiles
      };
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      return undefined;
    }
  }

  private async captureCodeDiff(snapshot: TaskSnapshot, fallbackWorkspacePath?: string, signal?: AbortSignal): Promise<ReportCodeDiff | undefined> {
    const workspacePath = snapshot.executorSession?.cwd ?? fallbackWorkspacePath;
    if (!workspacePath) {
      return undefined;
    }

    try {
      await fs.access(workspacePath);
      const branchName = (await execGit(["-C", workspacePath, "branch", "--show-current"], undefined, { signal })) || undefined;
      const baseRef = await resolveBaseRef(workspacePath, snapshot.baseBranch, signal);

      let compareRef = baseRef;
      try {
        compareRef = await execGit(["-C", workspacePath, "merge-base", "HEAD", baseRef], undefined, { signal });
      } catch (error) {
        if (isAbortError(error)) {
          throw error;
        }
        compareRef = baseRef;
      }

      const diffStat = cleanDiffOutput(await execGitRaw(["-C", workspacePath, "diff", "--stat", "--find-renames", compareRef], undefined, { signal }));
      const diffPatch = cleanDiffOutput(await execGitRaw(["-C", workspacePath, "diff", "--find-renames", compareRef], undefined, { signal }));

      if (diffStat) {
        await this.recorder.saveArtifact(snapshot.id, "diff", "Diff stat", `${diffStat}\n`);
      }

      if (diffPatch) {
        await this.recorder.saveArtifact(snapshot.id, "diff", "Code diff", `${diffPatch}\n`);
      }

      return {
        branchName,
        baseRef,
        compareRef,
        diffStat,
        diffPatch
      };
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      return undefined;
    }
  }

  private async ensureRepository(signal?: AbortSignal): Promise<void> {
    try {
      await fs.access(path.join(this.options.repoDir, ".git"));
    } catch {
      await fs.mkdir(path.dirname(this.options.repoDir), { recursive: true });
      await execGit(["clone", this.options.repoURL, this.options.repoDir], undefined, { signal });
    }

    await execGit(["-C", this.options.repoDir, "remote", "set-url", "origin", this.options.repoURL], undefined, { signal });
    await execGit(["-C", this.options.repoDir, "fetch", "origin", "--prune"], undefined, { signal });

    let hasLocalBranch = true;
    try {
      await execGit(["-C", this.options.repoDir, "rev-parse", "--verify", this.options.branch], undefined, { signal });
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      hasLocalBranch = false;
    }

    if (hasLocalBranch) {
      await execGit(["-C", this.options.repoDir, "checkout", this.options.branch], undefined, { signal });
    } else {
      let hasRemoteBranch = true;
      try {
        await execGit(["-C", this.options.repoDir, "ls-remote", "--exit-code", "--heads", "origin", this.options.branch], undefined, { signal });
      } catch (error) {
        if (isAbortError(error)) {
          throw error;
        }
        hasRemoteBranch = false;
      }

      if (hasRemoteBranch) {
        await execGit(["-C", this.options.repoDir, "checkout", "-B", this.options.branch, `origin/${this.options.branch}`], undefined, { signal });
      } else {
        await execGit(["-C", this.options.repoDir, "checkout", "--orphan", this.options.branch], undefined, { signal });
      }
    }

    try {
      await execGit(["-C", this.options.repoDir, "pull", "--rebase", "origin", this.options.branch], undefined, { signal });
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      // The branch may not exist remotely yet.
    }
  }

  private buildReportURL(relativePath: string): string | undefined {
    const configuredBase = this.options.publicBaseURL.trim().replace(/\/$/, "");
    if (configuredBase) {
      return `${configuredBase}/blob/${this.options.branch}/${relativePath}`;
    }

    const githubBase = maybeGitHubWebBase(this.options.repoURL);
    if (githubBase) {
      return `${githubBase}/blob/${this.options.branch}/${relativePath}`;
    }

    const gitlabBase = maybeGitLabWebBase(this.options.repoURL);
    if (gitlabBase) {
      return `${gitlabBase}/-/blob/${this.options.branch}/${relativePath}`;
    }

    return undefined;
  }

  private async pushReportBranch(signal?: AbortSignal): Promise<void> {
    const hookPresent = await hasPrePushHook(this.options.repoDir, signal);

    try {
      await execFileAsync(
        "git",
        ["-C", this.options.repoDir, "push", "origin", this.options.branch],
        {
          ...(signal ? { signal } : {}),
          timeout: config.gitPushTimeoutMs,
          maxBuffer: GIT_COMMAND_MAX_BUFFER
        }
      );
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      throw new Error(describeReportPushFailure(error, this.options.branch, hookPresent));
    }
  }
}
