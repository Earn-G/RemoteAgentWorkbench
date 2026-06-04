import type { FastifyInstance } from "fastify";
import { approvalDecisionSchema } from "../domain/models.js";
import type { TaskService } from "../services/taskService.js";

export async function registerApprovalRoutes(app: FastifyInstance, taskService: TaskService): Promise<void> {
  app.get("/v1/approvals", async () => taskService.listApprovals());

  app.post("/v1/approvals/:approvalId/decision", async (request) => {
    const approvalId = (request.params as { approvalId: string }).approvalId;
    const { decision } = approvalDecisionSchema.parse(request.body);
    return taskService.resolveApproval(approvalId, decision);
  });
}
