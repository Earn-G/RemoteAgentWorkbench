import os from "node:os";
import path from "node:path";
import type { CodexConfigState } from "./domain/models.js";

type CorsOrigins = true | string[];

export interface ServerConfigSummary {
  publicBaseURL: string;
  corsOrigins: string[];
  userAuthConfigured: boolean;
  runnerAuthConfigured: boolean;
  deployment: {
    sshHost: string;
    sshUser: string;
    deployDir: string;
    envFile: string;
    caddyfile: string;
  };
  server: {
    host: string;
    port: number;
    publicBaseURL: string;
    dataRoot: string;
    databasePath: string;
    taskRetentionDays: number;
  };
  runner: {
    offlineThresholdMs: number;
    claimTimeoutMs: number;
    sharedSecretConfigured: boolean;
  };
  codexConfig: CodexConfigState & {
    protectedProfileNames: string[];
  };
}

function expandHomeDirectory(input: string, homeDirectory = os.homedir()): string {
  const trimmed = input.trim();
  if (trimmed === "~") {
    return homeDirectory;
  }
  if (trimmed.startsWith("~/")) {
    return path.join(homeDirectory, trimmed.slice(2));
  }
  return trimmed;
}

function normalizePath(input: string, homeDirectory = os.homedir()): string {
  return path.resolve(expandHomeDirectory(input, homeDirectory));
}

function normalizeRequiredPath(value: string | undefined, fallback: string, fieldName: string): string {
  const candidate = value?.trim().length ? value : fallback;
  const normalized = candidate ? normalizePath(candidate) : "";
  if (!normalized) {
    throw new Error(`[server config] ${fieldName} must not be empty`);
  }
  return normalized;
}

function normalizeOptionalPath(value: string | undefined): string {
  if (!value || value.trim().length === 0) {
    return "";
  }
  return normalizePath(value);
}

function normalizePositiveInteger(value: string | undefined, fallback: number, fieldName: string): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`[server config] ${fieldName} must be a positive integer`);
  }
  return parsed;
}

function normalizePort(value: string | undefined, fallback: number): number {
  const parsed = normalizePositiveInteger(value, fallback, "PORT");
  if (parsed > 65535) {
    throw new Error("[server config] PORT must be between 1 and 65535");
  }
  return parsed;
}

function normalizeURL(value: string | undefined, fallback: string, fieldName: string): string {
  const candidate = value?.trim().length ? value : fallback;
  try {
    return new URL(candidate).toString().replace(/\/$/, "");
  } catch {
    throw new Error(`[server config] ${fieldName} must be a valid URL`);
  }
}

function normalizeOptionalURL(value: string | undefined, fieldName: string): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return "";
  }
  try {
    return new URL(trimmed).toString().replace(/\/$/, "");
  } catch {
    throw new Error(`[server config] ${fieldName} must be a valid URL`);
  }
}

function parseCorsOrigins(input: string | undefined): CorsOrigins {
  const candidate = input?.trim() ?? "";
  if (!candidate || candidate === "*") {
    return true;
  }

  const origins = Array.from(new Set(
    candidate
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => {
        try {
          return new URL(value).origin;
        } catch {
          throw new Error(`[server config] CORS_ORIGINS contains an invalid URL origin: ${value}`);
        }
      })
  ));

  return origins.length > 0 ? origins : true;
}

export class ServerConfig {
  readonly host: string;
  readonly port: number;
  readonly publicBaseURL: string;
  readonly corsOrigins: CorsOrigins;
  readonly dataRoot: string;
  readonly database: {
    path: string;
    taskRetentionDays: number;
  };
  readonly user: {
    bearerToken: string;
  };
  readonly deployment: {
    sshHost: string;
    sshUser: string;
    deployDir: string;
    envFile: string;
    caddyfile: string;
  };
  readonly runner: {
    sharedSecret: string;
    offlineThresholdMs: number;
    claimTimeoutMs: number;
  };

  constructor(input: {
    host: string;
    port: number;
    publicBaseURL: string;
    corsOrigins: CorsOrigins;
    dataRoot: string;
    databasePath: string;
    taskRetentionDays: number;
    userBearerToken: string;
    deployment: {
      sshHost: string;
      sshUser: string;
      deployDir: string;
      envFile: string;
      caddyfile: string;
    };
    runnerSharedSecret: string;
    runnerOfflineThresholdMs: number;
    runnerClaimTimeoutMs: number;
  }) {
    this.host = input.host;
    this.port = input.port;
    this.publicBaseURL = input.publicBaseURL;
    this.corsOrigins = input.corsOrigins;
    this.dataRoot = input.dataRoot;
    this.database = {
      path: input.databasePath,
      taskRetentionDays: input.taskRetentionDays
    };
    this.user = {
      bearerToken: input.userBearerToken
    };
    this.deployment = input.deployment;
    this.runner = {
      sharedSecret: input.runnerSharedSecret,
      offlineThresholdMs: input.runnerOfflineThresholdMs,
      claimTimeoutMs: input.runnerClaimTimeoutMs
    };
  }

  toPublicSummary(codexConfig: CodexConfigState): ServerConfigSummary {
    return {
      publicBaseURL: this.publicBaseURL,
      corsOrigins: this.corsOrigins === true ? ["*"] : [...this.corsOrigins],
      userAuthConfigured: this.user.bearerToken.trim().length > 0,
      runnerAuthConfigured: this.runner.sharedSecret.trim().length > 0,
      deployment: {
        ...this.deployment
      },
      server: {
        host: this.host,
        port: this.port,
        publicBaseURL: this.publicBaseURL,
        dataRoot: this.dataRoot,
        databasePath: this.database.path,
        taskRetentionDays: this.database.taskRetentionDays
      },
      runner: {
        offlineThresholdMs: this.runner.offlineThresholdMs,
        claimTimeoutMs: this.runner.claimTimeoutMs,
        sharedSecretConfigured: this.runner.sharedSecret.trim().length > 0
      },
      codexConfig: {
        ...codexConfig,
        profiles: [...codexConfig.profiles],
        protectedProfileNames: ["1000", "plus"]
      }
    };
  }
}

export function createServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const dataRoot = normalizeRequiredPath(
    env.DATA_ROOT,
    path.join(os.homedir(), "RemoteAgentWorkbenchServerData"),
    "DATA_ROOT"
  );

  return new ServerConfig({
    host: env.HOST?.trim() || "0.0.0.0",
    port: normalizePort(env.PORT, 8787),
    publicBaseURL: normalizeURL(env.PUBLIC_BASE_URL, "http://127.0.0.1:8787", "PUBLIC_BASE_URL"),
    corsOrigins: parseCorsOrigins(env.CORS_ORIGINS),
    dataRoot,
    databasePath: normalizeRequiredPath(
      env.DATABASE_PATH,
      path.join(dataRoot, "control-plane.sqlite"),
      "DATABASE_PATH"
    ),
    taskRetentionDays: normalizePositiveInteger(env.TASK_RETENTION_DAYS, 30, "TASK_RETENTION_DAYS"),
    userBearerToken: env.USER_BEARER_TOKEN?.trim() ?? "",
    deployment: {
      sshHost: env.DEPLOY_SSH_HOST?.trim() ?? "",
      sshUser: env.DEPLOY_SSH_USER?.trim() ?? "",
      deployDir: normalizeOptionalPath(env.DEPLOY_DIR),
      envFile: normalizeOptionalPath(env.DEPLOY_ENV_FILE),
      caddyfile: normalizeOptionalPath(env.DEPLOY_CADDYFILE)
    },
    runnerSharedSecret: env.RUNNER_SHARED_SECRET?.trim() ?? "",
    runnerOfflineThresholdMs: normalizePositiveInteger(
      env.RUNNER_OFFLINE_THRESHOLD_MS,
      45000,
      "RUNNER_OFFLINE_THRESHOLD_MS"
    ),
    runnerClaimTimeoutMs: normalizePositiveInteger(
      env.RUNNER_CLAIM_TIMEOUT_MS,
      35 * 60 * 1000,
      "RUNNER_CLAIM_TIMEOUT_MS"
    )
  });
}

export const config = createServerConfig();
