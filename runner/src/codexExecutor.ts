import { spawn } from "node:child_process";
import readline from "node:readline";

export interface CodexRunInput {
  cwd: string;
  prompt: string;
  threadId?: string;
  mode: "plan" | "implement";
  skipGitRepoCheck?: boolean;
  materializedFromHistory: boolean;
  codexHome?: string;
  extraEnv?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  onEvent?: (event: CodexRunEvent) => Promise<void> | void;
}

export interface CodexRunResult {
  threadId: string;
  finalMessage: string;
  stdoutLines: string[];
}

export interface CodexRunEvent {
  type: string;
  threadId?: string;
  message?: string;
}

export class CodexRunCanceledError extends Error {
  constructor(message = "Codex run canceled") {
    super(message);
    this.name = "CodexRunCanceledError";
  }
}

export class CodexRunFailedError extends Error {
  readonly threadId?: string;
  readonly stdoutLines: string[];

  constructor(message: string, options?: { threadId?: string; stdoutLines?: string[] }) {
    super(message);
    this.name = "CodexRunFailedError";
    this.threadId = options?.threadId;
    this.stdoutLines = options?.stdoutLines ?? [];
  }
}

export function buildArgs(input: CodexRunInput): string[] {
  if (input.threadId) {
    const args = ["exec", "resume", "--json"];
    if (input.skipGitRepoCheck) {
      args.push("--skip-git-repo-check");
    }
    if (input.mode === "implement") {
      args.push("--full-auto");
    }
    args.push(input.threadId, input.prompt);
    return args;
  }

  const args = ["exec", "--json"];
  if (input.skipGitRepoCheck) {
    args.push("--skip-git-repo-check");
  }
  if (input.mode === "plan") {
    args.push("-s", "read-only");
  } else {
    args.push("--full-auto");
  }
  args.push(input.prompt);
  return args;
}

export async function runCodex(input: CodexRunInput): Promise<CodexRunResult> {
  const args = buildArgs(input);
  const env = {
    ...process.env,
    ...(input.codexHome?.trim() ? { CODEX_HOME: input.codexHome } : {}),
    ...(input.extraEnv ?? {})
  };

  return new Promise<CodexRunResult>((resolve, reject) => {
    if (input.signal?.aborted) {
      reject(new CodexRunCanceledError());
      return;
    }

    const child = spawn("codex", args, {
      cwd: input.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    const stdout = readline.createInterface({
      input: child.stdout
    });
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];

    let threadId = input.threadId;
    let finalMessage = "";
    let latestError = "";
    let callbackChain = Promise.resolve();
    let canceled = false;
    let timedOut = false;

    const abortHandler = () => {
      canceled = true;
      child.kill("SIGTERM");
    };

    input.signal?.addEventListener("abort", abortHandler, { once: true });
    const timeout = input.timeoutMs && Number.isFinite(input.timeoutMs)
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
        }, input.timeoutMs)
      : undefined;

    function emit(event: CodexRunEvent): void {
      if (!input.onEvent) {
        return;
      }

      callbackChain = callbackChain
        .then(async () => {
          await input.onEvent?.(event);
        })
        .catch((error) => {
          console.error("[runner] codex stream hook failed", error);
        });
    }

    stdout.on("line", (line) => {
      stdoutLines.push(line);
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) {
        return;
      }

      try {
        const event = JSON.parse(trimmed) as {
          type?: string;
          thread_id?: string;
          item?: { type?: string; text?: string };
          message?: string;
          error?: { message?: string };
        };

        if (event.type === "thread.started" && event.thread_id) {
          threadId = event.thread_id;
          emit({
            type: event.type,
            threadId
          });
        }

        if (event.type === "item.completed" && event.item?.type === "agent_message" && event.item.text) {
          finalMessage = event.item.text.trim();
          emit({
            type: event.type,
            threadId,
            message: finalMessage
          });
        }

        if (event.type === "error" && typeof event.message === "string") {
          latestError = event.message.trim();
        }

        if (event.type === "turn.failed" && event.error?.message) {
          latestError = event.error.message.trim();
        }
      } catch {
        // Ignore non-JSON log lines.
      }
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stderrLines.push(text);
    });

    child.on("error", (error) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      input.signal?.removeEventListener("abort", abortHandler);
      reject(error);
    });

    child.on("close", (code) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      stdout.close();
      input.signal?.removeEventListener("abort", abortHandler);

      void callbackChain.finally(() => {
        if (canceled || input.signal?.aborted) {
          reject(new CodexRunCanceledError());
          return;
        }

        if (timedOut) {
          reject(
            new CodexRunFailedError(
              `Codex run timed out after ${input.timeoutMs}ms`,
              {
                threadId,
                stdoutLines
              }
            )
          );
          return;
        }

        if (code !== 0) {
          const stderr = stderrLines.join("").trim();
          const failureDetail = latestError || stderr;
          reject(
            new CodexRunFailedError(
              `Codex exited with code ${code}${failureDetail ? `: ${failureDetail}` : ""}`,
              {
                threadId,
                stdoutLines
              }
            )
          );
          return;
        }

        if (!threadId) {
          reject(new Error("Codex run finished without a thread id"));
          return;
        }

        resolve({
          threadId,
          finalMessage: finalMessage || "Codex completed the turn without returning a final summary.",
          stdoutLines
        });
      });
    });
  });
}
