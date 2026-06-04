import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import type {
  DirectoryPresetRecord,
  ProjectSummary,
  RunnerAssignment,
  RunnerCompletionPayload,
  RunnerLogPayload,
  TaskSnapshot,
  UtilityCompletionPayload,
  UtilityRunnerAssignment
} from "./models.js";

interface RunnerHelloPayload {
  id: string;
  name: string;
  platform: "macOS";
  labels: string[];
  capabilities: string[];
  version: string;
  hostname: string;
  codexConfigProfiles?: string[];
  activeCodexConfigProfile?: string;
}

interface RunnerHeartbeatPayload {
  currentTaskId?: string;
  currentCommandId?: string;
  currentCommandKind?: string;
  currentCommandStartedAt?: string;
  version?: string;
  hostname?: string;
  codexConfigProfiles?: string[];
  activeCodexConfigProfile?: string;
}

export class RunnerInstanceMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunnerInstanceMismatchError";
  }
}

export function isRunnerInstanceMismatchError(error: unknown): error is RunnerInstanceMismatchError {
  return error instanceof RunnerInstanceMismatchError;
}

export class ControlPlaneClient {
  private readonly baseURL: string;
  readonly instanceId: string;

  constructor(baseURL = config.serverBaseURL, instanceId = randomUUID()) {
    this.baseURL = baseURL.endsWith("/") ? baseURL.slice(0, -1) : baseURL;
    this.instanceId = instanceId;
  }

  async hello(payload: RunnerHelloPayload): Promise<void> {
    await this.post("/v1/runner/hello", payload);
  }

  async heartbeat(runnerId: string, payload: RunnerHeartbeatPayload): Promise<void> {
    await this.post(`/v1/runner/${runnerId}/heartbeat`, payload);
  }

  async syncProjects(
    runnerId: string,
    payload: {
      projects: Array<{
        id: string;
        name: string;
        repo: string;
        baseBranch: string;
        deliveryMode: "review_required" | "direct_commit";
        autoPush: boolean;
        defaultTaskTitle: string;
        defaultPrompt: string;
        isFeatured: boolean;
      }>;
    }
  ): Promise<ProjectSummary[]> {
    return this.post(`/v1/runner/${runnerId}/projects/sync`, payload);
  }

  async syncDirectoryPresets(
    runnerId: string,
    payload: {
      presets: Array<{
        id: string;
        label: string;
        rootPath: string;
      }>;
    }
  ): Promise<DirectoryPresetRecord[]> {
    return this.post(`/v1/runner/${runnerId}/directories/sync`, payload);
  }

  async claim(runnerId: string): Promise<RunnerAssignment | null> {
    return this.post(`/v1/runner/${runnerId}/claim`, {});
  }

  async claimUtility(runnerId: string): Promise<UtilityRunnerAssignment | null> {
    return this.post(`/v1/runner/${runnerId}/utilities/claim`, {});
  }

  async log(runnerId: string, taskId: string, payload: RunnerLogPayload): Promise<void> {
    await this.post(`/v1/runner/${runnerId}/tasks/${taskId}/log`, payload);
  }

  async complete(runnerId: string, taskId: string, payload: RunnerCompletionPayload): Promise<void> {
    await this.post(`/v1/runner/${runnerId}/tasks/${taskId}/complete`, payload);
  }

  async completeUtility(runnerId: string, commandId: string, payload: UtilityCompletionPayload): Promise<void> {
    await this.post(`/v1/runner/${runnerId}/utilities/${commandId}/complete`, payload);
  }

  async fetchTask(taskId: string): Promise<TaskSnapshot> {
    return this.get(`/v1/tasks/${taskId}`);
  }

  private async post<Response>(path: string, payload: unknown): Promise<Response> {
    return this.request<Response>(path, {
      method: "POST",
      headers: this.buildHeaders({
        "content-type": "application/json"
      }),
      body: JSON.stringify(payload)
    });
  }

  private async get<Response>(path: string): Promise<Response> {
    return this.request<Response>(path, {
      method: "GET",
      headers: this.buildHeaders({
        Accept: "application/json"
      })
    });
  }

  private buildHeaders(headers: Record<string, string>): Record<string, string> {
    return {
      ...headers,
      "x-runner-instance-id": this.instanceId,
      ...(config.runnerSharedSecret.trim().length > 0 ? { "x-runner-secret": config.runnerSharedSecret } : {})
    };
  }

  private async request<Response>(path: string, init: RequestInit): Promise<Response> {
    const response = await fetch(`${this.baseURL}${path}`, {
      ...init
    });

    if (!response.ok) {
      const message = await response.text();
      if (response.status === 409 && message.includes("Runner instance mismatch")) {
        throw new RunnerInstanceMismatchError(`Control plane request failed (${response.status}): ${message}`);
      }
      throw new Error(`Control plane request failed (${response.status}): ${message}`);
    }

    if (response.status === 204) {
      return undefined as Response;
    }

    const text = await response.text();
    if (!text) {
      return undefined as Response;
    }

    return JSON.parse(text) as Response;
  }
}
