import type { FastifyInstance } from "fastify";
import { createTaskSchema, dirtyWorkspaceDecisionSchema, gitActionSchema, taskMessageSchema } from "../domain/models.js";
import type { GitAction } from "../domain/models.js";
import type { TaskService } from "../services/taskService.js";

function actionFromPath(action: string): GitAction {
  if (action === "commit" || action === "rebase" || action === "push" || action === "create-pr") {
    return action === "create-pr" ? "create_pr" : action;
  }
  throw new Error(`Unsupported git action ${action}`);
}

function parsePositiveInteger(input: unknown): number | undefined {
  if (typeof input !== "string" || input.trim().length === 0) {
    return undefined;
  }

  const value = Number(input);
  if (!Number.isFinite(value) || value <= 0) {
    return undefined;
  }

  return Math.floor(value);
}

export async function registerTaskRoutes(app: FastifyInstance, taskService: TaskService): Promise<void> {
  app.get("/v1/tasks", async (request) => {
    const query = request.query as Record<string, unknown>;
    return taskService.listTasks({
      projectId: typeof query.projectId === "string" ? query.projectId : undefined,
      limit: parsePositiveInteger(query.limit),
      cursor: typeof query.cursor === "string" ? query.cursor : undefined,
      status: typeof query.status === "string" ? (query.status as never) : undefined
    });
  });

  app.post("/v1/tasks", async (request) => {
    const input = createTaskSchema.parse(request.body);
    return taskService.createTask(input);
  });

  app.get("/v1/tasks/:taskId", async (request, reply) => {
    const taskId = (request.params as { taskId: string }).taskId;
    const query = request.query as Record<string, unknown>;
    const view = typeof query.view === "string" ? query.view : "summary";
    const task = view === "full" ? taskService.getTask(taskId) : taskService.getTaskStatusView(taskId);
    if (!task) {
      reply.status(404);
      return { message: "Task not found" };
    }
    return task;
  });

  app.delete("/v1/tasks/:taskId", async (request, reply) => {
    const taskId = (request.params as { taskId: string }).taskId;
    taskService.deleteTaskRecord(taskId);
    reply.status(204);
    return null;
  });

  app.post("/v1/tasks/:taskId/messages", async (request) => {
    const taskId = (request.params as { taskId: string }).taskId;
    const input = taskMessageSchema.parse(request.body);
    return taskService.addUserMessage(taskId, input.message);
  });

  app.post("/v1/tasks/:taskId/actions/continue", async (request) => {
    const taskId = (request.params as { taskId: string }).taskId;
    return taskService.continueTask(taskId);
  });

  app.post("/v1/tasks/:taskId/actions/complete", async (request) => {
    const taskId = (request.params as { taskId: string }).taskId;
    return taskService.completeTask(taskId);
  });

  app.post("/v1/tasks/:taskId/actions/open-in-codex-app", async (request) => {
    const taskId = (request.params as { taskId: string }).taskId;
    return taskService.openInCodexApp(taskId);
  });

  app.post("/v1/tasks/:taskId/actions/recheck-workspace", async (request) => {
    const taskId = (request.params as { taskId: string }).taskId;
    return taskService.inspectWorkspace(taskId);
  });

  app.post("/v1/tasks/:taskId/actions/stop", async (request) => {
    const taskId = (request.params as { taskId: string }).taskId;
    return taskService.stopTask(taskId);
  });

  app.post("/v1/tasks/:taskId/actions/dirty-workspace", async (request) => {
    const taskId = (request.params as { taskId: string }).taskId;
    const input = dirtyWorkspaceDecisionSchema.parse(request.body);
    return taskService.resolveDirtyWorkspaceDecision(taskId, input.decision);
  });

  app.post("/v1/tasks/:taskId/git/:action", async (request) => {
    const taskId = (request.params as { taskId: string; action: string }).taskId;
    const action = actionFromPath((request.params as { taskId: string; action: string }).action);
    const input = gitActionSchema.parse(request.body ?? {});
    return taskService.requestGitAction(taskId, action, input.message, input.title, input.targetBranch, input.reviewMode);
  });

  app.get("/v1/tasks/:taskId/events", async (request, reply) => {
    const taskId = (request.params as { taskId: string }).taskId;
    const task = taskService.getTask(taskId);
    if (!task) {
      reply.status(404);
      return { message: "Task not found" };
    }

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive"
    });

    reply.raw.write(`event: task.snapshot\n`);
    reply.raw.write(`data: ${JSON.stringify(task)}\n\n`);

    const unsubscribe = taskService.subscribe(taskId, ({ snapshot }) => {
      reply.raw.write(`event: task.snapshot\n`);
      reply.raw.write(`data: ${JSON.stringify(snapshot)}\n\n`);
    });

    const heartbeat = setInterval(() => {
      reply.raw.write(`event: heartbeat\n`);
      reply.raw.write(`data: {}\n\n`);
    }, 15000);

    request.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
      reply.raw.end();
    });

    return reply.hijack();
  });
}
