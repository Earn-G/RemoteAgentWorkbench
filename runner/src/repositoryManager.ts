import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "./config.js";
import type { ProtectedGitCommand, ReviewPlatform } from "./models.js";

const execFileAsync = promisify(execFile);
const GIT_COMMAND_MAX_BUFFER = 10 * 1024 * 1024;

interface GitCommandError extends Error {
  code?: number | string;
  killed?: boolean;
  signal?: NodeJS.Signals | null;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
}

interface PushFailureContext {
  branchName: string;
  hasPrePushHook: boolean;
  remoteBranchExists: boolean;
  trackingRef?: string;
}

interface GitExecOptions {
  signal?: AbortSignal;
  timeout?: number;
}

function slugifyRepo(repoRef: string): string {
  return repoRef
    .replace(/^https?:\/\//, "")
    .replace(/^git@/, "")
    .replace(/[:/]/g, "-")
    .replace(/\.git$/i, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .toLowerCase();
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
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

function looksLikeLocalPath(value: string): boolean {
  const trimmed = value.trim();
  return trimmed === "~" ||
    trimmed === "." ||
    trimmed.startsWith("~/") ||
    trimmed.startsWith("./") ||
    trimmed.startsWith("../") ||
    trimmed.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(trimmed);
}

export interface PreparedWorkspace {
  sourceRepoPath: string;
  workspacePath: string;
  branchName?: string;
  isGitRepository: boolean;
  reviewPlatform?: ReviewPlatform;
  reviewTargetBranches?: string[];
}

export interface WorkspaceInspection {
  sourceRepoPath: string;
  isGitRepository: boolean;
  currentBranch?: string;
  hasUncommittedChanges: boolean;
  statusPorcelain?: string;
  statusSummary?: string;
  reviewPlatform?: ReviewPlatform;
  reviewTargetBranches?: string[];
}

export interface WorkspaceGitState {
  headCommit?: string;
  hasUncommittedChanges: boolean;
}

export interface CreatedReviewRequest {
  platform: ReviewPlatform;
  url: string;
}

export interface BranchPushState {
  branchName?: string;
  trackingBranch?: string;
  remoteBranchExists: boolean;
  localAheadCount: number;
  remoteAheadCount: number;
}

interface ReviewTarget {
  platform: ReviewPlatform;
  host: string;
  projectPath: string;
}

interface ParsedRemote {
  host: string;
  projectPath: string;
}

interface ResolvedSourceRepo {
  path: string;
  isGitRepository: boolean;
}

const MAX_REVIEW_TARGET_BRANCHES = 100;

function normalizeProjectPath(value: string): string {
  return value.replace(/\.git$/i, "").replace(/^\/+/, "");
}

function parseRemoteURL(remoteURL: string): ParsedRemote | undefined {
  const trimmed = remoteURL.trim();
  if (!trimmed) {
    return undefined;
  }

  const sshMatch = trimmed.match(/^[^@]+@([^:]+):(.+)$/);
  if (sshMatch) {
    return {
      host: sshMatch[1]!.toLowerCase(),
      projectPath: normalizeProjectPath(sshMatch[2]!)
    };
  }

  try {
    const url = new URL(trimmed);
    return {
      host: url.hostname.toLowerCase(),
      projectPath: normalizeProjectPath(url.pathname)
    };
  } catch {
    return undefined;
  }
}

function isGitLabHost(host: string): boolean {
  const configuredHost = (() => {
    try {
      return new URL(config.gitlab.baseURL).hostname.toLowerCase();
    } catch {
      return "gitlab.com";
    }
  })();

  return host === configuredHost || host === "gitlab.com" || host.includes("gitlab");
}

function isGitHubHost(host: string): boolean {
  return host === "github.com" || host.includes("github");
}

function draftReviewTitle(title: string): string {
  return /^(draft:|wip:)/i.test(title) ? title : `Draft: ${title}`;
}

function resolveGitLabAPIBaseURL(host: string): string {
  try {
    const configuredURL = new URL(config.gitlab.baseURL);
    if (configuredURL.hostname.toLowerCase() === host.toLowerCase()) {
      return config.gitlab.baseURL.replace(/\/+$/, "");
    }
  } catch {
    // Fall back to the repository host below.
  }

  return `https://${host}`;
}

export class RepositoryManager {
  constructor(
    private readonly repoCacheDir: string,
    private readonly workspaceDir: string
  ) {}

  async ensureDirectories(): Promise<void> {
    await fs.mkdir(this.repoCacheDir, { recursive: true });
    await fs.mkdir(this.workspaceDir, { recursive: true });
  }

  async resolveExecutionRepo(repoRef: string): Promise<string> {
    await this.ensureDirectories();
    return (await this.resolveSourceRepo(repoRef)).path;
  }

  async inspectWorkspace(repoRef: string, signal?: AbortSignal): Promise<WorkspaceInspection> {
    await this.ensureDirectories();

    const resolvedSource = await this.resolveSourceRepo(repoRef, signal);
    const sourceRepoPath = resolvedSource.path;
    if (!resolvedSource.isGitRepository) {
      return {
        sourceRepoPath,
        isGitRepository: false,
        hasUncommittedChanges: false,
        statusSummary: "Directory exists, but Git has not been initialized yet."
      };
    }

    await this.fetchIfPossible(sourceRepoPath, signal);
    const reviewTarget = await this.detectReviewTarget(sourceRepoPath, { signal });

    const statusPorcelain = await this.gitStatusPorcelain(sourceRepoPath, signal);
    const currentBranch = await this.currentBranch(sourceRepoPath, signal);
    const hasUncommittedChanges = statusPorcelain
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .some((line) => !line.startsWith("## "));

    return {
      sourceRepoPath,
      isGitRepository: true,
      currentBranch: currentBranch || undefined,
      hasUncommittedChanges,
      statusPorcelain: statusPorcelain.trim() || undefined,
      statusSummary: this.summarizeStatus(statusPorcelain),
      reviewPlatform: reviewTarget?.platform,
      reviewTargetBranches: await this.listReviewTargetBranches(sourceRepoPath, undefined, signal)
    };
  }

  async discardAllChanges(repoPath: string, signal?: AbortSignal): Promise<void> {
    if (!(await this.isGitRepository(repoPath, signal))) {
      return;
    }

    await execGit(["-C", repoPath, "reset", "--hard", "HEAD"], undefined, { signal });
    await execGit(["-C", repoPath, "clean", "-fd"], undefined, { signal });
  }

  async executeProtectedGitCommand(cwd: string, command: ProtectedGitCommand, signal?: AbortSignal): Promise<void> {
    if (command.kind === "reset_hard") {
      if (command.args[0] !== "reset" || !command.args.includes("--hard")) {
        throw new Error(`Protected Git command ${command.args.join(" ")} does not match reset --hard.`);
      }
    } else if (command.kind === "clean_fd") {
      if (command.args[0] !== "clean") {
        throw new Error(`Protected Git command ${command.args.join(" ")} does not match git clean.`);
      }
      const optionArgs = command.args.slice(1).filter((arg) => arg.startsWith("-"));
      const hasForce = optionArgs.some((arg) => arg === "-f" || arg.includes("f") || arg === "--force");
      const hasDirectory = optionArgs.some((arg) => arg === "-d" || arg.includes("d"));
      if (!hasForce || !hasDirectory) {
        throw new Error(`Protected Git command ${command.args.join(" ")} does not match clean -fd.`);
      }
    }

    await execGit(["-C", cwd, ...command.args], undefined, { signal });
  }

  async prepareWorkspace(
    taskId: string,
    repoRef: string,
    baseBranch: string,
    options?: {
      preferredBranchName?: string;
      useCurrentBranch?: boolean;
      resumeExistingBranch?: boolean;
      signal?: AbortSignal;
    }
  ): Promise<PreparedWorkspace> {
    await this.ensureDirectories();

    const signal = options?.signal;
    const resolvedSource = await this.resolveSourceRepo(repoRef, signal);
    const sourceRepoPath = resolvedSource.path;
    if (!resolvedSource.isGitRepository) {
      return {
        sourceRepoPath,
        workspacePath: sourceRepoPath,
        isGitRepository: false
      };
    }

    await this.fetchIfPossible(sourceRepoPath, signal);
    let branchName: string;

    if (options?.useCurrentBranch) {
      branchName = await this.requireCurrentLocalBranch(sourceRepoPath, signal);
    } else {
      const preferredBranchName = options?.preferredBranchName?.trim() || `codex/${taskId}`;
      const baseRef = await this.resolveBaseRef(sourceRepoPath, baseBranch, signal);
      branchName = await this.resolveTaskBranchName(
        sourceRepoPath,
        preferredBranchName,
        taskId,
        options?.resumeExistingBranch === true,
        signal
      );
      await this.checkoutTaskBranch(sourceRepoPath, branchName, baseRef, signal);
    }

    return {
      sourceRepoPath,
      workspacePath: sourceRepoPath,
      isGitRepository: true,
      branchName,
      reviewPlatform: (await this.detectReviewTarget(sourceRepoPath, { signal }))?.platform,
      reviewTargetBranches: await this.listReviewTargetBranches(sourceRepoPath, baseBranch, signal)
    };
  }

  async currentBranch(cwd: string, signal?: AbortSignal): Promise<string> {
    return execGit(["-C", cwd, "branch", "--show-current"], undefined, { signal });
  }

  async inspectWorkspaceGitState(cwd: string, signal?: AbortSignal): Promise<WorkspaceGitState> {
    if (!(await this.isGitRepository(cwd, signal))) {
      return {
        headCommit: undefined,
        hasUncommittedChanges: false
      };
    }

    return {
      headCommit: await this.currentHeadCommit(cwd, signal),
      hasUncommittedChanges: await this.hasUncommittedChanges(cwd, signal)
    };
  }

  async commitAll(cwd: string, message: string, signal?: AbortSignal): Promise<void> {
    await execGit(["-C", cwd, "add", "-A"], undefined, { signal });
    let hasChanges = false;
    try {
      await execFileAsync("git", ["-C", cwd, "diff", "--cached", "--quiet"], {
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

    if (!hasChanges) {
      throw new Error("No staged changes are available to commit");
    }

    await execGit(["-C", cwd, "commit", "-m", message], undefined, { signal });
  }

  async rebaseOntoBase(cwd: string, baseBranch: string, signal?: AbortSignal): Promise<void> {
    await this.fetchIfPossible(cwd, signal);
    const baseRef = await this.resolveBaseRef(cwd, baseBranch, signal);
    await execGit(["-C", cwd, "rebase", baseRef], undefined, { signal });
  }

  async pushCurrentBranch(cwd: string, signal?: AbortSignal): Promise<string> {
    const branchName = await this.currentBranch(cwd, signal);
    await this.pushBranchToOrigin(cwd, branchName, { signal });
    return branchName;
  }

  async inspectCurrentBranchPushState(cwd: string, signal?: AbortSignal): Promise<BranchPushState> {
    if (!(await this.isGitRepository(cwd, signal))) {
      return {
        remoteBranchExists: false,
        localAheadCount: 0,
        remoteAheadCount: 0
      };
    }

    await this.fetchIfPossible(cwd, signal);
    const branchName = await this.currentBranch(cwd, signal);
    if (!branchName) {
      return {
        remoteBranchExists: false,
        localAheadCount: 0,
        remoteAheadCount: 0
      };
    }

    const trackingBranch = `origin/${branchName}`;
    const remoteBranchExists = await this.remoteTrackingBranchExists(cwd, branchName, signal);
    if (!remoteBranchExists) {
      return {
        branchName,
        trackingBranch,
        remoteBranchExists,
        localAheadCount: 0,
        remoteAheadCount: 0
      };
    }

    const counts = await execGit(["-C", cwd, "rev-list", "--left-right", "--count", `${trackingBranch}...HEAD`], undefined, {
      signal
    });
    const [remoteAheadRaw, localAheadRaw] = counts.trim().split(/\s+/);
    return {
      branchName,
      trackingBranch,
      remoteBranchExists,
      localAheadCount: Number.parseInt(localAheadRaw ?? "0", 10) || 0,
      remoteAheadCount: Number.parseInt(remoteAheadRaw ?? "0", 10) || 0
    };
  }

  async ensureActiveBranch(cwd: string, expectedBranch: string, signal?: AbortSignal): Promise<string> {
    const branchName = expectedBranch.trim();
    if (!branchName) {
      throw new Error("The runner could not determine which branch this Git action should run on.");
    }

    const currentBranch = await this.currentBranch(cwd, signal);
    if (currentBranch === branchName) {
      return branchName;
    }

    if (await this.hasUncommittedChanges(cwd, signal)) {
      throw new Error(
        `Repository ${cwd} is currently on ${currentBranch || "(detached HEAD)"}, but this task expects ${branchName}. ` +
          "The repo also has uncommitted changes, so the runner will not switch branches automatically."
      );
    }

    if (await this.branchExists(cwd, branchName, signal)) {
      await execGit(["-C", cwd, "checkout", branchName], undefined, { signal });
      return branchName;
    }

    if (await this.remoteTrackingBranchExists(cwd, branchName, signal)) {
      await execGit(["-C", cwd, "checkout", "-B", branchName, `origin/${branchName}`], undefined, { signal });
      return branchName;
    }

    throw new Error(
      `Repository ${cwd} is currently on ${currentBranch || "(detached HEAD)"}, but task branch ${branchName} does not exist locally or on origin.`
    );
  }

  async ensureReviewReadyBranch(cwd: string, expectedBranch: string, signal?: AbortSignal): Promise<string> {
    await this.requireCurrentLocalBranchForReview(cwd, signal);
    return this.ensureActiveBranch(cwd, expectedBranch, signal);
  }

  async createReviewRequest(cwd: string, baseBranch: string, title: string, body: string, signal?: AbortSignal): Promise<CreatedReviewRequest> {
    const target = await this.detectReviewTarget(cwd, { signal });
    if (!target) {
      throw new Error("The runner could not identify whether this repository uses GitHub or GitLab. Make sure `origin` points to a GitHub or GitLab repository.");
    }

    const branchName = await this.ensureReviewBranchExistsOnRemote(cwd, signal);

    if (target.platform === "gitlab") {
      const source = await this.detectReviewTarget(cwd, { push: true, signal }) ?? target;
      return this.createGitLabMergeRequest(cwd, source, target, baseBranch, branchName, title, body, signal);
    }

    return this.createGitHubPullRequest(cwd, target, baseBranch, branchName, title, body, signal);
  }

  private async createGitHubPullRequest(
    cwd: string,
    target: ReviewTarget,
    baseBranch: string,
    branchName: string,
    title: string,
    body: string,
    signal?: AbortSignal
  ): Promise<CreatedReviewRequest> {
    const ghPath = await this.findExecutable("gh", signal);
    if (!ghPath) {
      throw new Error("GitHub CLI (`gh`) is not installed, so the runner cannot create a pull request yet");
    }

    try {
      await execFileAsync(ghPath, ["auth", "status", "--hostname", target.host], {
        cwd,
        ...(signal ? { signal } : {})
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      throw new Error("GitHub CLI (`gh`) is installed, but it is not authenticated. Run `gh auth login` on the Mac runner before creating a pull request.");
    }

    const { stdout } = await execFileAsync(
      ghPath,
      ["pr", "create", "--draft", "--base", baseBranch, "--head", branchName, "--title", title, "--body", body],
      {
        cwd,
        ...(signal ? { signal } : {})
      }
    );
    return {
      platform: "github",
      url: stdout.trim()
    };
  }

  private async createGitLabMergeRequest(
    cwd: string,
    source: ReviewTarget,
    target: ReviewTarget,
    baseBranch: string,
    branchName: string,
    title: string,
    body: string,
    signal?: AbortSignal
  ): Promise<CreatedReviewRequest> {
    const token = config.gitlab.token.trim();
    if (!token) {
      throw new Error("GitLab support is configured for this repository, but `GITLAB_TOKEN` is missing on the Mac runner.");
    }

    if (source.host !== target.host) {
      throw new Error(
        `GitLab merge request creation requires the push remote and fetch remote to use the same GitLab host. ` +
          `Push host: ${source.host}, fetch host: ${target.host}.`
      );
    }

    const apiBaseURL = resolveGitLabAPIBaseURL(target.host);
    const targetProjectId = source.projectPath !== target.projectPath
      ? await this.resolveGitLabProjectId(apiBaseURL, token, target.projectPath, signal)
      : undefined;
    const response = await fetch(
      `${apiBaseURL}/api/v4/projects/${encodeURIComponent(source.projectPath)}/merge_requests`,
      {
        method: "POST",
        ...(signal ? { signal } : {}),
        headers: {
          "content-type": "application/json",
          "PRIVATE-TOKEN": token
        },
        body: JSON.stringify({
          source_branch: branchName,
          target_branch: baseBranch,
          ...(targetProjectId !== undefined ? { target_project_id: targetProjectId } : {}),
          title: draftReviewTitle(title),
          description: body
        })
      }
    );

    if (!response.ok) {
      const detail = (await response.text()).trim();
      throw new Error(detail || `GitLab merge request creation failed with status ${response.status}`);
    }

    const payload = (await response.json()) as { web_url?: string };
    if (!payload.web_url?.trim()) {
      throw new Error("GitLab merge request creation succeeded, but no web URL was returned.");
    }

    return {
      platform: "gitlab",
      url: payload.web_url.trim()
    };
  }

  private async ensureReviewBranchExistsOnRemote(cwd: string, signal?: AbortSignal): Promise<string> {
    const branchName = await this.requireCurrentLocalBranchForReview(cwd, signal);

    await this.pushBranchToOrigin(cwd, branchName, { forReviewRequest: true, signal });

    return branchName;
  }

  private async requireCurrentLocalBranchForReview(cwd: string, signal?: AbortSignal): Promise<string> {
    const branchName = await this.currentBranch(cwd, signal);
    if (!branchName) {
      throw new Error(
        `Repository ${cwd} is not currently on a local branch. ` +
          "The runner will not create a new remote branch for a review request from detached HEAD. " +
          "Check out or create a local branch first, then try again."
      );
    }

    return branchName;
  }

  private async resolveGitLabProjectId(apiBaseURL: string, token: string, projectPath: string, signal?: AbortSignal): Promise<number> {
    const response = await fetch(`${apiBaseURL}/api/v4/projects/${encodeURIComponent(projectPath)}`, {
      ...(signal ? { signal } : {}),
      headers: {
        Accept: "application/json",
        "PRIVATE-TOKEN": token
      }
    });

    if (!response.ok) {
      const detail = (await response.text()).trim();
      throw new Error(detail || `GitLab project lookup failed with status ${response.status}`);
    }

    const payload = (await response.json()) as { id?: number };
    if (typeof payload.id !== "number" || !Number.isFinite(payload.id)) {
      throw new Error(`GitLab project lookup for ${projectPath} succeeded, but no numeric project id was returned.`);
    }

    return payload.id;
  }

  private async resolveSourceRepo(repoRef: string, signal?: AbortSignal): Promise<ResolvedSourceRepo> {
    const expanded = repoRef === "~"
      ? os.homedir()
      : repoRef.startsWith("~/")
        ? path.join(os.homedir(), repoRef.slice(2))
        : repoRef;
    if (await pathExists(expanded)) {
      const localPath = await fs.realpath(expanded).catch(() => path.resolve(expanded));
      const gitRoot = await this.tryGitRoot(localPath, signal);
      return {
        path: gitRoot ?? localPath,
        isGitRepository: Boolean(gitRoot)
      };
    }

    if (looksLikeLocalPath(repoRef)) {
      const localPath = path.resolve(expanded);
      await fs.mkdir(localPath, { recursive: true });
      return {
        path: localPath,
        isGitRepository: false
      };
    }

    const repoPath = path.join(this.repoCacheDir, slugifyRepo(repoRef));
    if (!(await pathExists(repoPath))) {
      await execGit(["clone", repoRef, repoPath], undefined, { signal });
      return {
        path: repoPath,
        isGitRepository: true
      };
    }

    await this.fetchIfPossible(repoPath, signal);
    return {
      path: repoPath,
      isGitRepository: true
    };
  }

  private async gitRoot(target: string, signal?: AbortSignal): Promise<string> {
    return execGit(["-C", target, "rev-parse", "--show-toplevel"], undefined, { signal });
  }

  private async tryGitRoot(target: string, signal?: AbortSignal): Promise<string | undefined> {
    try {
      return await this.gitRoot(target, signal);
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      return undefined;
    }
  }

  private async isGitRepository(target: string, signal?: AbortSignal): Promise<boolean> {
    return Boolean(await this.tryGitRoot(target, signal));
  }

  private async detectReviewTarget(repoPath: string, options?: { push?: boolean; signal?: AbortSignal }): Promise<ReviewTarget | undefined> {
    try {
      const remoteURL = await this.readRemoteURL(repoPath, options?.push === true, options?.signal);
      if (!remoteURL) {
        return undefined;
      }
      const parsed = parseRemoteURL(remoteURL);
      if (!parsed?.projectPath) {
        return undefined;
      }

      if (isGitLabHost(parsed.host)) {
        return {
          platform: "gitlab",
          host: parsed.host,
          projectPath: parsed.projectPath
        };
      }

      if (isGitHubHost(parsed.host)) {
        return {
          platform: "github",
          host: parsed.host,
          projectPath: parsed.projectPath
        };
      }

      return undefined;
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      return undefined;
    }
  }

  private async readRemoteURL(repoPath: string, usePushURL: boolean, signal?: AbortSignal): Promise<string | undefined> {
    const configKey = usePushURL ? "remote.origin.pushurl" : "remote.origin.url";

    try {
      const configuredURL = await execGit(["-C", repoPath, "config", "--get", configKey], undefined, { signal });
      if (configuredURL.trim()) {
        return configuredURL.trim();
      }
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      // Fall back to the resolved Git remote URL below.
    }

    try {
      return usePushURL
        ? await execGit(["-C", repoPath, "remote", "get-url", "--push", "origin"], undefined, { signal })
        : await execGit(["-C", repoPath, "remote", "get-url", "origin"], undefined, { signal });
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      return undefined;
    }
  }

  private async listReviewTargetBranches(repoPath: string, preferredBranch?: string, signal?: AbortSignal): Promise<string[] | undefined> {
    try {
      const output = await execGit([
        "-C",
        repoPath,
        "for-each-ref",
        "--format=%(refname:short)",
        "refs/remotes/origin"
      ], undefined, { signal });
      const normalized = output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => !line.endsWith("/HEAD"))
        .map((line) => line.replace(/^origin\//, ""));

      return this.prioritizeReviewTargetBranches(normalized, preferredBranch);
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      return this.prioritizeReviewTargetBranches([], preferredBranch);
    }
  }

  private prioritizeReviewTargetBranches(branches: string[], preferredBranch?: string): string[] | undefined {
    const unique = Array.from(new Set(branches.filter(Boolean)));
    const preferred = preferredBranch?.trim();
    const ordered = preferred
      ? [preferred, ...unique.filter((branch) => branch !== preferred)]
      : unique;

    const limited = ordered.slice(0, MAX_REVIEW_TARGET_BRANCHES);
    return limited.length > 0 ? limited : undefined;
  }

  private async resolveBaseRef(repoPath: string, baseBranch: string, signal?: AbortSignal): Promise<string> {
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

  private async fetchIfPossible(repoPath: string, signal?: AbortSignal): Promise<void> {
    try {
      await execGit(["-C", repoPath, "fetch", "--all", "--prune"], undefined, { signal });
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      // Local-only repositories may not have remotes configured.
    }
  }

  private async checkoutTaskBranch(repoPath: string, branchName: string, startPoint: string, signal?: AbortSignal): Promise<void> {
    const currentBranch = await this.currentBranch(repoPath, signal);
    if (currentBranch === branchName) {
      return;
    }

    if (await this.hasUncommittedChanges(repoPath, signal)) {
      throw new Error(
        `Repository ${repoPath} has uncommitted changes on branch ${currentBranch || "(detached HEAD)"}. ` +
          "Clean, commit, or stash them before starting a new task in this repo."
      );
    }

    if (await this.branchExists(repoPath, branchName, signal)) {
      await execGit(["-C", repoPath, "checkout", branchName], undefined, { signal });
      return;
    }

    await execGit(["-C", repoPath, "checkout", "-b", branchName, startPoint], undefined, { signal });
  }

  private async requireCurrentLocalBranch(repoPath: string, signal?: AbortSignal): Promise<string> {
    const currentBranch = await this.currentBranch(repoPath, signal);
    if (currentBranch) {
      return currentBranch;
    }

    throw new Error(
      `Repository ${repoPath} is not currently on a local branch. Check out a branch before starting a task that uses the current branch.`
    );
  }

  private async resolveTaskBranchName(
    repoPath: string,
    preferredBranchName: string,
    taskId: string,
    resumeExistingBranch: boolean,
    signal?: AbortSignal
  ): Promise<string> {
    const currentBranch = await this.currentBranch(repoPath, signal);
    if (currentBranch === preferredBranchName || resumeExistingBranch) {
      return preferredBranchName;
    }

    if (
      !(await this.branchExists(repoPath, preferredBranchName, signal)) &&
      !(await this.remoteTrackingBranchExists(repoPath, preferredBranchName, signal))
    ) {
      return preferredBranchName;
    }

    const suffix = taskId.replace(/^task_/, "").slice(0, 4).toLowerCase() || "task";
    let attempt = 1;
    while (attempt < 100) {
      const candidate = `${preferredBranchName}_${suffix}${attempt > 1 ? attempt : ""}`;
      if (
        !(await this.branchExists(repoPath, candidate, signal)) &&
        !(await this.remoteTrackingBranchExists(repoPath, candidate, signal))
      ) {
        return candidate;
      }
      attempt += 1;
    }

    throw new Error(`Could not allocate a unique task branch for ${preferredBranchName}`);
  }

  private async hasUncommittedChanges(repoPath: string, signal?: AbortSignal): Promise<boolean> {
    try {
      await execFileAsync("git", ["-C", repoPath, "diff", "--quiet", "--ignore-submodules=all"], {
        ...(signal ? { signal } : {})
      });
      await execFileAsync("git", ["-C", repoPath, "diff", "--cached", "--quiet", "--ignore-submodules=all"], {
        ...(signal ? { signal } : {})
      });
      const { stdout } = await execFileAsync("git", ["-C", repoPath, "status", "--porcelain", "--untracked-files=all"], {
        ...(signal ? { signal } : {})
      });
      return stdout.toString().trim().length > 0;
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      return true;
    }
  }

  private async gitStatusPorcelain(repoPath: string, signal?: AbortSignal): Promise<string> {
    return execGit(["-C", repoPath, "status", "--porcelain=v1", "--branch", "--untracked-files=all"], undefined, { signal });
  }

  private async currentHeadCommit(repoPath: string, signal?: AbortSignal): Promise<string | undefined> {
    try {
      const commit = await execGit(["-C", repoPath, "rev-parse", "HEAD"], undefined, { signal });
      return commit || undefined;
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      return undefined;
    }
  }

  private summarizeStatus(statusPorcelain: string): string | undefined {
    const lines = statusPorcelain
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter(Boolean);

    const branchLine = lines.find((line) => line.startsWith("## "));
    const changeLines = lines.filter((line) => !line.startsWith("## "));
    if (!branchLine && changeLines.length === 0) {
      return undefined;
    }

    const preview = [...(branchLine ? [branchLine] : []), ...changeLines.slice(0, 10)];
    const remainingCount = Math.max(changeLines.length - 10, 0);
    if (remainingCount > 0) {
      preview.push(`... and ${remainingCount} more changed entries`);
    }

    return preview.join("\n");
  }

  private async branchExists(repoPath: string, branchName: string, signal?: AbortSignal): Promise<boolean> {
    try {
      await execGit(["-C", repoPath, "rev-parse", "--verify", `refs/heads/${branchName}`], undefined, { signal });
      return true;
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      return false;
    }
  }

  private async remoteTrackingBranchExists(repoPath: string, branchName: string, signal?: AbortSignal): Promise<boolean> {
    try {
      await execGit(["-C", repoPath, "rev-parse", "--verify", `refs/remotes/origin/${branchName}`], undefined, { signal });
      return true;
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      return false;
    }
  }

  private async findExecutable(name: string, signal?: AbortSignal): Promise<string | undefined> {
    try {
      const { stdout } = await execFileAsync("which", [name], {
        ...(signal ? { signal } : {})
      });
      return stdout.toString().trim() || undefined;
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      return undefined;
    }
  }

  private async pushBranchToOrigin(
    repoPath: string,
    branchName: string,
    options?: { forReviewRequest?: boolean; signal?: AbortSignal }
  ): Promise<void> {
    const context = await this.inspectPushFailureContext(repoPath, branchName, options?.signal);

    try {
      await execFileAsync(
        "git",
        ["-C", repoPath, "push", "-u", "origin", branchName],
        {
          ...(options?.signal ? { signal: options.signal } : {}),
          timeout: config.gitPushTimeoutMs,
          maxBuffer: GIT_COMMAND_MAX_BUFFER
        }
      );
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      throw new Error(this.describePushFailure(error, context, options?.forReviewRequest === true));
    }
  }

  private async inspectPushFailureContext(repoPath: string, branchName: string, signal?: AbortSignal): Promise<PushFailureContext> {
    const [hasPrePushHook, remoteBranchExists, trackingRef] = await Promise.all([
      this.hasPrePushHook(repoPath, signal),
      this.remoteTrackingBranchExists(repoPath, branchName, signal),
      this.readTrackingRef(repoPath, branchName, signal)
    ]);

    return {
      branchName,
      hasPrePushHook,
      remoteBranchExists,
      trackingRef
    };
  }

  private async hasPrePushHook(repoPath: string, signal?: AbortSignal): Promise<boolean> {
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

  private async readTrackingRef(repoPath: string, branchName: string, signal?: AbortSignal): Promise<string | undefined> {
    try {
      const [remote, mergeRef] = await Promise.all([
        execGit(["-C", repoPath, "config", "--get", `branch.${branchName}.remote`], undefined, { signal }),
        execGit(["-C", repoPath, "config", "--get", `branch.${branchName}.merge`], undefined, { signal })
      ]);

      const normalizedRemote = remote.trim();
      const normalizedMergeRef = mergeRef.trim().replace(/^refs\/heads\//, "");
      if (!normalizedRemote || !normalizedMergeRef) {
        return undefined;
      }

      return `${normalizedRemote}/${normalizedMergeRef}`;
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      return undefined;
    }
  }

  private describePushFailure(
    error: unknown,
    context: PushFailureContext,
    forReviewRequest: boolean
  ): string {
    const typed = error as GitCommandError;
    const detail = normalizeGitErrorDetail([
      renderProcessOutput(typed.stderr),
      renderProcessOutput(typed.stdout),
      typed.message ?? ""
    ].join("\n"));
    const detailLower = detail.toLowerCase();
    const timedOut = typed.killed === true || typed.signal === "SIGTERM" || detailLower.includes("timed out");
    const prefix = forReviewRequest
      ? `The runner could not push branch ${context.branchName} to origin before creating the review request.`
      : `The runner could not push branch ${context.branchName} to origin.`;
    const trackingNote = this.renderTrackingMismatchNote(context);

    if (timedOut) {
      const hookNote = context.hasPrePushHook
        ? " A local pre-push hook is present in this workspace."
        : "";
      return (
        `${prefix} The push timed out on the Mac runner. ` +
        "This usually means a local Git hook is scanning too much history or waiting for interactive input." +
        " The runner does not bypass Git hooks automatically." +
        hookNote +
        trackingNote
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
      return `${prefix} The Mac runner could not authenticate to origin. Check the runner's SSH key or HTTPS credentials for this repository host.`;
    }

    if (errorIncludesAny(detailLower, ["protected branch", "pre-receive hook declined", "deny updating"])) {
      return `${prefix} The remote rejected this push because of branch protection or a server-side hook. Check the repository's push rules and review permissions.`;
    }

    if (
      errorIncludesAny(detailLower, [
        "non-fast-forward",
        "fetch first",
        "updates were rejected because the remote contains work that you do not have locally"
      ])
    ) {
      return (
        `${prefix} origin/${context.branchName} already has remote commits that are not in the runner workspace. ` +
        "The runner will not force-push automatically. Fetch or rebase the branch, then try again."
      );
    }

    if (errorIncludesAny(detailLower, ["pre-push hook", "pre-push", "hook blocked", "rejected by hook"])) {
      return (
        `${prefix} A local pre-push hook in this workspace rejected the push. ` +
        "The runner does not bypass Git hooks automatically, so it stopped before changing the remote." +
        trackingNote
      );
    }

    if (detail) {
      return `${prefix} Git reported: ${detail}`;
    }

    return prefix;
  }

  private renderTrackingMismatchNote(context: PushFailureContext): string {
    const expectedTrackingRef = `origin/${context.branchName}`;
    if (!context.trackingRef || context.trackingRef === expectedTrackingRef || context.remoteBranchExists) {
      return "";
    }

    return (
      ` Local branch ${context.branchName} is configured to track ${context.trackingRef} instead of ${expectedTrackingRef},` +
      " so first-push hooks may compare against the wrong base."
    );
  }
}
