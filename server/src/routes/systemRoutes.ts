import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { createCodexConfigSchema, deleteCodexConfigSchema, switchCodexConfigSchema } from "../domain/models.js";
import type { TaskService } from "../services/taskService.js";

export async function registerSystemRoutes(app: FastifyInstance, taskService: TaskService): Promise<void> {
  app.get("/v1/system/summary", async () => config.toPublicSummary(taskService.getCodexConfigState()));

  app.post("/v1/system/codex-configs/switch", async (request) => {
    const input = switchCodexConfigSchema.parse(request.body);
    return taskService.switchCodexConfig(input.profileName);
  });

  app.post("/v1/system/codex-configs/create", async (request) => {
    const input = createCodexConfigSchema.parse(request.body);
    return taskService.createCodexConfig(input.profileName, input.baseURL, input.apiKey);
  });

  app.post("/v1/system/codex-configs/delete", async (request) => {
    const input = deleteCodexConfigSchema.parse(request.body);
    return taskService.deleteCodexConfig(input.profileName);
  });
}
