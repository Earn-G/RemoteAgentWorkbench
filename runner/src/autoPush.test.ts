import assert from "node:assert/strict";
import test from "node:test";
import { attemptAutoPush, buildLatestResultSummary, shouldAutoPush } from "./autoPush.js";
import type { BranchPushState } from "./repositoryManager.js";

function createPushState(overrides: Partial<BranchPushState> = {}): BranchPushState {
  return {
    branchName: "feature/item_ui",
    trackingBranch: "origin/feature/item_ui",
    remoteBranchExists: true,
    localAheadCount: 1,
    remoteAheadCount: 0,
    ...overrides
  };
}

test("shouldAutoPush only enables direct-commit tasks with auto-push turned on", () => {
  assert.equal(shouldAutoPush({ deliveryMode: "direct_commit", autoPush: true }), true);
  assert.equal(shouldAutoPush({ deliveryMode: "direct_commit", autoPush: false }), false);
  assert.equal(shouldAutoPush({ deliveryMode: "review_required", autoPush: true }), false);
});

test("attemptAutoPush skips when the remote branch does not exist", async () => {
  const decision = await attemptAutoPush(
    { deliveryMode: "direct_commit", autoPush: true },
    "/tmp/demo",
    {
      async inspectCurrentBranchPushState() {
        return createPushState({
          remoteBranchExists: false
        });
      },
      async pushCurrentBranch() {
        throw new Error("push should not run");
      }
    }
  );

  assert.deepEqual(decision, {
    outcome: "skipped",
    branchName: "feature/item_ui",
    detail: "Auto-push skipped because origin/feature/item_ui does not exist yet."
  });
});

test("attemptAutoPush skips when origin is already ahead", async () => {
  const decision = await attemptAutoPush(
    { deliveryMode: "direct_commit", autoPush: true },
    "/tmp/demo",
    {
      async inspectCurrentBranchPushState() {
        return createPushState({
          remoteAheadCount: 2
        });
      },
      async pushCurrentBranch() {
        throw new Error("push should not run");
      }
    }
  );

  assert.deepEqual(decision, {
    outcome: "skipped",
    branchName: "feature/item_ui",
    detail: "Auto-push skipped because origin/feature/item_ui is ahead of the local branch."
  });
});

test("attemptAutoPush skips when there are no new local commits", async () => {
  const decision = await attemptAutoPush(
    { deliveryMode: "direct_commit", autoPush: true },
    "/tmp/demo",
    {
      async inspectCurrentBranchPushState() {
        return createPushState({
          localAheadCount: 0
        });
      },
      async pushCurrentBranch() {
        throw new Error("push should not run");
      }
    }
  );

  assert.deepEqual(decision, {
    outcome: "skipped",
    branchName: "feature/item_ui",
    detail: "Auto-push skipped because feature/item_ui has no new local commits ahead of origin/feature/item_ui."
  });
});

test("attemptAutoPush pushes when the branch already exists on origin and local is ahead", async () => {
  const decision = await attemptAutoPush(
    { deliveryMode: "direct_commit", autoPush: true },
    "/tmp/demo",
    {
      async inspectCurrentBranchPushState() {
        return createPushState();
      },
      async pushCurrentBranch() {
        return "feature/item_ui";
      }
    }
  );

  assert.deepEqual(decision, {
    outcome: "pushed",
    branchName: "feature/item_ui",
    detail: "Auto-pushed feature/item_ui to origin after the implementation turn."
  });
});

test("buildLatestResultSummary appends auto-push details when relevant", () => {
  assert.equal(
    buildLatestResultSummary("Implemented the requested change.", {
      outcome: "pushed",
      branchName: "feature/item_ui",
      detail: "Auto-pushed feature/item_ui to origin after the implementation turn."
    }),
    "Implemented the requested change.\n\nAuto-pushed feature/item_ui to origin after the implementation turn."
  );
  assert.equal(
    buildLatestResultSummary("Implemented the requested change.", {
      outcome: "disabled"
    }),
    undefined
  );
});
