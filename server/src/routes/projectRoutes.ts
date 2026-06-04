import type { FastifyInstance } from "fastify";
import { createProjectTaskSchema } from "../domain/models.js";
import type { TaskService } from "../services/taskService.js";

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

export async function registerProjectRoutes(app: FastifyInstance, taskService: TaskService): Promise<void> {
  app.get("/v1/projects", async () => taskService.listProjects());

  app.get("/v1/projects/:projectId", async (request, reply) => {
    const projectId = (request.params as { projectId: string }).projectId;
    const project = taskService.getProject(projectId);
    if (!project) {
      reply.status(404);
      return { message: "Project not found" };
    }
    return project;
  });

  app.get("/v1/projects/:projectId/tasks", async (request, reply) => {
    const projectId = (request.params as { projectId: string }).projectId;
    const project = taskService.getProject(projectId);
    if (!project) {
      reply.status(404);
      return { message: "Project not found" };
    }

    const query = request.query as Record<string, unknown>;
    return taskService.listTasks({
      projectId,
      limit: parsePositiveInteger(query.limit),
      cursor: typeof query.cursor === "string" ? query.cursor : undefined,
      status: typeof query.status === "string" ? (query.status as never) : undefined
    });
  });

  app.post("/v1/projects/:projectId/tasks", async (request, reply) => {
    const projectId = (request.params as { projectId: string }).projectId;
    if (!taskService.getProject(projectId)) {
      reply.status(404);
      return { message: "Project not found" };
    }

    const input = createProjectTaskSchema.parse(request.body);
    return taskService.createTaskForProject(projectId, input);
  });
}
