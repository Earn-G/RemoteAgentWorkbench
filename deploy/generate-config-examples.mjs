#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

const defaults = {
  publicDomain: "workbench.example.com",
  publicBaseURL: "https://workbench.example.com",
  localBaseURL: "http://127.0.0.1:8787",
  serverListenHost: "127.0.0.1",
  serverListenPort: 8787,
  serverInstallDir: "/opt/remote-agent-workbench/server",
  serverDataRoot: "/var/lib/remote-agent-workbench/server",
  serverServiceUser: "remoteagent",
  caddyfilePath: "/etc/caddy/Caddyfile",
  runnerId: "runner-local-mac",
  runnerName: "Primary Mac Runner",
  runnerDataRoot: "~/RemoteAgentWorkbenchData",
  runnerWorkbenchRoot: "~/Code/RemoteAgentWorkbench",
  runnerLogRoot: "~/Library/Logs/RemoteAgentWorkbench",
  runnerLaunchAgentLabel: "com.remoteagentworkbench.runner",
  runnerNodeBinary: "/opt/homebrew/bin/node",
  reportsRepoURL: "git@github.com:your-org/remote-agent-reports.git",
  reportsPublicBaseURL: "https://github.com/your-org/remote-agent-reports",
  gitlabBaseURL: "https://gitlab.com",
  codexProfilesRoot: "~/codex-profiles",
  codexProfileTemplate: "1000"
};

function normalizeRepoRoot(relativePath) {
  return path.join(repoRoot, relativePath);
}

function renderServerEnv() {
  return [
    `HOST=${defaults.serverListenHost}`,
    `PORT=${defaults.serverListenPort}`,
    `PUBLIC_BASE_URL=${defaults.publicBaseURL}`,
    "CORS_ORIGINS=*",
    `DATA_ROOT=${defaults.serverDataRoot}`,
    `DATABASE_PATH=${defaults.serverDataRoot}/control-plane.sqlite`,
    "TASK_RETENTION_DAYS=30",
    "USER_BEARER_TOKEN=",
    "RUNNER_SHARED_SECRET=replace-with-a-long-random-secret",
    "RUNNER_OFFLINE_THRESHOLD_MS=45000",
    "",
    `DEPLOY_SSH_HOST=${defaults.publicDomain}`,
    "DEPLOY_SSH_USER=root",
    `DEPLOY_DIR=${defaults.serverInstallDir}`,
    `DEPLOY_ENV_FILE=${defaults.serverInstallDir}/.env`,
    `DEPLOY_CADDYFILE=${defaults.caddyfilePath}`
  ].join("\n") + "\n";
}

function renderServerDevEnv() {
  return [
    `HOST=0.0.0.0`,
    `PORT=${defaults.serverListenPort}`,
    `PUBLIC_BASE_URL=${defaults.localBaseURL}`,
    "CORS_ORIGINS=*",
    "# Optional local overrides. Leave blank to use defaults under ~/RemoteAgentWorkbenchServerData.",
    "DATA_ROOT=",
    "DATABASE_PATH=",
    "TASK_RETENTION_DAYS=30",
    "USER_BEARER_TOKEN=",
    "RUNNER_SHARED_SECRET=change-me",
    "RUNNER_OFFLINE_THRESHOLD_MS=45000",
    "",
    "# Optional deployment metadata for your own server.",
    "DEPLOY_SSH_HOST=",
    "DEPLOY_SSH_USER=",
    "DEPLOY_DIR=",
    "DEPLOY_ENV_FILE=",
    "DEPLOY_CADDYFILE="
  ].join("\n") + "\n";
}

function renderRunnerEnv() {
  const runnerDataRoot = defaults.runnerDataRoot;
  return [
    `SERVER_BASE_URL=${defaults.publicBaseURL}`,
    "RUNNER_SHARED_SECRET=replace-with-the-same-secret-as-the-server",
    `RUNNER_ID=${defaults.runnerId}`,
    `RUNNER_NAME=${defaults.runnerName}`,
    "RUNNER_PLATFORM=macOS",
    "RUNNER_LABELS=mac,primary,codex",
    "RUNNER_CAPABILITIES=codex_app_server,codex_cli,git_guard,xcodebuild",
    "RUNNER_VERSION=0.1.0",
    "RUNNER_HEARTBEAT_INTERVAL_MS=15000",
    "RUNNER_POLL_INTERVAL_MS=4000",
    "RUNNER_GIT_PUSH_TIMEOUT_MS=120000",
    "",
    `RUNNER_DATA_ROOT=${runnerDataRoot}`,
    `RUNNER_REPO_CACHE_DIR=${runnerDataRoot}/repos`,
    `RUNNER_WORKSPACE_DIR=${runnerDataRoot}/worktrees`,
    `RUNNER_TASKS_DIR=${runnerDataRoot}/tasks`,
    "RUNNER_LOCAL_TASK_RETENTION_DAYS=30",
    `RUNNER_PROJECTS_FILE=${runnerDataRoot}/projects.json`,
    `RUNNER_DIRECTORIES_FILE=${runnerDataRoot}/directories.json`,
    `RUNNER_LOCK_ROOT_DIR=${runnerDataRoot}/locks`,
    `RUNNER_REQUEST_JOURNAL_PATH=${runnerDataRoot}/logs/runner-requests.jsonl`,
    "",
    "# Optional: leave RUNNER_CODEX_HOME empty to reuse ~/.codex for the current user.",
    "RUNNER_CODEX_HOME=",
    `RUNNER_CODEX_PROFILES_ROOT=${defaults.codexProfilesRoot}`,
    `RUNNER_CODEX_PROFILE_TEMPLATE=${defaults.codexProfileTemplate}`,
    "RUNNER_CODEX_RESTART_TIMEOUT_MS=5000",
    "RUNNER_CODEX_RESTART_POLL_INTERVAL_MS=100",
    "",
    `GITLAB_BASE_URL=${defaults.gitlabBaseURL}`,
    "GITLAB_TOKEN=",
    "",
    `RUNNER_REPORTS_REPO_URL=${defaults.reportsRepoURL}`,
    "RUNNER_REPORTS_BRANCH=main",
    `RUNNER_REPORTS_REPO_DIR=${runnerDataRoot}/report-publisher`,
    `RUNNER_REPORTS_PUBLIC_BASE_URL=${defaults.reportsPublicBaseURL}`,
    "RUNNER_REPORTS_ROOT_DIR=plans",
    "",
    "# Create or edit this file to match your machine before installing the LaunchAgent:",
    `# ${defaults.runnerDataRoot}/runner-host.env`
  ].join("\n") + "\n";
}

function renderRunnerDevEnv() {
  return [
    `SERVER_BASE_URL=${defaults.localBaseURL}`,
    "RUNNER_SHARED_SECRET=change-me",
    `RUNNER_ID=${defaults.runnerId}`,
    `RUNNER_NAME=${defaults.runnerName}`,
    "RUNNER_PLATFORM=macOS",
    "RUNNER_LABELS=local,mac,codex",
    "RUNNER_CAPABILITIES=codex_app_server,codex_cli,git_guard,xcodebuild",
    "RUNNER_VERSION=0.1.0",
    "RUNNER_HEARTBEAT_INTERVAL_MS=15000",
    "RUNNER_POLL_INTERVAL_MS=4000",
    "RUNNER_GIT_PUSH_TIMEOUT_MS=120000",
    "",
    "# Optional local overrides. Leave blank to use defaults under ~/RemoteAgentWorkbenchData.",
    "RUNNER_DATA_ROOT=",
    "RUNNER_REPO_CACHE_DIR=",
    "RUNNER_WORKSPACE_DIR=",
    "RUNNER_TASKS_DIR=",
    "RUNNER_PROJECTS_FILE=",
    "RUNNER_DIRECTORIES_FILE=",
    "RUNNER_LOCK_ROOT_DIR=",
    "RUNNER_REQUEST_JOURNAL_PATH=",
    "RUNNER_LOCAL_TASK_RETENTION_DAYS=30",
    "",
    "# Codex configuration.",
    "RUNNER_CODEX_HOME=",
    "RUNNER_CODEX_PROFILES_ROOT=",
    "RUNNER_CODEX_PROFILE_TEMPLATE=1000",
    "RUNNER_CODEX_RESTART_TIMEOUT_MS=5000",
    "RUNNER_CODEX_RESTART_POLL_INTERVAL_MS=100",
    "",
    "# GitLab review support.",
    `GITLAB_BASE_URL=${defaults.gitlabBaseURL}`,
    "GITLAB_TOKEN=",
    "",
    "# Optional report publishing.",
    "RUNNER_REPORTS_REPO_URL=",
    "RUNNER_REPORTS_BRANCH=main",
    "RUNNER_REPORTS_REPO_DIR=",
    "RUNNER_REPORTS_PUBLIC_BASE_URL=",
    "RUNNER_REPORTS_ROOT_DIR=plans"
  ].join("\n") + "\n";
}

function renderRunnerHostEnv() {
  return [
    `WORKBENCH_ROOT=${defaults.runnerWorkbenchRoot}`,
    `WORKBENCH_DATA_ROOT=${defaults.runnerDataRoot}`,
    `WORKBENCH_LOG_ROOT=${defaults.runnerLogRoot}`,
    `RUNNER_ENV_FILE=${defaults.runnerWorkbenchRoot}/runner/.env.production`,
    `RUNNER_NODE_BIN=${defaults.runnerNodeBinary}`,
    "RUNNER_SHELL=/bin/zsh",
    `RUNNER_LAUNCH_AGENT_LABEL=${defaults.runnerLaunchAgentLabel}`
  ].join("\n") + "\n";
}

function renderRunnerScript() {
  return `#!/bin/zsh
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

HOST_CONFIG_FILE="\${RUNNER_HOST_CONFIG_FILE:-$HOME/RemoteAgentWorkbenchData/runner-host.env}"
if [[ -f "\${HOST_CONFIG_FILE}" ]]; then
  set -a
  source "\${HOST_CONFIG_FILE}"
  set +a
fi

WORKBENCH_ROOT="\${WORKBENCH_ROOT:-$HOME/Code/RemoteAgentWorkbench}"
RUNNER_ROOT="\${WORKBENCH_ROOT}/runner"
ENV_FILE="\${RUNNER_ENV_FILE:-\${RUNNER_ROOT}/.env.production}"
NODE_BIN="\${RUNNER_NODE_BIN:-node}"

if [[ -f "\${ENV_FILE}" ]]; then
  set -a
  source "\${ENV_FILE}"
  set +a
fi

cd "\${RUNNER_ROOT}"
exec "\${NODE_BIN}" dist/index.js
`;
}

function renderLaunchAgentPlist() {
  const shellCommand = [
    'HOST_CONFIG_FILE="${RUNNER_HOST_CONFIG_FILE:-$HOME/RemoteAgentWorkbenchData/runner-host.env}"',
    'if [[ -f "${HOST_CONFIG_FILE}" ]]; then set -a; source "${HOST_CONFIG_FILE}"; set +a; fi',
    'WORKBENCH_ROOT="${WORKBENCH_ROOT:-$HOME/Code/RemoteAgentWorkbench}"',
    'WORKBENCH_LOG_ROOT="${WORKBENCH_LOG_ROOT:-$HOME/Library/Logs/RemoteAgentWorkbench}"',
    'mkdir -p "${WORKBENCH_LOG_ROOT}"',
    'exec "${WORKBENCH_ROOT}/deploy/runner/run-runner.sh" >> "${WORKBENCH_LOG_ROOT}/runner.stdout.log" 2>> "${WORKBENCH_LOG_ROOT}/runner.stderr.log"'
  ].join("; ");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${defaults.runnerLaunchAgentLabel}</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/zsh</string>
        <string>-lc</string>
        <string>${shellCommand}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
</dict>
</plist>
`;
}

function renderCaddyfile() {
  return `${defaults.publicDomain} {
    encode gzip zstd
    reverse_proxy ${defaults.serverListenHost}:${defaults.serverListenPort}
}
`;
}

function renderSystemdService() {
  return `[Unit]
Description=RemoteAgentWorkbench Server
After=network.target

[Service]
Type=simple
WorkingDirectory=${defaults.serverInstallDir}
EnvironmentFile=${defaults.serverInstallDir}/.env
ExecStart=/usr/bin/env node ${defaults.serverInstallDir}/dist/index.js
Restart=always
RestartSec=3
User=${defaults.serverServiceUser}

[Install]
WantedBy=multi-user.target
`;
}

function renderProjectsExample() {
  return `${JSON.stringify([
    {
      id: "sample_project",
      name: "Sample Project",
      repo: "~/Code/sample-project",
      baseBranch: "main",
      deliveryMode: "review_required",
      autoPush: true,
      defaultTaskTitle: "Continue sample project task",
      defaultPrompt: "Implement the requested change, run the most relevant checks, and follow the selected Git workflow.",
      isFeatured: true,
      reportNamespace: "samples/sample-project"
    }
  ], null, 2)}\n`;
}

function renderDirectoriesExample() {
  return `${JSON.stringify([
    {
      id: "code",
      label: "Code",
      rootPath: "~/Code"
    }
  ], null, 2)}\n`;
}

async function writeFile(relativePath, content, mode) {
  const filePath = normalizeRepoRoot(relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
  if (mode) {
    await fs.chmod(filePath, mode);
  }
}

await writeFile("server/.env.example", renderServerDevEnv());
await writeFile("runner/.env.example", renderRunnerDevEnv());
await writeFile("deploy/server/env.production.example", renderServerEnv());
await writeFile("deploy/runner/env.production.example", renderRunnerEnv());
await writeFile("deploy/runner/runner-host.env.example", renderRunnerHostEnv());
await writeFile("deploy/runner/run-runner.sh", renderRunnerScript(), 0o755);
await writeFile("deploy/runner/run-runner.sh.example", renderRunnerScript(), 0o755);
await writeFile("deploy/runner/com.remote-agent-workbench.runner.plist.example", renderLaunchAgentPlist());
await writeFile("deploy/caddy/remote-agent-workbench.Caddyfile.example", renderCaddyfile());
await writeFile("deploy/server/remote-agent-workbench.service", renderSystemdService());
await writeFile("deploy/examples/projects.example.json", renderProjectsExample());
await writeFile("deploy/examples/directories.example.json", renderDirectoriesExample());
