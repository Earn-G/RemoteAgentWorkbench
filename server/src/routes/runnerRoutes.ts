import type { FastifyInstance } from "fastify";
import type { TaskService } from "../services/taskService.js";

export async function registerRunnerRoutes(app: FastifyInstance, taskService: TaskService): Promise<void> {
  app.get("/v1/runners", async () => taskService.listRunners());
}
