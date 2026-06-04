#!/bin/zsh
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

HOST_CONFIG_FILE="${RUNNER_HOST_CONFIG_FILE:-$HOME/RemoteAgentWorkbenchData/runner-host.env}"
if [[ -f "${HOST_CONFIG_FILE}" ]]; then
  set -a
  source "${HOST_CONFIG_FILE}"
  set +a
fi

WORKBENCH_ROOT="${WORKBENCH_ROOT:-$HOME/Code/RemoteAgentWorkbench}"
RUNNER_ROOT="${WORKBENCH_ROOT}/runner"
ENV_FILE="${RUNNER_ENV_FILE:-${RUNNER_ROOT}/.env.production}"
NODE_BIN="${RUNNER_NODE_BIN:-node}"

if [[ -f "${ENV_FILE}" ]]; then
  set -a
  source "${ENV_FILE}"
  set +a
fi

cd "${RUNNER_ROOT}"
exec "${NODE_BIN}" dist/index.js
