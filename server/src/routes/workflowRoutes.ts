import type { FastifyInstance } from "fastify";
import type { TaskService } from "../services/taskService.js";

export async function registerWorkflowRoutes(app: FastifyInstance, taskService: TaskService): Promise<void> {
  app.get("/v1/workflows", async () => taskService.listWorkflows());
}
