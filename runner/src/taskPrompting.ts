import type { Artifact, TaskEvent, TaskSnapshot } from "./models.js";

export interface ImplementationTurnPlan {
  threadId?: string;
  prompt: string;
  startsFreshThread: boolean;
}

function normalizedText(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function hasArtifact(task: TaskSnapshot, kind: Artifact["kind"]): boolean {
  return task.artifacts.some((artifact) => artifact.kind === kind);
}

function hasEvent(task: TaskSnapshot, kind: TaskEvent["kind"]): boolean {
  return task.events.some((event) => event.kind === kind);
}

export function getApprovedPlanSummary(task: TaskSnapshot): string | undefined {
  return normalizedText(task.artifacts.find((artifact) => artifact.kind === "plan")?.summary);
}

export function hasCompletedImplementationTurn(task: TaskSnapshot): boolean {
  return hasEvent(task, "codex.turn_complete") || hasArtifact(task, "diff");
}

export function shouldResumeImplementationThread(task: TaskSnapshot): boolean {
  if (task.executionMode === "resume_thread") {
    return Boolean(normalizedText(task.executorSession?.threadId ?? task.resumeThreadId));
  }

  return hasCompletedImplementationTurn(task);
}

export function buildImplementationPrompt(task: TaskSnapshot, userPrompt?: string, options?: { isGitRepository?: boolean }): string {
  const isGitRepository = options?.isGitRepository !== false;
  const originalRequest = normalizedText(task.prompt);
  const currentInstruction = normalizedText(userPrompt);
  const approvedPlan = getApprovedPlanSummary(task);
  const planHeading = task.deliveryMode === "direct_commit" ? "Implementation plan" : "Approved implementation plan";
  const sections = [isGitRepository ? "Work in this repository and implement the requested change." : "Work in this local folder and implement the requested change. Git is not initialized here."];

  if (originalRequest) {
    sections.push(`Original user request:\n${originalRequest}`);
  }

  if (approvedPlan) {
    sections.push(`${planHeading}:\n${approvedPlan}`);
  }

  if (currentInstruction && currentInstruction !== originalRequest) {
    sections.push(`Current instruction:\n${currentInstruction}`);
  }

  sections.push(isGitRepository ? "Before finishing, run the most relevant checks you can from this repository." : "Before finishing, run the most relevant checks you can from this folder.");
  if (!isGitRepository) {
    sections.push("Do not run Git commands. Save the requested file changes directly in this folder and summarize what changed; no commit, push, or PR/MR is expected.");
  } else if (task.deliveryMode === "direct_commit") {
    sections.push(
      "This task uses `direct_commit`: after completing the requested changes and running the relevant checks, finish with a local `git add -A` and `git commit` unless the user explicitly asked not to commit or the work is still blocked. A successful local commit marks the task completed."
    );
    sections.push(
      task.autoPush
        ? "Do not push, rebase, or create a PR/MR yourself unless the user explicitly requests it. If origin already has this branch, the runner may auto-push after the implementation turn."
        : "Do not push, rebase, or create a PR/MR unless the user explicitly requests those actions."
    );
  } else {
    sections.push("Do not commit, rebase, or push unless the user explicitly requests those actions.");
  }
  if (isGitRepository) {
    sections.push("Do not run `git reset --hard` or `git clean -fd` unless the user explicitly approved that action in the client.");
  }
  sections.push("In the final response, summarize the code changes and the validation results.");

  return sections.join("\n\n");
}

export function prepareImplementationTurn(task: TaskSnapshot, userPrompt?: string, options?: { isGitRepository?: boolean }): ImplementationTurnPlan {
  const existingThreadId = normalizedText(task.executorSession?.threadId ?? task.resumeThreadId);
  const resumeExistingThread = shouldResumeImplementationThread(task);

  return {
    threadId: resumeExistingThread ? existingThreadId : undefined,
    prompt: buildImplementationPrompt(task, userPrompt, options),
    startsFreshThread: !resumeExistingThread
  };
}
