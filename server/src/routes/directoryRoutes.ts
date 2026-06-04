import type { FastifyInstance } from "fastify";
import { createDirectorySchema } from "../domain/models.js";
import type { TaskService } from "../services/taskService.js";

export async function registerDirectoryRoutes(app: FastifyInstance, taskService: TaskService): Promise<void> {
  app.get("/v1/directories", async () => taskService.listDirectoryPresets());

  app.post("/v1/directories/actions/create", async (request) => {
    const input = createDirectorySchema.parse(request.body);
    return taskService.requestDirectoryCreation(input);
  });
}
