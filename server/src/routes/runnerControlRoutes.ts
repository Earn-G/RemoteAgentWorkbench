import type { FastifyInstance, FastifyRequest } from "fastify";
import { config } from "../config.js";
import {
  runnerCompletionSchema,
  runnerDirectorySyncSchema,
  runnerHeartbeatSchema,
  runnerHelloSchema,
  runnerLogSchema,
  runnerProjectSyncSchema,
  runnerUtilityCompletionSchema
} from "../domain/models.js";
import type { TaskService } from "../services/taskService.js";

function requireRunnerSecret(request: FastifyRequest): void {
  const configured = config.runner.sharedSecret.trim();
  if (!configured) {
    return;
  }

  const provided = request.headers["x-runner-secret"];
  if (typeof provided !== "string" || provided !== configured) {
    throw new Error("Runner authentication failed");
  }
}

function requireRunnerInstanceId(request: FastifyRequest): string {
  const provided = request.headers["x-runner-instance-id"];
  if (typeof provided !== "string" || provided.trim().length === 0) {
    throw new Error("Runner instance id missing");
  }
  return provided.trim();
}

function requireCommandIdentity(input: { commandId?: string; claimToken?: string }, label: string): void {
  if (!input.commandId?.trim() || !input.claimToken?.trim()) {
    throw new Error(`${label} is missing command identity`);
  }
}

export async function registerRunnerControlRoutes(app: FastifyInstance, taskService: TaskService): Promise<void> {
  app.post("/v1/runner/hello", async (request) => {
    requireRunnerSecret(request);
    const runnerInstanceId = requireRunnerInstanceId(request);
    const input = runnerHelloSchema.parse(request.body);
    return taskService.upsertRunner(input, runnerInstanceId);
  });

  app.post("/v1/runner/:runnerId/heartbeat", async (request) => {
    requireRunnerSecret(request);
    const runnerInstanceId = requireRunnerInstanceId(request);
    const runnerId = (request.params as { runnerId: string }).runnerId;
    const input = runnerHeartbeatSchema.parse(request.body);
    return taskService.heartbeatRunner(runnerId, input, runnerInstanceId);
  });

  app.post("/v1/runner/:runnerId/projects/sync", async (request) => {
    requireRunnerSecret(request);
    const runnerInstanceId = requireRunnerInstanceId(request);
    const runnerId = (request.params as { runnerId: string }).runnerId;
    const input = runnerProjectSyncSchema.parse(request.body);
    return taskService.syncRunnerProjects(runnerId, input.projects, runnerInstanceId);
  });

  app.post("/v1/runner/:runnerId/directories/sync", async (request) => {
    requireRunnerSecret(request);
    const runnerInstanceId = requireRunnerInstanceId(request);
    const runnerId = (request.params as { runnerId: string }).runnerId;
    const input = runnerDirectorySyncSchema.parse(request.body);
    return taskService.syncRunnerDirectoryPresets(runnerId, input.presets, runnerInstanceId);
  });

  app.post("/v1/runner/:runnerId/claim", async (request) => {
    requireRunnerSecret(request);
    const runnerInstanceId = requireRunnerInstanceId(request);
    const runnerId = (request.params as { runnerId: string }).runnerId;
    return taskService.claimNextCommand(runnerId, runnerInstanceId) ?? null;
  });

  app.post("/v1/runner/:runnerId/utilities/claim", async (request) => {
    requireRunnerSecret(request);
    const runnerInstanceId = requireRunnerInstanceId(request);
    const runnerId = (request.params as { runnerId: string }).runnerId;
    return taskService.claimNextUtilityCommand(runnerId, runnerInstanceId) ?? null;
  });

  app.post("/v1/runner/:runnerId/tasks/:taskId/log", async (request) => {
    requireRunnerSecret(request);
    const runnerInstanceId = requireRunnerInstanceId(request);
    const { runnerId, taskId } = request.params as { runnerId: string; taskId: string };
    const input = runnerLogSchema.parse(request.body);
    requireCommandIdentity(input, "Runner log payload");
    return taskService.logRunnerProgress(runnerId, taskId, input, runnerInstanceId);
  });

  app.post("/v1/runner/:runnerId/tasks/:taskId/complete", async (request) => {
    requireRunnerSecret(request);
    const runnerInstanceId = requireRunnerInstanceId(request);
    const { runnerId, taskId } = request.params as { runnerId: string; taskId: string };
    const input = runnerCompletionSchema.parse(request.body);
    requireCommandIdentity(input, "Runner completion payload");
    return taskService.completeRunnerCommand(runnerId, taskId, input, runnerInstanceId);
  });

  app.post("/v1/runner/:runnerId/utilities/:commandId/complete", async (request) => {
    requireRunnerSecret(request);
    const runnerInstanceId = requireRunnerInstanceId(request);
    const { runnerId, commandId } = request.params as { runnerId: string; commandId: string };
    const input = runnerUtilityCompletionSchema.parse(request.body);
    if (!input.claimToken?.trim()) {
      throw new Error("Runner utility completion payload is missing command identity");
    }
    taskService.completeUtilityCommand(runnerId, commandId, input, runnerInstanceId);
    return { ok: true };
  });
}
