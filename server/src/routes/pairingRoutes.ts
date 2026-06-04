import type { FastifyInstance } from "fastify";
import { pairingCompleteSchema, pairingStartSchema } from "../domain/models.js";

export async function registerPairingRoutes(app: FastifyInstance): Promise<void> {
  app.post("/v1/pairing/start", async (request) => {
    const input = pairingStartSchema.parse(request.body);
    return {
      code: `PAIR-${Math.floor(1000 + Math.random() * 9000)}`,
      expiresInSeconds: 300,
      deviceName: input.deviceName,
      platform: input.platform
    };
  });

  app.post("/v1/pairing/complete", async (request) => {
    const input = pairingCompleteSchema.parse(request.body);
    return {
      accessToken: `dev_${input.code.toLowerCase()}_token`,
      user: {
        id: "user_local",
        displayName: "Fernando"
      }
    };
  });
}
