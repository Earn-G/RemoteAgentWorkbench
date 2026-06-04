import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "lock";
}

function buildLockDirectory(rootDir: string, key: string): string {
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 16);
  return path.join(rootDir, `${slugify(key)}-${hash}.lock`);
}

interface LockOwnerMetadata {
  key?: string;
  owner?: string;
  pid?: number;
  acquiredAt?: string;
}

function normalizePid(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return undefined;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const typed = error as NodeJS.ErrnoException;
    if (typed.code === "EPERM") {
      return true;
    }
    if (typed.code === "ESRCH") {
      return false;
    }
    return false;
  }
}

export class FileLockManager {
  constructor(private readonly rootDir: string) {}

  async cleanupStaleLocks(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.rootDir, { withFileTypes: true });
      const removed: string[] = [];

      for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.endsWith(".lock")) {
          continue;
        }

        const lockDir = path.join(this.rootDir, entry.name);
        if (await this.tryRecoverStaleLock(lockDir)) {
          removed.push(entry.name);
        }
      }

      return removed;
    } catch (error) {
      const typed = error as NodeJS.ErrnoException;
      if (typed.code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  async withLock<T>(
    key: string,
    owner: string,
    work: () => Promise<T>,
    options?: {
      timeoutMs?: number;
      pollIntervalMs?: number;
    }
  ): Promise<T> {
    const timeoutMs = options?.timeoutMs ?? 120_000;
    const pollIntervalMs = options?.pollIntervalMs ?? 500;
    const startedAt = Date.now();
    const lockDir = buildLockDirectory(this.rootDir, key);

    await fs.mkdir(this.rootDir, { recursive: true });

    while (true) {
      try {
        await fs.mkdir(lockDir);
        await fs.writeFile(
          path.join(lockDir, "owner.json"),
          `${JSON.stringify(
            {
              key,
              owner,
              pid: process.pid,
              acquiredAt: new Date().toISOString()
            },
            null,
            2
          )}\n`,
          "utf8"
        );
        break;
      } catch (error) {
        const typed = error as NodeJS.ErrnoException;
        if (typed.code !== "EEXIST") {
          throw error;
        }

        if (await this.tryRecoverStaleLock(lockDir)) {
          continue;
        }

        if (Number.isFinite(timeoutMs) && Date.now() - startedAt >= timeoutMs) {
          if (await this.tryRecoverStaleLock(lockDir)) {
            continue;
          }

          const holder = await this.readLockOwnerRaw(lockDir);

          const holderSuffix = holder.trim() ? ` Holder: ${holder.trim()}` : "";
          throw new Error(`Timed out waiting for lock ${key}.${holderSuffix}`);
        }

        await delay(pollIntervalMs);
      }
    }

    try {
      return await work();
    } finally {
      await fs.rm(lockDir, { recursive: true, force: true });
    }
  }

  private async readLockOwnerRaw(lockDir: string): Promise<string> {
    try {
      return await fs.readFile(path.join(lockDir, "owner.json"), "utf8");
    } catch {
      return "";
    }
  }

  private async readLockOwnerMetadata(lockDir: string): Promise<LockOwnerMetadata | undefined> {
    const raw = await this.readLockOwnerRaw(lockDir);
    if (!raw.trim()) {
      return undefined;
    }

    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const pid = normalizePid(parsed.pid);
      return {
        key: typeof parsed.key === "string" ? parsed.key : undefined,
        owner: typeof parsed.owner === "string" ? parsed.owner : undefined,
        pid,
        acquiredAt: typeof parsed.acquiredAt === "string" ? parsed.acquiredAt : undefined
      };
    } catch {
      return undefined;
    }
  }

  private async tryRecoverStaleLock(lockDir: string): Promise<boolean> {
    const metadata = await this.readLockOwnerMetadata(lockDir);
    if (!metadata?.pid || isProcessAlive(metadata.pid)) {
      return false;
    }

    await fs.rm(lockDir, { recursive: true, force: true });
    return true;
  }
}
