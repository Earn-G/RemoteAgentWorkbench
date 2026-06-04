import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProtectedGitCommand, ProtectedGitCommandKind } from "./models.js";

const BLOCKED_GIT_EXIT_CODE = "87";

function normalizeProtectedGitCommandKind(value: string): ProtectedGitCommandKind | undefined {
  return value === "reset_hard" || value === "clean_fd" ? value : undefined;
}

export function classifyProtectedGitCommand(args: string[]): ProtectedGitCommand | undefined {
  if (args.length < 2) {
    return undefined;
  }

  if (args[0] === "reset" && args.slice(1).some((arg) => arg === "--hard")) {
    return {
      kind: "reset_hard",
      args
    };
  }

  if (args[0] === "clean") {
    const optionArgs = args.slice(1).filter((arg) => arg.startsWith("-"));
    const hasForce = optionArgs.some((arg) => arg === "-f" || arg.includes("f") || arg === "--force");
    const hasDirectory = optionArgs.some((arg) => arg === "-d" || arg.includes("d"));
    if (hasForce && hasDirectory) {
      return {
        kind: "clean_fd",
        args
      };
    }
  }

  return undefined;
}

export async function createGitGuardEnvironment(options?: {
  allowedKinds?: ProtectedGitCommandKind[];
}): Promise<{
  extraEnv: Record<string, string>;
  requestPath: string;
  cleanup: () => Promise<void>;
}> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "remote-agent-git-guard-"));
  const wrapperPath = path.join(tempDir, "git");
  const requestPath = path.join(tempDir, "blocked-command.bin");
  const script = `#!/bin/sh
REAL_GIT="\${REMOTE_AGENT_REAL_GIT_PATH:-/usr/bin/git}"
REQUEST_PATH="\${REMOTE_AGENT_GIT_GUARD_REQUEST_PATH:-}"
KIND=""

if [ "$#" -ge 2 ] && [ "$1" = "reset" ]; then
  for ARG in "$@"; do
    if [ "$ARG" = "--hard" ]; then
      KIND="reset_hard"
      break
    fi
  done
fi

if [ -z "$KIND" ] && [ "$#" -ge 2 ] && [ "$1" = "clean" ]; then
  HAS_FORCE=0
  HAS_DIRECTORY=0
  for ARG in "$@"; do
    case "$ARG" in
      --force)
        HAS_FORCE=1
        ;;
      -*)
        case "$ARG" in
          *f*)
            HAS_FORCE=1
            ;;
        esac
        case "$ARG" in
          *d*)
            HAS_DIRECTORY=1
            ;;
        esac
        ;;
    esac
  done

  if [ "$HAS_FORCE" = "1" ] && [ "$HAS_DIRECTORY" = "1" ]; then
    KIND="clean_fd"
  fi
fi

if [ -n "$KIND" ]; then
  case "$KIND" in
    reset_hard)
      if [ "\${REMOTE_AGENT_ALLOW_GIT_RESET_HARD:-0}" = "1" ]; then
        exec "$REAL_GIT" "$@"
      fi
      ;;
    clean_fd)
      if [ "\${REMOTE_AGENT_ALLOW_GIT_CLEAN_FD:-0}" = "1" ]; then
        exec "$REAL_GIT" "$@"
      fi
      ;;
  esac

  if [ -n "$REQUEST_PATH" ]; then
    {
      printf '%s\\n' "$KIND"
      printf '%s\\0' "$@"
    } > "$REQUEST_PATH"
  fi
  echo "REMOTE_AGENT_GIT_GUARD_BLOCKED:$KIND" >&2
  exit ${BLOCKED_GIT_EXIT_CODE}
fi

exec "$REAL_GIT" "$@"
`;

  await fs.writeFile(wrapperPath, script, { mode: 0o755 });
  await fs.chmod(wrapperPath, 0o755);

  return {
    extraEnv: {
      PATH: `${tempDir}:${process.env.PATH ?? ""}`,
      REMOTE_AGENT_REAL_GIT_PATH: "/usr/bin/git",
      REMOTE_AGENT_GIT_GUARD_REQUEST_PATH: requestPath,
      REMOTE_AGENT_ALLOW_GIT_RESET_HARD: options?.allowedKinds?.includes("reset_hard") ? "1" : "0",
      REMOTE_AGENT_ALLOW_GIT_CLEAN_FD: options?.allowedKinds?.includes("clean_fd") ? "1" : "0"
    },
    requestPath,
    cleanup: async () => {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  };
}

export async function readBlockedProtectedGitCommand(requestPath: string): Promise<ProtectedGitCommand | undefined> {
  let contents: Buffer;
  try {
    contents = await fs.readFile(requestPath);
  } catch (error) {
    const typed = error as NodeJS.ErrnoException;
    if (typed.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  const newlineIndex = contents.indexOf(0x0a);
  if (newlineIndex === -1) {
    return undefined;
  }

  const kind = normalizeProtectedGitCommandKind(contents.subarray(0, newlineIndex).toString("utf8").trim());
  if (!kind) {
    return undefined;
  }

  const args = contents
    .subarray(newlineIndex + 1)
    .toString("utf8")
    .split("\0")
    .map((item) => item.trim())
    .filter(Boolean);

  if (args.length < 2) {
    return undefined;
  }

  return {
    kind,
    args
  };
}
