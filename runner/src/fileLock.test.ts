import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { FileLockManager } from "./fileLock.js";

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

async function writeLock(rootDir: string, key: string, owner: { owner: string; pid: number; acquiredAt?: string }): Promise<string> {
  const lockDir = buildLockDirectory(rootDir, key);
  await fs.mkdir(lockDir, { recursive: true });
  await fs.writeFile(
    path.join(lockDir, "owner.json"),
    `${JSON.stringify(
      {
        key,
        owner: owner.owner,
        pid: owner.pid,
        acquiredAt: owner.acquiredAt ?? new Date().toISOString()
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  return lockDir;
}

test("withLock removes a stale lock whose owner pid is no longer alive", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "raw-file-lock-stale-"));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const key = "repo:/tmp/demo-repo";
  const lockDir = await writeLock(tempRoot, key, {
    owner: "task_old:continue_prompt",
    pid: 2_147_483_647,
    acquiredAt: "2026-04-05T00:00:00.000Z"
  });

  const manager = new FileLockManager(tempRoot);
  let executed = false;

  await manager.withLock(key, "task_new:generate_plan", async () => {
    executed = true;
  });

  assert.equal(executed, true);
  await assert.rejects(fs.access(lockDir));
});

test("cleanupStaleLocks removes stale lock directories and preserves live ones", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "raw-file-lock-cleanup-"));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const staleKey = "repo:/tmp/stale-repo";
  const liveKey = "repo:/tmp/live-repo";
  const staleLockDir = await writeLock(tempRoot, staleKey, {
    owner: "task_old:continue_prompt",
    pid: 2_147_483_647
  });
  const liveLockDir = await writeLock(tempRoot, liveKey, {
    owner: "task_live:continue_prompt",
    pid: process.pid
  });

  const manager = new FileLockManager(tempRoot);
  const removed = await manager.cleanupStaleLocks();

  assert.equal(removed.length, 1);
  assert.equal(removed[0], path.basename(staleLockDir));
  await assert.rejects(fs.access(staleLockDir));
  await fs.access(liveLockDir);
});

test("withLock still times out while a live lock owner is active", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "raw-file-lock-live-"));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const key = "repo:/tmp/live-repo";
  await writeLock(tempRoot, key, {
    owner: "task_live:continue_prompt",
    pid: process.pid
  });

  const manager = new FileLockManager(tempRoot);

  await assert.rejects(
    manager.withLock(
      key,
      "task_next:generate_plan",
      async () => {
        throw new Error("should not run");
      },
      { timeoutMs: 50, pollIntervalMs: 10 }
    ),
    /Timed out waiting for lock/
  );
});

test("withLock waits for a live owner to release before entering", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "raw-file-lock-serial-"));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const key = "runner-instance:runner-local-mac";
  const manager = new FileLockManager(tempRoot);
  let releaseFirstLock: (() => void) | undefined;
  const firstLockStarted = new Promise<void>((resolve) => {
    releaseFirstLock = resolve;
  });
  let firstLockEntered = false;
  let secondLockEntered = false;

  const first = manager.withLock(key, "runner:runner-local-mac:pid:100", async () => {
    firstLockEntered = true;
    await firstLockStarted;
  });

  while (!firstLockEntered) {
    await delay(10);
  }

  const second = manager.withLock(
    key,
    "runner:runner-local-mac:pid:200",
    async () => {
      secondLockEntered = true;
    },
    { timeoutMs: 1_000, pollIntervalMs: 10 }
  );

  await delay(50);
  assert.equal(secondLockEntered, false);

  releaseFirstLock?.();
  await first;
  await second;
  assert.equal(secondLockEntered, true);
});
