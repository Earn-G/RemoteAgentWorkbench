import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  ApprovalRequest,
  Artifact,
  DeliveryMode,
  DirectoryPresetRecord,
  DirtyWorkspaceDecision,
  ExecutorSession,
  ProtectedGitCommand,
  ProtectedGitCommandKind,
  ProjectRecord,
  RunnerInfo,
  TaskBranchMode,
  TaskEvent,
  TaskRecord
} from "../domain/models.js";

export interface PendingCommandRecord {
  id: string;
  taskId: string;
  runnerId: string;
  kind: string;
  prompt?: string;
  commitMessage?: string;
  prTitle?: string;
  targetBranch?: string;
  reviewMode?: "review_only" | "commit_and_review";
  dirtyWorkspaceDecision?: DirtyWorkspaceDecision;
  protectedGitCommand?: ProtectedGitCommand;
  allowedProtectedGitCommandKinds?: ProtectedGitCommandKind[];
  createdAt: string;
  claimedAt?: string;
  claimToken?: string;
  completedAt?: string;
}

export interface UtilityCommandRecord {
  id: string;
  runnerId: string;
  claimToken?: string;
  kind: "create_directory" | "switch_codex_profile" | "create_codex_profile" | "delete_codex_profile";
  presetId: string;
  label: string;
  rootPath: string;
  relativePath: string;
  absolutePath: string;
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
  createdAt: string;
  claimedAt?: string;
  completedAt?: string;
  lastOutcome?: "completed" | "failed";
  lastMessage?: string;
}

interface SerializedState {
  projects: ProjectRecord[];
  directoryPresets: DirectoryPresetRecord[];
  runners: RunnerInfo[];
  tasks: TaskRecord[];
  approvals: ApprovalRequest[];
  artifacts: Artifact[];
  events: TaskEvent[];
  sessions: ExecutorSession[];
  commands: PendingCommandRecord[];
  utilityCommands: UtilityCommandRecord[];
}

function parseJSON<T>(value: string | null, fallback: T): T {
  if (!value || value.trim().length === 0) {
    return fallback;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function asDeliveryMode(value: unknown): DeliveryMode {
  return value === "direct_commit" ? "direct_commit" : "review_required";
}

function asOptionalDeliveryMode(value: unknown): DeliveryMode | undefined {
  return value === "direct_commit" || value === "review_required" ? value : undefined;
}

function asTaskBranchMode(value: unknown): TaskBranchMode {
  return value === "current_branch" ? "current_branch" : "new_branch";
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return value !== 0;
  }

  return fallback;
}

export class SqliteStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }

    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.migrate();
  }

  loadState(): SerializedState {
    return {
      projects: this.loadProjects(),
      directoryPresets: this.loadDirectoryPresets(),
      runners: this.loadRunners(),
      tasks: this.loadTasks(),
      approvals: this.loadApprovals(),
      artifacts: this.loadArtifacts(),
      events: this.loadEvents(),
      sessions: this.loadSessions(),
      commands: this.loadCommands(),
      utilityCommands: this.loadUtilityCommands()
    };
  }

  loadCodexConfigProjection(): {
    runners: RunnerInfo[];
    utilityCommands: UtilityCommandRecord[];
  } {
    return {
      runners: this.loadRunners(),
      utilityCommands: this.loadUtilityCommands()
    };
  }

  cleanupExpiredTasks(retentionDays: number): string[] {
    if (retentionDays <= 0) {
      return [];
    }

    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    const select = this.db.prepare(
      `
        SELECT id
        FROM tasks
        WHERE status IN ('awaiting_human_input', 'completed', 'failed', 'canceled')
          AND updatedAt < :cutoff
      `
    );
    const rows = select.all({ cutoff }) as Array<{ id: string }>;

    if (rows.length === 0) {
      return [];
    }

    const removeTask = this.db.prepare(`DELETE FROM tasks WHERE id = :id`);
    for (const row of rows) {
      removeTask.run({ id: row.id });
    }

    return rows.map((row) => row.id);
  }

  deleteTask(id: string): void {
    this.db.prepare(`DELETE FROM tasks WHERE id = ?`).run(id);
  }

  upsertProject(project: ProjectRecord): void {
    this.db
      .prepare(
        `
          INSERT INTO projects (
            id, name, repo, baseBranch, deliveryMode, autoPush, defaultTaskTitle, defaultPrompt,
            isFeatured, runnerId, createdAt, updatedAt, lastSyncedAt
          )
          VALUES (
            :id, :name, :repo, :baseBranch, :deliveryMode, :autoPush, :defaultTaskTitle, :defaultPrompt,
            :isFeatured, :runnerId, :createdAt, :updatedAt, :lastSyncedAt
          )
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            repo = excluded.repo,
            baseBranch = excluded.baseBranch,
            deliveryMode = excluded.deliveryMode,
            autoPush = excluded.autoPush,
            defaultTaskTitle = excluded.defaultTaskTitle,
            defaultPrompt = excluded.defaultPrompt,
            isFeatured = excluded.isFeatured,
            runnerId = excluded.runnerId,
            updatedAt = excluded.updatedAt,
            lastSyncedAt = excluded.lastSyncedAt
        `
      )
      .run({
        id: project.id,
        name: project.name,
        repo: project.repo,
        baseBranch: project.baseBranch,
        deliveryMode: project.deliveryMode,
        autoPush: project.autoPush ? 1 : 0,
        defaultTaskTitle: project.defaultTaskTitle,
        defaultPrompt: project.defaultPrompt,
        isFeatured: project.isFeatured ? 1 : 0,
        runnerId: project.runnerId,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        lastSyncedAt: project.lastSyncedAt
      });
  }

  deleteProjectsByRunnerExcept(runnerId: string, keepIds: string[]): string[] {
    const rows = this.db
      .prepare(`SELECT id FROM projects WHERE runnerId = :runnerId`)
      .all({ runnerId }) as Array<{ id: string }>;
    const removable = rows.map((row) => row.id).filter((id) => !keepIds.includes(id));

    if (removable.length === 0) {
      return [];
    }

    const stmt = this.db.prepare(`DELETE FROM projects WHERE id = ?`);
    for (const id of removable) {
      stmt.run(id);
    }

    return removable;
  }

  upsertDirectoryPreset(preset: DirectoryPresetRecord): void {
    this.db
      .prepare(
        `
          INSERT INTO directory_presets (
            id, label, rootPath, runnerId, createdAt, updatedAt
          )
          VALUES (
            :id, :label, :rootPath, :runnerId, :createdAt, :updatedAt
          )
          ON CONFLICT(id) DO UPDATE SET
            label = excluded.label,
            rootPath = excluded.rootPath,
            runnerId = excluded.runnerId,
            createdAt = excluded.createdAt,
            updatedAt = excluded.updatedAt
        `
      )
      .run({
        id: preset.id,
        label: preset.label,
        rootPath: preset.rootPath,
        runnerId: preset.runnerId,
        createdAt: preset.createdAt,
        updatedAt: preset.updatedAt
      });
  }

  deleteDirectoryPresetsByRunnerExcept(runnerId: string, keepIds: string[]): string[] {
    const rows = this.db
      .prepare(`SELECT id FROM directory_presets WHERE runnerId = :runnerId`)
      .all({ runnerId }) as Array<{ id: string }>;
    const removable = rows.map((row) => row.id).filter((id) => !keepIds.includes(id));

    if (removable.length === 0) {
      return [];
    }

    const stmt = this.db.prepare(`DELETE FROM directory_presets WHERE id = ?`);
    for (const id of removable) {
      stmt.run(id);
    }

    return removable;
  }

  upsertRunner(runner: RunnerInfo): void {
    this.db
      .prepare(
        `
          INSERT INTO runners (
            id, name, platform, labelsJson, capabilitiesJson, currentTaskId,
            currentCommandId, currentCommandKind, currentCommandStartedAt,
            lastHeartbeatAt, version, hostname, codexConfigProfilesJson, activeCodexConfigProfile
          )
          VALUES (
            :id, :name, :platform, :labelsJson, :capabilitiesJson, :currentTaskId,
            :currentCommandId, :currentCommandKind, :currentCommandStartedAt,
            :lastHeartbeatAt, :version, :hostname, :codexConfigProfilesJson, :activeCodexConfigProfile
          )
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            platform = excluded.platform,
            labelsJson = excluded.labelsJson,
            capabilitiesJson = excluded.capabilitiesJson,
            currentTaskId = excluded.currentTaskId,
            currentCommandId = excluded.currentCommandId,
            currentCommandKind = excluded.currentCommandKind,
            currentCommandStartedAt = excluded.currentCommandStartedAt,
            lastHeartbeatAt = excluded.lastHeartbeatAt,
            version = excluded.version,
            hostname = excluded.hostname,
            codexConfigProfilesJson = excluded.codexConfigProfilesJson,
            activeCodexConfigProfile = excluded.activeCodexConfigProfile
        `
      )
      .run({
        id: runner.id,
        name: runner.name,
        platform: runner.platform,
        labelsJson: JSON.stringify(runner.labels),
        capabilitiesJson: JSON.stringify(runner.capabilities),
        currentTaskId: runner.currentTaskId ?? null,
        currentCommandId: runner.currentCommandId ?? null,
        currentCommandKind: runner.currentCommandKind ?? null,
        currentCommandStartedAt: runner.currentCommandStartedAt ?? null,
        lastHeartbeatAt: runner.lastHeartbeatAt,
        version: runner.version ?? null,
        hostname: runner.hostname ?? null,
        codexConfigProfilesJson: runner.codexConfigProfiles ? JSON.stringify(runner.codexConfigProfiles) : null,
        activeCodexConfigProfile: runner.activeCodexConfigProfile ?? null
      });
  }

  upsertTask(task: TaskRecord): void {
    this.db
      .prepare(
        `
          INSERT INTO tasks (
            id, workflowKey, deliveryMode, autoPush, title, prompt, repo, baseBranch, projectId, projectName,
            branchMode, branchName, executionBranch, reviewPlatform, reviewTargetBranchesJson, dirtyWorkspaceJson, executionMode, resumeThreadId, stopRequestedAt, status, runnerId, sessionAlias, summary,
            reportURL, lastPublishedAt, latestResultSummary, createdAt, updatedAt
          )
          VALUES (
            :id, :workflowKey, :deliveryMode, :autoPush, :title, :prompt, :repo, :baseBranch, :projectId, :projectName,
            :branchMode, :branchName, :executionBranch, :reviewPlatform, :reviewTargetBranchesJson, :dirtyWorkspaceJson, :executionMode, :resumeThreadId, :stopRequestedAt, :status, :runnerId, :sessionAlias, :summary,
            :reportURL, :lastPublishedAt, :latestResultSummary, :createdAt, :updatedAt
          )
          ON CONFLICT(id) DO UPDATE SET
            workflowKey = excluded.workflowKey,
            deliveryMode = excluded.deliveryMode,
            autoPush = excluded.autoPush,
            title = excluded.title,
            prompt = excluded.prompt,
            repo = excluded.repo,
            baseBranch = excluded.baseBranch,
            projectId = excluded.projectId,
            projectName = excluded.projectName,
            branchMode = excluded.branchMode,
            branchName = excluded.branchName,
            executionBranch = excluded.executionBranch,
            reviewPlatform = excluded.reviewPlatform,
            reviewTargetBranchesJson = excluded.reviewTargetBranchesJson,
            dirtyWorkspaceJson = excluded.dirtyWorkspaceJson,
            executionMode = excluded.executionMode,
            resumeThreadId = excluded.resumeThreadId,
            stopRequestedAt = excluded.stopRequestedAt,
            status = excluded.status,
            runnerId = excluded.runnerId,
            sessionAlias = excluded.sessionAlias,
            summary = excluded.summary,
            reportURL = excluded.reportURL,
            lastPublishedAt = excluded.lastPublishedAt,
            latestResultSummary = excluded.latestResultSummary,
            createdAt = excluded.createdAt,
            updatedAt = excluded.updatedAt
        `
      )
      .run({
        id: task.id,
        workflowKey: task.workflowKey,
        deliveryMode: task.deliveryMode,
        autoPush: task.autoPush ? 1 : 0,
        title: task.title,
        prompt: task.prompt,
        repo: task.repo,
        baseBranch: task.baseBranch,
        projectId: task.projectId ?? null,
        projectName: task.projectName ?? null,
        branchMode: task.branchMode,
        branchName: task.branchName ?? "",
        executionBranch: task.executionBranch ?? null,
        reviewPlatform: task.reviewPlatform ?? null,
        reviewTargetBranchesJson: task.reviewTargetBranches ? JSON.stringify(task.reviewTargetBranches) : null,
        dirtyWorkspaceJson: task.dirtyWorkspace ? JSON.stringify(task.dirtyWorkspace) : null,
        executionMode: task.executionMode,
        resumeThreadId: task.resumeThreadId ?? null,
        stopRequestedAt: task.stopRequestedAt ?? null,
        status: task.status,
        runnerId: task.runnerId ?? null,
        sessionAlias: task.sessionAlias,
        summary: task.summary,
        reportURL: task.reportURL ?? null,
        lastPublishedAt: task.lastPublishedAt ?? null,
        latestResultSummary: task.latestResultSummary ?? null,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt
      });
  }

  upsertApproval(approval: ApprovalRequest): void {
    this.db
      .prepare(
        `
          INSERT INTO approvals (
            id, taskId, type, title, detail, status, payloadJson, createdAt, resolvedAt
          )
          VALUES (
            :id, :taskId, :type, :title, :detail, :status, :payloadJson, :createdAt, :resolvedAt
          )
          ON CONFLICT(id) DO UPDATE SET
            taskId = excluded.taskId,
            type = excluded.type,
            title = excluded.title,
            detail = excluded.detail,
            status = excluded.status,
            payloadJson = excluded.payloadJson,
            createdAt = excluded.createdAt,
            resolvedAt = excluded.resolvedAt
        `
      )
      .run({
        id: approval.id,
        taskId: approval.taskId,
        type: approval.type,
        title: approval.title,
        detail: approval.detail,
        status: approval.status,
        payloadJson: JSON.stringify(approval.payload),
        createdAt: approval.createdAt,
        resolvedAt: approval.resolvedAt ?? null
      });
  }

  upsertArtifact(artifact: Artifact): void {
    this.db
      .prepare(
        `
          INSERT INTO artifacts (id, taskId, kind, title, summary, createdAt)
          VALUES (:id, :taskId, :kind, :title, :summary, :createdAt)
          ON CONFLICT(id) DO UPDATE SET
            taskId = excluded.taskId,
            kind = excluded.kind,
            title = excluded.title,
            summary = excluded.summary,
            createdAt = excluded.createdAt
        `
      )
      .run({
        id: artifact.id,
        taskId: artifact.taskId,
        kind: artifact.kind,
        title: artifact.title,
        summary: artifact.summary,
        createdAt: artifact.createdAt
      });
  }

  deleteArtifacts(ids: string[]): void {
    if (ids.length === 0) {
      return;
    }

    const stmt = this.db.prepare(`DELETE FROM artifacts WHERE id = ?`);
    for (const id of ids) {
      stmt.run(id);
    }
  }

  upsertEvent(event: TaskEvent): void {
    this.db
      .prepare(
        `
          INSERT INTO events (id, taskId, createdAt, kind, title, detail)
          VALUES (:id, :taskId, :createdAt, :kind, :title, :detail)
          ON CONFLICT(id) DO UPDATE SET
            taskId = excluded.taskId,
            createdAt = excluded.createdAt,
            kind = excluded.kind,
            title = excluded.title,
            detail = excluded.detail
        `
      )
      .run({
        id: event.id,
        taskId: event.taskId,
        createdAt: event.createdAt,
        kind: event.kind,
        title: event.title,
        detail: event.detail
      });
  }

  deleteEvents(ids: string[]): void {
    if (ids.length === 0) {
      return;
    }

    const stmt = this.db.prepare(`DELETE FROM events WHERE id = ?`);
    for (const id of ids) {
      stmt.run(id);
    }
  }

  upsertSession(session: ExecutorSession): void {
    this.db
      .prepare(
        `
          INSERT INTO sessions (
            sessionAlias, executorType, runnerId, threadId, cwd,
            materializedFromHistory, lastTurnAt
          )
          VALUES (
            :sessionAlias, :executorType, :runnerId, :threadId, :cwd,
            :materializedFromHistory, :lastTurnAt
          )
          ON CONFLICT(sessionAlias) DO UPDATE SET
            executorType = excluded.executorType,
            runnerId = excluded.runnerId,
            threadId = excluded.threadId,
            cwd = excluded.cwd,
            materializedFromHistory = excluded.materializedFromHistory,
            lastTurnAt = excluded.lastTurnAt
        `
      )
      .run({
        ...session,
        materializedFromHistory: session.materializedFromHistory ? 1 : 0
      });
  }

  upsertCommand(command: PendingCommandRecord): void {
    this.db
      .prepare(
        `
          INSERT INTO commands (
            id, taskId, runnerId, kind, prompt, commitMessage, prTitle, targetBranch, reviewMode, dirtyWorkspaceDecision,
            protectedGitCommandJson, allowedProtectedGitCommandKindsJson, createdAt, claimedAt, claimToken, completedAt
          )
          VALUES (
            :id, :taskId, :runnerId, :kind, :prompt, :commitMessage, :prTitle, :targetBranch, :reviewMode, :dirtyWorkspaceDecision,
            :protectedGitCommandJson, :allowedProtectedGitCommandKindsJson, :createdAt, :claimedAt, :claimToken, :completedAt
          )
          ON CONFLICT(id) DO UPDATE SET
            taskId = excluded.taskId,
            runnerId = excluded.runnerId,
            kind = excluded.kind,
            prompt = excluded.prompt,
            commitMessage = excluded.commitMessage,
            prTitle = excluded.prTitle,
            targetBranch = excluded.targetBranch,
            reviewMode = excluded.reviewMode,
            dirtyWorkspaceDecision = excluded.dirtyWorkspaceDecision,
            protectedGitCommandJson = excluded.protectedGitCommandJson,
            allowedProtectedGitCommandKindsJson = excluded.allowedProtectedGitCommandKindsJson,
            createdAt = excluded.createdAt,
            claimedAt = excluded.claimedAt,
            claimToken = excluded.claimToken,
            completedAt = excluded.completedAt
        `
      )
      .run({
        id: command.id,
        taskId: command.taskId,
        runnerId: command.runnerId,
        kind: command.kind,
        prompt: command.prompt ?? null,
        commitMessage: command.commitMessage ?? null,
        prTitle: command.prTitle ?? null,
        targetBranch: command.targetBranch ?? null,
        reviewMode: command.reviewMode ?? null,
        dirtyWorkspaceDecision: command.dirtyWorkspaceDecision ?? null,
        protectedGitCommandJson: command.protectedGitCommand ? JSON.stringify(command.protectedGitCommand) : null,
        allowedProtectedGitCommandKindsJson: command.allowedProtectedGitCommandKinds
          ? JSON.stringify(command.allowedProtectedGitCommandKinds)
          : null,
        createdAt: command.createdAt,
        claimedAt: command.claimedAt ?? null,
        claimToken: command.claimToken ?? null,
        completedAt: command.completedAt ?? null
      });
  }

  deleteCommand(id: string): void {
    this.db.prepare(`DELETE FROM commands WHERE id = ?`).run(id);
  }

  upsertUtilityCommand(command: UtilityCommandRecord): void {
    const persistedBaseURL = command.kind === "create_codex_profile" ? null : command.baseURL ?? null;
    const persistedAPIKey = command.kind === "create_codex_profile" ? null : command.apiKey ?? null;

    this.db
      .prepare(
        `
          INSERT INTO utility_commands (
            id, runnerId, claimToken, kind, presetId, label, rootPath, relativePath, absolutePath,
            createProject, projectName, projectBaseBranch, projectDeliveryMode, projectAutoPush, projectDefaultTaskTitle,
            projectDefaultPrompt, profileName, baseURL, apiKey, createdAt, claimedAt, completedAt, lastOutcome, lastMessage
          )
          VALUES (
            :id, :runnerId, :claimToken, :kind, :presetId, :label, :rootPath, :relativePath, :absolutePath,
            :createProject, :projectName, :projectBaseBranch, :projectDeliveryMode, :projectAutoPush, :projectDefaultTaskTitle,
            :projectDefaultPrompt, :profileName, :baseURL, :apiKey, :createdAt, :claimedAt, :completedAt, :lastOutcome, :lastMessage
          )
          ON CONFLICT(id) DO UPDATE SET
            runnerId = excluded.runnerId,
            claimToken = excluded.claimToken,
            kind = excluded.kind,
            presetId = excluded.presetId,
            label = excluded.label,
            rootPath = excluded.rootPath,
            relativePath = excluded.relativePath,
            absolutePath = excluded.absolutePath,
            createProject = excluded.createProject,
            projectName = excluded.projectName,
            projectBaseBranch = excluded.projectBaseBranch,
            projectDeliveryMode = excluded.projectDeliveryMode,
            projectAutoPush = excluded.projectAutoPush,
            projectDefaultTaskTitle = excluded.projectDefaultTaskTitle,
            projectDefaultPrompt = excluded.projectDefaultPrompt,
            profileName = excluded.profileName,
            baseURL = excluded.baseURL,
            apiKey = excluded.apiKey,
            createdAt = excluded.createdAt,
            claimedAt = excluded.claimedAt,
            completedAt = excluded.completedAt,
            lastOutcome = excluded.lastOutcome,
            lastMessage = excluded.lastMessage
        `
      )
      .run({
        ...command,
        claimToken: command.claimToken ?? null,
        createProject: command.createProject ? 1 : 0,
        projectName: command.projectName ?? null,
        projectBaseBranch: command.projectBaseBranch ?? null,
        projectDeliveryMode: command.projectDeliveryMode ?? null,
        projectAutoPush: command.projectAutoPush === undefined ? null : command.projectAutoPush ? 1 : 0,
        projectDefaultTaskTitle: command.projectDefaultTaskTitle ?? null,
        projectDefaultPrompt: command.projectDefaultPrompt ?? null,
        profileName: command.profileName ?? null,
        baseURL: persistedBaseURL,
        apiKey: persistedAPIKey,
        claimedAt: command.claimedAt ?? null,
        completedAt: command.completedAt ?? null,
        lastOutcome: command.lastOutcome ?? null,
        lastMessage: command.lastMessage ?? null
      });
  }

  deleteUtilityCommand(id: string): void {
    this.db.prepare(`DELETE FROM utility_commands WHERE id = ?`).run(id);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runners (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        platform TEXT NOT NULL,
        labelsJson TEXT NOT NULL,
        capabilitiesJson TEXT NOT NULL,
        currentTaskId TEXT,
        currentCommandId TEXT,
        currentCommandKind TEXT,
        currentCommandStartedAt TEXT,
        lastHeartbeatAt TEXT NOT NULL,
        version TEXT,
        hostname TEXT,
        codexConfigProfilesJson TEXT,
        activeCodexConfigProfile TEXT
      );

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        repo TEXT NOT NULL,
        baseBranch TEXT NOT NULL,
        deliveryMode TEXT NOT NULL DEFAULT 'review_required',
        autoPush INTEGER NOT NULL DEFAULT 1,
        defaultTaskTitle TEXT NOT NULL,
        defaultPrompt TEXT NOT NULL,
        isFeatured INTEGER NOT NULL DEFAULT 0,
        runnerId TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        lastSyncedAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS directory_presets (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        rootPath TEXT NOT NULL,
        runnerId TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        workflowKey TEXT NOT NULL,
        deliveryMode TEXT NOT NULL DEFAULT 'review_required',
        autoPush INTEGER NOT NULL DEFAULT 1,
        title TEXT NOT NULL,
        prompt TEXT NOT NULL,
        repo TEXT NOT NULL,
        baseBranch TEXT NOT NULL,
        projectId TEXT,
        projectName TEXT,
        branchMode TEXT NOT NULL DEFAULT 'new_branch',
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

      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        taskId TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        detail TEXT NOT NULL,
        status TEXT NOT NULL,
        payloadJson TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        resolvedAt TEXT
      );

      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        taskId TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        createdAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        taskId TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        createdAt TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        detail TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        sessionAlias TEXT PRIMARY KEY REFERENCES tasks(sessionAlias) ON DELETE CASCADE,
        executorType TEXT NOT NULL,
        runnerId TEXT NOT NULL,
        threadId TEXT NOT NULL,
        cwd TEXT NOT NULL,
        materializedFromHistory INTEGER NOT NULL,
        lastTurnAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS commands (
        id TEXT PRIMARY KEY,
        taskId TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        runnerId TEXT NOT NULL,
        kind TEXT NOT NULL,
        prompt TEXT,
        commitMessage TEXT,
        prTitle TEXT,
        targetBranch TEXT,
        reviewMode TEXT,
        dirtyWorkspaceDecision TEXT,
        protectedGitCommandJson TEXT,
        allowedProtectedGitCommandKindsJson TEXT,
        createdAt TEXT NOT NULL,
        claimedAt TEXT,
        claimToken TEXT,
        completedAt TEXT
      );

      CREATE TABLE IF NOT EXISTS utility_commands (
        id TEXT PRIMARY KEY,
        runnerId TEXT NOT NULL,
        claimToken TEXT,
        kind TEXT NOT NULL,
        presetId TEXT NOT NULL,
        label TEXT NOT NULL,
        rootPath TEXT NOT NULL,
        relativePath TEXT NOT NULL,
        absolutePath TEXT NOT NULL,
        createProject INTEGER NOT NULL DEFAULT 0,
        projectName TEXT,
        projectBaseBranch TEXT,
        projectDeliveryMode TEXT,
        projectAutoPush INTEGER,
        projectDefaultTaskTitle TEXT,
        projectDefaultPrompt TEXT,
        profileName TEXT,
        baseURL TEXT,
        apiKey TEXT,
        createdAt TEXT NOT NULL,
        claimedAt TEXT,
        completedAt TEXT,
        lastOutcome TEXT,
        lastMessage TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_projects_runnerId ON projects(runnerId);
      CREATE INDEX IF NOT EXISTS idx_directory_presets_runnerId ON directory_presets(runnerId);
      CREATE INDEX IF NOT EXISTS idx_tasks_projectId_updatedAt ON tasks(projectId, updatedAt DESC);
      CREATE INDEX IF NOT EXISTS idx_tasks_updatedAt ON tasks(updatedAt DESC);
      CREATE INDEX IF NOT EXISTS idx_approvals_taskId_createdAt ON approvals(taskId, createdAt DESC);
      CREATE INDEX IF NOT EXISTS idx_artifacts_taskId_createdAt ON artifacts(taskId, createdAt DESC);
      CREATE INDEX IF NOT EXISTS idx_events_taskId_createdAt ON events(taskId, createdAt DESC);
      CREATE INDEX IF NOT EXISTS idx_commands_runnerId_createdAt ON commands(runnerId, createdAt);
      CREATE INDEX IF NOT EXISTS idx_utility_commands_runnerId_createdAt ON utility_commands(runnerId, createdAt);
    `);

    this.ensureColumn("projects", "isFeatured", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("projects", "deliveryMode", "TEXT NOT NULL DEFAULT 'review_required'");
    this.ensureColumn("projects", "autoPush", "INTEGER NOT NULL DEFAULT 1");
    this.ensureColumn("tasks", "branchMode", "TEXT NOT NULL DEFAULT 'new_branch'");
    this.ensureColumn("tasks", "branchName", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("tasks", "deliveryMode", "TEXT NOT NULL DEFAULT 'review_required'");
    this.ensureColumn("tasks", "autoPush", "INTEGER NOT NULL DEFAULT 1");
    this.ensureColumn("tasks", "executionBranch", "TEXT");
    this.ensureColumn("tasks", "reviewPlatform", "TEXT");
    this.ensureColumn("tasks", "reviewTargetBranchesJson", "TEXT");
    this.ensureColumn("tasks", "dirtyWorkspaceJson", "TEXT");
    this.ensureColumn("tasks", "stopRequestedAt", "TEXT");
    this.ensureColumn("commands", "prTitle", "TEXT");
    this.ensureColumn("commands", "targetBranch", "TEXT");
    this.ensureColumn("commands", "reviewMode", "TEXT");
    this.ensureColumn("commands", "dirtyWorkspaceDecision", "TEXT");
    this.ensureColumn("commands", "protectedGitCommandJson", "TEXT");
    this.ensureColumn("commands", "allowedProtectedGitCommandKindsJson", "TEXT");
    this.ensureColumn("commands", "claimToken", "TEXT");
    this.ensureColumn("commands", "completedAt", "TEXT");
    this.ensureColumn("runners", "codexConfigProfilesJson", "TEXT");
    this.ensureColumn("runners", "activeCodexConfigProfile", "TEXT");
    this.ensureColumn("runners", "currentCommandId", "TEXT");
    this.ensureColumn("runners", "currentCommandKind", "TEXT");
    this.ensureColumn("runners", "currentCommandStartedAt", "TEXT");
    this.ensureColumn("utility_commands", "claimToken", "TEXT");
    this.ensureColumn("utility_commands", "createProject", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("utility_commands", "projectName", "TEXT");
    this.ensureColumn("utility_commands", "projectBaseBranch", "TEXT");
    this.ensureColumn("utility_commands", "projectDeliveryMode", "TEXT");
    this.ensureColumn("utility_commands", "projectAutoPush", "INTEGER");
    this.ensureColumn("utility_commands", "projectDefaultTaskTitle", "TEXT");
    this.ensureColumn("utility_commands", "projectDefaultPrompt", "TEXT");
    this.ensureColumn("utility_commands", "profileName", "TEXT");
    this.ensureColumn("utility_commands", "baseURL", "TEXT");
    this.ensureColumn("utility_commands", "apiKey", "TEXT");
  }

  private loadProjects(): ProjectRecord[] {
    const rows = this.db.prepare(`SELECT * FROM projects ORDER BY updatedAt DESC`).all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      repo: String(row.repo),
      baseBranch: String(row.baseBranch),
      deliveryMode: asDeliveryMode(row.deliveryMode),
      autoPush: asBoolean(row.autoPush, true),
      defaultTaskTitle: String(row.defaultTaskTitle),
      defaultPrompt: String(row.defaultPrompt),
      isFeatured: Number(row.isFeatured ?? 0) === 1,
      runnerId: String(row.runnerId),
      createdAt: String(row.createdAt),
      updatedAt: String(row.updatedAt),
      lastSyncedAt: String(row.lastSyncedAt)
    }));
  }

  private loadDirectoryPresets(): DirectoryPresetRecord[] {
    const rows = this.db.prepare(`SELECT * FROM directory_presets ORDER BY updatedAt DESC`).all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      label: String(row.label),
      rootPath: String(row.rootPath),
      runnerId: String(row.runnerId),
      createdAt: String(row.createdAt),
      updatedAt: String(row.updatedAt)
    }));
  }

  private ensureColumn(tableName: string, columnName: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name?: string }>;
    if (columns.some((column) => column.name === columnName)) {
      return;
    }

    this.db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition};`);
  }

  private loadRunners(): RunnerInfo[] {
    const rows = this.db.prepare(`SELECT * FROM runners ORDER BY lastHeartbeatAt DESC`).all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      platform: "macOS",
      isOnline: false,
      labels: parseJSON<string[]>(String(row.labelsJson ?? "[]"), []),
      capabilities: parseJSON<string[]>(String(row.capabilitiesJson ?? "[]"), []),
      currentTaskId: asOptionalString(row.currentTaskId),
      currentCommandId: asOptionalString(row.currentCommandId),
      currentCommandKind: asOptionalString(row.currentCommandKind),
      currentCommandStartedAt: asOptionalString(row.currentCommandStartedAt),
      lastHeartbeatAt: String(row.lastHeartbeatAt),
      version: asOptionalString(row.version),
      hostname: asOptionalString(row.hostname),
      codexConfigProfiles: parseJSON<string[] | undefined>(asOptionalString(row.codexConfigProfilesJson) ?? "", undefined),
      activeCodexConfigProfile: asOptionalString(row.activeCodexConfigProfile)
    }));
  }

  private loadUtilityCommands(): UtilityCommandRecord[] {
    const rows = this.db.prepare(`SELECT * FROM utility_commands ORDER BY createdAt ASC`).all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      runnerId: String(row.runnerId),
      claimToken: asOptionalString(row.claimToken),
      kind: String(row.kind) as UtilityCommandRecord["kind"],
      presetId: String(row.presetId),
      label: String(row.label),
      rootPath: String(row.rootPath),
      relativePath: String(row.relativePath),
      absolutePath: String(row.absolutePath),
      createProject: asBoolean(row.createProject, false),
      projectName: asOptionalString(row.projectName),
      projectBaseBranch: asOptionalString(row.projectBaseBranch),
      projectDeliveryMode: asOptionalDeliveryMode(row.projectDeliveryMode),
      projectAutoPush: row.projectAutoPush === null || row.projectAutoPush === undefined
        ? undefined
        : asBoolean(row.projectAutoPush, false),
      projectDefaultTaskTitle: asOptionalString(row.projectDefaultTaskTitle),
      projectDefaultPrompt: asOptionalString(row.projectDefaultPrompt),
      profileName: asOptionalString(row.profileName),
      baseURL: asOptionalString(row.baseURL),
      apiKey: asOptionalString(row.apiKey),
      createdAt: String(row.createdAt),
      claimedAt: asOptionalString(row.claimedAt),
      completedAt: asOptionalString(row.completedAt),
      lastOutcome: (asOptionalString(row.lastOutcome) as "completed" | "failed" | undefined),
      lastMessage: asOptionalString(row.lastMessage)
    }));
  }

  private loadTasks(): TaskRecord[] {
    const rows = this.db.prepare(`SELECT * FROM tasks ORDER BY updatedAt DESC`).all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      workflowKey: "coding_session",
      deliveryMode: asDeliveryMode(row.deliveryMode),
      autoPush: asBoolean(row.autoPush, true),
      title: String(row.title),
      prompt: String(row.prompt),
      repo: String(row.repo),
      baseBranch: String(row.baseBranch),
      projectId: asOptionalString(row.projectId),
      projectName: asOptionalString(row.projectName),
      branchMode: asTaskBranchMode(row.branchMode),
      branchName: asOptionalString(row.branchName),
      executionBranch: asOptionalString(row.executionBranch),
      reviewPlatform: asOptionalString(row.reviewPlatform) as TaskRecord["reviewPlatform"],
      reviewTargetBranches: parseJSON<string[] | undefined>(asOptionalString(row.reviewTargetBranchesJson) ?? "", undefined),
      dirtyWorkspace: parseJSON<TaskRecord["dirtyWorkspace"]>(asOptionalString(row.dirtyWorkspaceJson) ?? "", undefined),
      executionMode: row.executionMode === "resume_thread" ? "resume_thread" : "new_thread",
      resumeThreadId: asOptionalString(row.resumeThreadId),
      stopRequestedAt: asOptionalString(row.stopRequestedAt),
      status: String(row.status) as TaskRecord["status"],
      runnerId: asOptionalString(row.runnerId),
      sessionAlias: String(row.sessionAlias),
      summary: String(row.summary),
      reportURL: asOptionalString(row.reportURL),
      lastPublishedAt: asOptionalString(row.lastPublishedAt),
      latestResultSummary: asOptionalString(row.latestResultSummary),
      createdAt: String(row.createdAt),
      updatedAt: String(row.updatedAt)
    }));
  }

  private loadApprovals(): ApprovalRequest[] {
    const rows = this.db.prepare(`SELECT * FROM approvals ORDER BY createdAt DESC`).all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      taskId: String(row.taskId),
      type: String(row.type) as ApprovalRequest["type"],
      title: String(row.title),
      detail: String(row.detail),
      status: String(row.status) as ApprovalRequest["status"],
      payload: parseJSON<Record<string, string>>(String(row.payloadJson ?? "{}"), {}),
      createdAt: String(row.createdAt),
      resolvedAt: asOptionalString(row.resolvedAt)
    }));
  }

  private loadArtifacts(): Artifact[] {
    const rows = this.db.prepare(`SELECT * FROM artifacts ORDER BY createdAt DESC`).all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      taskId: String(row.taskId),
      kind: String(row.kind) as Artifact["kind"],
      title: String(row.title),
      summary: String(row.summary),
      createdAt: String(row.createdAt)
    }));
  }

  private loadEvents(): TaskEvent[] {
    const rows = this.db.prepare(`SELECT * FROM events ORDER BY createdAt ASC`).all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      taskId: String(row.taskId),
      createdAt: String(row.createdAt),
      kind: String(row.kind),
      title: String(row.title),
      detail: String(row.detail)
    }));
  }

  private loadSessions(): ExecutorSession[] {
    const rows = this.db.prepare(`SELECT * FROM sessions`).all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      sessionAlias: String(row.sessionAlias),
      executorType: String(row.executorType) as ExecutorSession["executorType"],
      runnerId: String(row.runnerId),
      threadId: String(row.threadId),
      cwd: String(row.cwd),
      materializedFromHistory: Number(row.materializedFromHistory) === 1,
      lastTurnAt: String(row.lastTurnAt)
    }));
  }

  private loadCommands(): PendingCommandRecord[] {
    const rows = this.db.prepare(`SELECT * FROM commands ORDER BY createdAt ASC`).all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      taskId: String(row.taskId),
      runnerId: String(row.runnerId),
      kind: String(row.kind),
      prompt: asOptionalString(row.prompt),
      commitMessage: asOptionalString(row.commitMessage),
      prTitle: asOptionalString(row.prTitle),
      targetBranch: asOptionalString(row.targetBranch),
      reviewMode: asOptionalString(row.reviewMode) as PendingCommandRecord["reviewMode"],
      dirtyWorkspaceDecision: asOptionalString(row.dirtyWorkspaceDecision) as DirtyWorkspaceDecision | undefined,
      protectedGitCommand: parseJSON<ProtectedGitCommand | undefined>(asOptionalString(row.protectedGitCommandJson) ?? null, undefined),
      allowedProtectedGitCommandKinds: parseJSON<ProtectedGitCommandKind[] | undefined>(
        asOptionalString(row.allowedProtectedGitCommandKindsJson) ?? null,
        undefined
      ),
      createdAt: String(row.createdAt),
      claimedAt: asOptionalString(row.claimedAt),
      claimToken: asOptionalString(row.claimToken),
      completedAt: asOptionalString(row.completedAt)
    }));
  }
}
