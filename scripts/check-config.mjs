#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item?.startsWith("--")) {
      continue;
    }
    const key = item.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      result[key] = "true";
      continue;
    }
    result[key] = value;
    index += 1;
  }
  return result;
}

function isValidURL(value) {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function isPositiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0;
}

function isPathLike(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isAbsoluteOrTildePath(value) {
  const trimmed = value.trim();
  return trimmed.startsWith("/") || trimmed === "~" || trimmed.startsWith("~/") || /^[A-Za-z]:[\\/]/.test(trimmed);
}

async function readText(filePath) {
  return fs.readFile(filePath, "utf8");
}

function parseEnv(text) {
  const values = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const separatorIndex = line.indexOf("=");
    if (separatorIndex < 0) {
      continue;
    }
    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();
    if (value.startsWith("\"") && value.endsWith("\"") && value.length >= 2) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function pushIssue(issues, ok, message) {
  issues.push({ ok, message });
}

async function checkServerEnv(filePath) {
  const issues = [];
  const env = parseEnv(await readText(filePath));
  pushIssue(issues, isValidURL(env.PUBLIC_BASE_URL), "PUBLIC_BASE_URL must be a valid URL");
  pushIssue(issues, env.CORS_ORIGINS === "*" || !env.CORS_ORIGINS || env.CORS_ORIGINS.split(",").every(isValidURL), "CORS_ORIGINS must be * or a comma-separated list of URLs");
  pushIssue(issues, isPositiveInteger(env.PORT), "PORT must be a positive integer");
  pushIssue(issues, isPositiveInteger(env.TASK_RETENTION_DAYS), "TASK_RETENTION_DAYS must be a positive integer");
  pushIssue(issues, isPositiveInteger(env.RUNNER_OFFLINE_THRESHOLD_MS), "RUNNER_OFFLINE_THRESHOLD_MS must be a positive integer");
  pushIssue(issues, isPathLike(env.DATA_ROOT), "DATA_ROOT must not be empty");
  pushIssue(issues, isPathLike(env.DATABASE_PATH), "DATABASE_PATH must not be empty");
  if (env.DEPLOY_DIR) {
    pushIssue(issues, isAbsoluteOrTildePath(env.DEPLOY_DIR), "DEPLOY_DIR must be an absolute path or ~/...");
  }
  if (env.DEPLOY_ENV_FILE) {
    pushIssue(issues, isAbsoluteOrTildePath(env.DEPLOY_ENV_FILE), "DEPLOY_ENV_FILE must be an absolute path or ~/...");
  }
  if (env.DEPLOY_CADDYFILE) {
    pushIssue(issues, isAbsoluteOrTildePath(env.DEPLOY_CADDYFILE), "DEPLOY_CADDYFILE must be an absolute path or ~/...");
  }
  return issues;
}

async function checkRunnerEnv(filePath) {
  const issues = [];
  const env = parseEnv(await readText(filePath));
  pushIssue(issues, isValidURL(env.SERVER_BASE_URL), "SERVER_BASE_URL must be a valid URL");
  pushIssue(issues, isValidURL(env.GITLAB_BASE_URL), "GITLAB_BASE_URL must be a valid URL");
  if (env.RUNNER_REPORTS_PUBLIC_BASE_URL) {
    pushIssue(issues, isValidURL(env.RUNNER_REPORTS_PUBLIC_BASE_URL), "RUNNER_REPORTS_PUBLIC_BASE_URL must be a valid URL");
  }

  for (const key of [
    "RUNNER_HEARTBEAT_INTERVAL_MS",
    "RUNNER_POLL_INTERVAL_MS",
    "RUNNER_LOCAL_TASK_RETENTION_DAYS",
    "RUNNER_GIT_PUSH_TIMEOUT_MS",
    "RUNNER_CODEX_RESTART_TIMEOUT_MS",
    "RUNNER_CODEX_RESTART_POLL_INTERVAL_MS"
  ]) {
    pushIssue(issues, isPositiveInteger(env[key]), `${key} must be a positive integer`);
  }

  for (const key of [
    "RUNNER_DATA_ROOT",
    "RUNNER_REPO_CACHE_DIR",
    "RUNNER_WORKSPACE_DIR",
    "RUNNER_TASKS_DIR",
    "RUNNER_PROJECTS_FILE",
    "RUNNER_DIRECTORIES_FILE",
    "RUNNER_LOCK_ROOT_DIR",
    "RUNNER_REQUEST_JOURNAL_PATH",
    "RUNNER_REPORTS_REPO_DIR",
    "RUNNER_CODEX_PROFILES_ROOT"
  ]) {
    pushIssue(issues, isAbsoluteOrTildePath(env[key]), `${key} must be an absolute path or ~/...`);
  }

  if (env.RUNNER_CODEX_HOME) {
    pushIssue(issues, isAbsoluteOrTildePath(env.RUNNER_CODEX_HOME), "RUNNER_CODEX_HOME must be an absolute path or ~/...");
  }

  pushIssue(issues, Boolean(env.RUNNER_ID), "RUNNER_ID must not be empty");
  pushIssue(issues, Boolean(env.RUNNER_NAME), "RUNNER_NAME must not be empty");
  pushIssue(issues, Boolean(env.RUNNER_CODEX_PROFILE_TEMPLATE), "RUNNER_CODEX_PROFILE_TEMPLATE must not be empty");
  return issues;
}

async function checkHostEnv(filePath) {
  const issues = [];
  const env = parseEnv(await readText(filePath));
  for (const key of ["WORKBENCH_ROOT", "WORKBENCH_DATA_ROOT", "WORKBENCH_LOG_ROOT", "RUNNER_ENV_FILE"]) {
    pushIssue(issues, isAbsoluteOrTildePath(env[key]), `${key} must be an absolute path or ~/...`);
  }
  pushIssue(issues, Boolean(env.RUNNER_NODE_BIN), "RUNNER_NODE_BIN must not be empty");
  pushIssue(issues, Boolean(env.RUNNER_LAUNCH_AGENT_LABEL), "RUNNER_LAUNCH_AGENT_LABEL must not be empty");
  return issues;
}

function validateProjectEntry(entry) {
  const requiredStrings = ["id", "name", "repo", "baseBranch", "defaultTaskTitle", "defaultPrompt"];
  if (!requiredStrings.every((key) => typeof entry?.[key] === "string" && entry[key].trim())) {
    return false;
  }
  return typeof entry.deliveryMode === "undefined" || ["review_required", "direct_commit"].includes(entry.deliveryMode);
}

function validateDirectoryEntry(entry) {
  return ["id", "label", "rootPath"].every((key) => typeof entry?.[key] === "string" && entry[key].trim())
    && isAbsoluteOrTildePath(entry.rootPath);
}

async function checkJSONCatalog(filePath, kind) {
  const issues = [];
  const text = await readText(filePath);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    pushIssue(issues, false, `${kind} must be valid JSON`);
    return issues;
  }

  pushIssue(issues, Array.isArray(parsed), `${kind} must be a JSON array`);
  if (!Array.isArray(parsed)) {
    return issues;
  }

  const validator = kind === "projects.json" ? validateProjectEntry : validateDirectoryEntry;
  parsed.forEach((entry, index) => {
    pushIssue(issues, validator(entry), `${kind}[${index}] failed schema validation`);
  });
  return issues;
}

function printSection(title, issues) {
  console.log(`\n[${title}]`);
  for (const issue of issues) {
    console.log(`${issue.ok ? "PASS" : "FAIL"} ${issue.message}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const checks = [];

  if (args["server-env"]) {
    checks.push(["server-env", await checkServerEnv(path.resolve(args["server-env"]))]);
  }
  if (args["runner-env"]) {
    checks.push(["runner-env", await checkRunnerEnv(path.resolve(args["runner-env"]))]);
  }
  if (args["host-env"]) {
    checks.push(["host-env", await checkHostEnv(path.resolve(args["host-env"]))]);
  }
  if (args.projects) {
    checks.push(["projects.json", await checkJSONCatalog(path.resolve(args.projects), "projects.json")]);
  }
  if (args.directories) {
    checks.push(["directories.json", await checkJSONCatalog(path.resolve(args.directories), "directories.json")]);
  }

  if (checks.length === 0) {
    console.error("No inputs provided. Use --server-env, --runner-env, --host-env, --projects, --directories.");
    process.exit(1);
  }

  let failed = false;
  for (const [title, issues] of checks) {
    printSection(title, issues);
    failed ||= issues.some((issue) => !issue.ok);
  }

  if (failed) {
    process.exit(1);
  }
}

await main();
