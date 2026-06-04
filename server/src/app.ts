import cors from "@fastify/cors";
import Fastify from "fastify";
import { ZodError } from "zod";
import { registerApprovalRoutes } from "./routes/approvalRoutes.js";
import { registerDirectoryRoutes } from "./routes/directoryRoutes.js";
import { registerPairingRoutes } from "./routes/pairingRoutes.js";
import { registerProjectRoutes } from "./routes/projectRoutes.js";
import { registerRunnerRoutes } from "./routes/runnerRoutes.js";
import { registerRunnerControlRoutes } from "./routes/runnerControlRoutes.js";
import { registerSystemRoutes } from "./routes/systemRoutes.js";
import { registerTaskRoutes } from "./routes/taskRoutes.js";
import { registerWorkflowRoutes } from "./routes/workflowRoutes.js";
import { TaskService } from "./services/taskService.js";
import { config } from "./config.js";

function parseJSONBody(body: string | Buffer<ArrayBufferLike>): unknown {
  const text = typeof body === "string" ? body : body.toString("utf8");
  const trimmed = text.trim();
  if (!trimmed) {
    return {};
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    throw new Error("Invalid JSON body");
  }
}

function normalizeRequestPath(url: string | undefined): string {
  return (url ?? "").split("?")[0] ?? "";
}

function requiresUserAuthentication(pathname: string): boolean {
  return (
    pathname.startsWith("/v1/") &&
    !pathname.startsWith("/v1/pairing/") &&
    !pathname.startsWith("/v1/runner/")
  );
}

function extractBearerToken(authorization: string | string[] | undefined): string | undefined {
  if (typeof authorization !== "string") {
    return undefined;
  }

  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim();
}

export async function buildApp(options?: { taskService?: TaskService; userBearerToken?: string }) {
  const app = Fastify({
    logger: true
  });
  const taskService = options?.taskService ?? new TaskService();
  const expectedUserBearerToken = (options?.userBearerToken ?? config.user.bearerToken).trim();

  app.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) => {
    try {
      done(null, parseJSONBody(body));
    } catch (error) {
      done(error as Error, undefined);
    }
  });

  await app.register(cors, {
    origin: config.corsOrigins
  });

  app.addHook("onRequest", async (request) => {
    if (!expectedUserBearerToken || request.method === "OPTIONS") {
      return;
    }

    const pathname = normalizeRequestPath(request.raw.url);
    if (!requiresUserAuthentication(pathname)) {
      return;
    }

    if (extractBearerToken(request.headers.authorization) !== expectedUserBearerToken) {
      throw new Error("User authentication failed");
    }
  });

  app.get("/health", async () => ({
    ok: true
  }));

  await registerPairingRoutes(app);
  await registerSystemRoutes(app, taskService);
  await registerWorkflowRoutes(app, taskService);
  await registerProjectRoutes(app, taskService);
  await registerDirectoryRoutes(app, taskService);
  await registerRunnerRoutes(app, taskService);
  await registerRunnerControlRoutes(app, taskService);
  await registerApprovalRoutes(app, taskService);
  await registerTaskRoutes(app, taskService);

  app.setErrorHandler((error, request, reply) => {
    request.log.error(error);
    if (error instanceof ZodError) {
      reply.status(400).send({
        message: "Validation failed",
        issues: error.issues
      });
      return;
    }

    if (error instanceof Error && error.message === "Invalid JSON body") {
      reply.status(400).send({
        message: error.message
      });
      return;
    }

    if (error instanceof Error && error.message.includes("not found")) {
      reply.status(404).send({
        message: error.message
      });
      return;
    }

    if (error instanceof Error && error.message.includes("authentication failed")) {
      reply.status(401).send({
        message: error.message
      });
      return;
    }

    if (error instanceof Error && error.message.includes("No online runner")) {
      reply.status(503).send({
        message: error.message
      });
      return;
    }

    if (
      error instanceof Error &&
      (
        error.message.includes("instance id missing") ||
        error.message.includes("relativePath must") ||
        error.message.includes("relativePath cannot")
      )
    ) {
      reply.status(400).send({
        message: error.message
      });
      return;
    }

    if (
      error instanceof Error &&
      (
        error.message.includes("already has a queued runner command") ||
        error.message.includes("already has an unfinished task") ||
        error.message.includes("already has a pending approval") ||
        error.message.includes("waiting for a dirty workspace decision") ||
        error.message.includes("dirty workspace decision") ||
        error.message.includes("cannot create pull requests yet") ||
        error.message.includes("cannot create merge requests yet") ||
        error.message.includes("has not identified whether this repository uses GitHub or GitLab yet") ||
        error.message.includes("stop request in progress") ||
        error.message.includes("instance mismatch") ||
        error.message.includes("claim token mismatch") ||
        error.message.includes("missing command identity") ||
        error.message.includes("not currently claimed") ||
        error.message.includes("queued utility command") ||
        error.message.includes("queued Codex config action") ||
        error.message.includes("busy with task") ||
        error.message.includes("already has a queued create request") ||
        (error.message.includes("Codex config profile") && error.message.includes("already exists")) ||
        (error.message.includes("Codex config profile") && error.message.includes("cannot be deleted")) ||
        error.message.includes("must be completed, failed, or canceled before it can be deleted") ||
        error.message.includes("cannot be deleted yet") ||
        error.message.includes("is already completed") ||
        error.message.includes("is already failed") ||
        error.message.includes("is already canceled")
      )
    ) {
      reply.status(409).send({
        message: error.message
      });
      return;
    }

    reply.status(500).send({
      message: error instanceof Error ? error.message : "Unexpected server error"
    });
  });

  return app;
}
