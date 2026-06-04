import type { DeliveryMode } from "./models.js";
import type { BranchPushState } from "./repositoryManager.js";

export interface AutoPushTask {
  deliveryMode: DeliveryMode;
  autoPush: boolean;
}

export interface AutoPushRepository {
  inspectCurrentBranchPushState(cwd: string, signal?: AbortSignal): Promise<BranchPushState>;
  pushCurrentBranch(cwd: string, signal?: AbortSignal): Promise<string>;
}

export type AutoPushDecision =
  | {
      outcome: "disabled";
    }
  | {
      outcome: "skipped";
      detail: string;
      branchName?: string;
    }
  | {
      outcome: "pushed";
      detail: string;
      branchName: string;
    };

export function shouldAutoPush(task: AutoPushTask): boolean {
  return task.deliveryMode === "direct_commit" && task.autoPush;
}

export async function attemptAutoPush(
  task: AutoPushTask,
  cwd: string,
  repositories: AutoPushRepository,
  signal?: AbortSignal
): Promise<AutoPushDecision> {
  if (!shouldAutoPush(task)) {
    return {
      outcome: "disabled"
    };
  }

  const pushState = await repositories.inspectCurrentBranchPushState(cwd, signal);
  if (!pushState.branchName) {
    return {
      outcome: "skipped",
      detail: "Auto-push skipped because the repository is not currently on a local branch."
    };
  }

  if (!pushState.remoteBranchExists) {
    return {
      outcome: "skipped",
      branchName: pushState.branchName,
      detail: `Auto-push skipped because origin/${pushState.branchName} does not exist yet.`
    };
  }

  if (pushState.remoteAheadCount > 0) {
    return {
      outcome: "skipped",
      branchName: pushState.branchName,
      detail: `Auto-push skipped because origin/${pushState.branchName} is ahead of the local branch.`
    };
  }

  if (pushState.localAheadCount < 1) {
    return {
      outcome: "skipped",
      branchName: pushState.branchName,
      detail: `Auto-push skipped because ${pushState.branchName} has no new local commits ahead of origin/${pushState.branchName}.`
    };
  }

  const branchName = await repositories.pushCurrentBranch(cwd, signal);
  return {
    outcome: "pushed",
    branchName,
    detail: `Auto-pushed ${branchName} to origin after the implementation turn.`
  };
}

export function buildLatestResultSummary(summary: string, decision: AutoPushDecision): string | undefined {
  if (decision.outcome === "disabled") {
    return undefined;
  }

  return `${summary}\n\n${decision.detail}`;
}
