#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKBENCH_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
SERVER_DIR="${WORKBENCH_ROOT}/server"
OUTPUT_TGZ="${SERVER_DIR}/remote-agent-workbench-server-min.tgz"

cd "${SERVER_DIR}"

npm run build
rm -f "${OUTPUT_TGZ}"
COPYFILE_DISABLE=1 tar --exclude='._*' -czf "${OUTPUT_TGZ}" dist package.json package-lock.json .env.example

echo "Created ${OUTPUT_TGZ}"
