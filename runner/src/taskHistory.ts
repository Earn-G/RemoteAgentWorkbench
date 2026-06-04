import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  ExecutorSession,
  RunnerAssignment,
  RunnerCompletionPayload,
  RunnerLogPayload,
  RunnerSessionPatch,
  TaskSnapshot
} from "./models.js";
import { formatBeijingFileTimestamp } from "./time.js";

export interface LocalTaskRecord {
  id: string;
  title: string;
  prompt: string;
  repo: string;
  baseBranch: string;
  projectId?: string;
  projectName?: string;
  status: string;
  summary: string;
  runnerId?: string;
  reportURL?: string;
  lastPublishedAt?: string;
  latestResultSummary?: string;
  createdAt: string;
  updatedAt: string;
  sessionAlias: string;
  threadId?: string;
  workspacePath?: string;
  executionBranch?: string;
  reportNamespace?: string;
  reportRelativePath?: string;
  codexSessionFilePath?: string;
}

interface LocalTaskEventEntry {
  id: string;
  taskId: string;
  recordedAt: string;
  kind: string;
  title: string;
  detail: string;
  artifactPath?: string;
  codexOutputPath?: string;
  reportURL?: string;
}

type PersistedExecutorSession = ExecutorSession & {
  codexSessionFilePath?: string;
};

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "entry";
}

function artifactExtension(title: string): string {
  return title.toLowerCase().includes("jsonl") ? ".jsonl" : ".md";
}

export class TaskHistoryRecorder {
  private readonly codexSessionsRoot: string;
  private readonly threadPathCache = new Map<string, string>();

  constructor(
    private readonly tasksRoot: string,
    codexHome?: string
  ) {
    const baseCodexHome = codexHome?.trim() ? codexHome : path.join(os.homedir(), ".codex");
    this.codexSessionsRoot = path.join(baseCodexHome, "sessions");
  }

  async recordAssignmentClaimed(assignment: RunnerAssignment): Promise<void> {
    await this.syncSnapshot(assignment.task);
    await this.appendEvent(assignment.taskId, {
      kind: "assignment_claimed",
      title: assignment.task.title,
      detail: assignment.prompt ?? assignment.task.prompt
    });
  }

  async recordRunnerLog(taskId: string, payload: RunnerLogPayload): Promise<void> {
    await this.applyRunnerLogPatch(taskId, payload);

    let artifactPath: string | undefined;
    if (payload.artifact) {
      artifactPath = await this.writeArtifact(
        taskId,
        payload.artifact.kind,
        payload.artifact.title,
        payload.artifact.summary
      );
    }

    await this.appendEvent(taskId, {
      kind: payload.kind,
      title: payload.title,
      detail: payload.detail,
      artifactPath
    });
  }

  async recordCodexProgress(taskId: string, detail: string, title = "Codex update"): Promise<void> {
    const normalizedDetail = detail.trim();
    if (!normalizedDetail) {
      return;
    }

    await this.updateTaskRecord(taskId, {
      latestResultSummary: undefined,
      summary: this.summarize(normalizedDetail),
      updatedAt: new Date().toISOString()
    });

    await this.appendEvent(taskId, {
      kind: "codex.turn_progress",
      title,
      detail: normalizedDetail
    });
  }

  async recordCodexTurnOutput(taskId: string, label: string, stdoutLines: string[]): Promise<string | undefined> {
    if (stdoutLines.length === 0) {
      return undefined;
    }

    return this.writeArtifact(taskId, "codex", `${label}.jsonl`, `${stdoutLines.join("\n")}\n`);
  }

  async recordCompletion(
    taskId: string,
    payload: RunnerCompletionPayload,
    snapshot?: TaskSnapshot,
    codexOutputPath?: string
  ): Promise<void> {
    if (snapshot) {
      await this.writeSnapshot(snapshot);
    }

    let title = "Assignment completed";
    let detail = "";
    let artifactPath: string | undefined;

    switch (payload.outcome) {
      case "plan_ready":
        title = "Plan ready";
        detail = payload.planSummary;
        artifactPath = await this.writeArtifact(taskId, "plan", "Execution plan", payload.planSummary);
        break;
      case "turn_complete":
        title = "Implementation update";
        detail = payload.summary;
        artifactPath = await this.writeArtifact(taskId, "diff", "Diff summary", payload.summary);
        if (payload.testsSummary) {
          await this.writeArtifact(taskId, "tests", "Validation summary", payload.testsSummary);
        }
        break;
      case "git_completed":
        title = "Git action completed";
        detail = payload.summary;
        artifactPath = await this.writeArtifact(taskId, "git", "Git result", payload.summary);
        break;
      case "handoff_completed":
        title = "Codex App opened";
        detail = payload.summary;
        artifactPath = await this.writeArtifact(taskId, "handoff", "Codex App handoff", payload.summary);
        break;
      case "failed":
        title = "Assignment failed";
        detail = payload.detail ?? payload.summary;
        break;
    }

    await this.appendEvent(taskId, {
      kind: payload.outcome,
      title,
      detail,
      artifactPath,
      codexOutputPath,
      reportURL: "reportURL" in payload ? payload.reportURL : undefined
    });
  }

  async syncSnapshot(snapshot: TaskSnapshot): Promise<void> {
    await this.writeSnapshot(snapshot);
  }

  async recordAssignmentFailed(taskId: string, detail: string): Promise<void> {
    await this.appendEvent(taskId, {
      kind: "assignment_failed",
      title: "Assignment failed",
      detail
    });
  }

  async saveArtifact(taskId: string, kind: string, title: string, content: string): Promise<string> {
    return this.writeArtifact(taskId, kind, title, content);
  }

  async writeReport(taskId: string, markdown: string): Promise<string> {
    const filePath = path.join(this.taskDir(taskId), "report.md");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, markdown, "utf8");
    return filePath;
  }

  async cleanupExpiredTasks(retentionDays: number): Promise<string[]> {
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
      return [];
    }

    let taskDirectories: string[];
    try {
      taskDirectories = await fs.readdir(this.tasksRoot);
    } catch {
      return [];
    }

    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const removedTaskIds: string[] = [];

    for (const taskDirectory of taskDirectories) {
      const filePath = path.join(this.taskDir(taskDirectory), "task.json");
      let raw: string;
      try {
        raw = await fs.readFile(filePath, "utf8");
      } catch {
        continue;
      }

      let task: Pick<LocalTaskRecord, "id" | "status" | "updatedAt">;
      try {
        task = JSON.parse(raw) as Pick<LocalTaskRecord, "id" | "status" | "updatedAt">;
      } catch {
        continue;
      }

      if (!["completed", "failed", "canceled"].includes(task.status)) {
        continue;
      }

      const updatedAt = new Date(task.updatedAt).getTime();
      if (!Number.isFinite(updatedAt) || updatedAt >= cutoff) {
        continue;
      }

      await fs.rm(this.taskDir(taskDirectory), { recursive: true, force: true });
      removedTaskIds.push(task.id || taskDirectory);
    }

    return removedTaskIds;
  }

  async loadTask(taskId: string): Promise<LocalTaskRecord | undefined> {
    const filePath = path.join(this.taskDir(taskId), "task.json");
    try {
      const raw = await fs.readFile(filePath, "utf8");
      return JSON.parse(raw) as LocalTaskRecord;
    } catch {
      return undefined;
    }
  }

  async loadEvents(taskId: string): Promise<LocalTaskEventEntry[]> {
    const filePath = path.join(this.taskDir(taskId), "events.jsonl");
    try {
      const raw = await fs.readFile(filePath, "utf8");
      return raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line) as LocalTaskEventEntry);
    } catch {
      return [];
    }
  }

  async updateTaskRecord(taskId: string, patch: Partial<LocalTaskRecord>): Promise<void> {
    const existing = (await this.loadTask(taskId)) ?? ({
      id: taskId,
      title: taskId,
      prompt: "",
      repo: "",
      baseBranch: "",
      status: "queued",
      summary: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sessionAlias: `session_${taskId}`
    } satisfies LocalTaskRecord);
    const next: LocalTaskRecord = {
      ...existing,
      ...patch,
      id: existing.id
    };
    const filePath = path.join(this.taskDir(taskId), "task.json");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  }

  async recordExecutionMapping(taskId: string, mapping: { workspacePath: string; executionBranch?: string }): Promise<void> {
    await this.updateTaskRecord(taskId, {
      workspacePath: mapping.workspacePath,
      executionBranch: mapping.executionBranch
    });
  }

  async recordReportMapping(taskId: string, mapping: { reportNamespace: string; reportRelativePath: string }): Promise<void> {
    await this.updateTaskRecord(taskId, {
      reportNamespace: mapping.reportNamespace,
      reportRelativePath: mapping.reportRelativePath
    });
  }

  private async loadSession(taskId: string): Promise<PersistedExecutorSession | undefined> {
    const filePath = path.join(this.taskDir(taskId), "session.json");
    try {
      const raw = await fs.readFile(filePath, "utf8");
      return JSON.parse(raw) as PersistedExecutorSession;
    } catch {
      return undefined;
    }
  }

  private async writeSnapshot(snapshot: TaskSnapshot): Promise<void> {
    const codexSessionFilePath = snapshot.executorSession?.threadId
      ? await this.findCodexSessionFile(snapshot.executorSession.threadId)
      : undefined;

    await this.updateTaskRecord(snapshot.id, {
      id: snapshot.id,
      title: snapshot.title,
      prompt: snapshot.prompt,
      repo: snapshot.repo,
      baseBranch: snapshot.baseBranch,
      projectId: snapshot.projectId,
      projectName: snapshot.projectName,
      status: snapshot.status,
      summary: snapshot.summary,
      runnerId: snapshot.runnerId,
      reportURL: snapshot.reportURL,
      lastPublishedAt: snapshot.lastPublishedAt,
      latestResultSummary: snapshot.latestResultSummary,
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.updatedAt,
      sessionAlias: snapshot.sessionAlias,
      threadId: snapshot.executorSession?.threadId,
      workspacePath: snapshot.executorSession?.cwd,
      codexSessionFilePath
    });

    if (snapshot.executorSession) {
      const sessionPath = path.join(this.taskDir(snapshot.id), "session.json");
      await fs.writeFile(
        sessionPath,
        `${JSON.stringify(
          {
            ...snapshot.executorSession,
            codexSessionFilePath
          },
          null,
          2
        )}\n`,
        "utf8"
      );
    }
  }

  private async applyRunnerLogPatch(taskId: string, payload: RunnerLogPayload): Promise<void> {
    const taskPatch: Partial<LocalTaskRecord> = {};

    if (payload.status) {
      taskPatch.status = payload.status;
    }

    if (payload.summary) {
      taskPatch.summary = payload.summary;
    }

    if (payload.status === "running") {
      taskPatch.latestResultSummary = undefined;
    }

    if (payload.status || payload.summary || payload.session) {
      taskPatch.updatedAt = new Date().toISOString();
    }

    if (payload.session) {
      await this.patchExecutorSession(taskId, payload.session, taskPatch);
      return;
    }

    if (Object.keys(taskPatch).length > 0) {
      await this.updateTaskRecord(taskId, taskPatch);
    }
  }

  private async patchExecutorSession(
    taskId: string,
    patch: RunnerSessionPatch,
    taskPatch: Partial<LocalTaskRecord>
  ): Promise<void> {
    const task = (await this.loadTask(taskId)) ?? ({
      id: taskId,
      title: taskId,
      prompt: "",
      repo: "",
      baseBranch: "",
      status: "queued",
      summary: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sessionAlias: `session_${taskId}`
    } satisfies LocalTaskRecord);
    const existingSession = await this.loadSession(taskId);

    const threadId = patch.threadId ?? existingSession?.threadId ?? task.threadId;
    const codexSessionFilePath = threadId
      ? await this.findCodexSessionFile(threadId)
      : existingSession?.codexSessionFilePath ?? task.codexSessionFilePath;
    const runnerId = existingSession?.runnerId ?? taskPatch.runnerId ?? task.runnerId;

    await this.updateTaskRecord(taskId, {
      ...taskPatch,
      threadId,
      workspacePath: patch.cwd ?? existingSession?.cwd ?? task.workspacePath,
      codexSessionFilePath
    });

    const mergedSession: PersistedExecutorSession | undefined = (() => {
      const sessionAlias = existingSession?.sessionAlias ?? task.sessionAlias;
      const executorType = patch.executorType ?? existingSession?.executorType;
      const cwd = patch.cwd ?? existingSession?.cwd ?? task.workspacePath;
      const materializedFromHistory =
        patch.materializedFromHistory ?? existingSession?.materializedFromHistory;
      const lastTurnAt = patch.lastTurnAt ?? existingSession?.lastTurnAt;

      if (!sessionAlias || !executorType || !runnerId || !threadId || !cwd || materializedFromHistory === undefined || !lastTurnAt) {
        return undefined;
      }

      return {
        sessionAlias,
        executorType,
        runnerId,
        threadId,
        cwd,
        materializedFromHistory,
        lastTurnAt,
        codexSessionFilePath
      };
    })();

    if (!mergedSession) {
      return;
    }

    const sessionPath = path.join(this.taskDir(taskId), "session.json");
    await fs.mkdir(path.dirname(sessionPath), { recursive: true });
    await fs.writeFile(sessionPath, `${JSON.stringify(mergedSession, null, 2)}\n`, "utf8");
  }

  private async appendEvent(taskId: string, input: Omit<LocalTaskEventEntry, "id" | "taskId" | "recordedAt">): Promise<void> {
    const event: LocalTaskEventEntry = {
      id: `local_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      taskId,
      recordedAt: new Date().toISOString(),
      ...input
    };
    const filePath = path.join(this.taskDir(taskId), "events.jsonl");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.appendFile(filePath, `${JSON.stringify(event)}\n`, "utf8");
  }

  private async writeArtifact(taskId: string, kind: string, title: string, content: string): Promise<string> {
    const timestamp = formatBeijingFileTimestamp(new Date());
    const nonce = randomUUID().split("-")[0];
    const fileName = `${timestamp}-${slugify(kind)}-${slugify(title)}-${nonce}${artifactExtension(title)}`;
    const filePath = path.join(this.taskDir(taskId), "artifacts", fileName);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, "utf8");
    return filePath;
  }

  private taskDir(taskId: string): string {
    return path.join(this.tasksRoot, taskId);
  }

  private summarize(value: string, limit = 220): string {
    const compact = value.replace(/\s+/g, " ").trim();
    if (compact.length <= limit) {
      return compact;
    }
    return `${compact.slice(0, limit - 1).trimEnd()}…`;
  }

  private async findCodexSessionFile(threadId: string): Promise<string | undefined> {
    if (this.threadPathCache.has(threadId)) {
      return this.threadPathCache.get(threadId);
    }

    const found = await this.walkForThread(this.codexSessionsRoot, threadId, 0);
    if (found) {
      this.threadPathCache.set(threadId, found);
    }
    return found;
  }

  private async walkForThread(root: string, threadId: string, depth: number): Promise<string | undefined> {
    if (depth > 5) {
      return undefined;
    }

    let entries: Array<{ name: string; isDirectory: () => boolean }>;
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch {
      return undefined;
    }

    for (const entry of entries) {
      const fullPath = path.join(root, entry.name);
      if (entry.isDirectory()) {
        const nested = await this.walkForThread(fullPath, threadId, depth + 1);
        if (nested) {
          return nested;
        }
        continue;
      }

      if (entry.name.includes(threadId)) {
        return fullPath;
      }
    }

    return undefined;
  }
}
