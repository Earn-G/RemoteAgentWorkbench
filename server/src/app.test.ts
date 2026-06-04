import test from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "./app.js";
import { TaskService } from "./services/taskService.js";

function createApp(options?: { userBearerToken?: string }) {
  return buildApp({
    taskService: new TaskService({
      storagePath: ":memory:"
    }),
    userBearerToken: options?.userBearerToken
  });
}

function runnerHeaders(instanceId = "runner-instance-test") {
  return {
    "x-runner-instance-id": instanceId
  };
}

function withCommandIdentity<T extends object>(
  assignment: { id: string; claimToken: string },
  payload: T
): T & { commandId: string; claimToken: string } {
  return {
    ...payload,
    commandId: assignment.id,
    claimToken: assignment.claimToken
  };
}

test("system summary exposes the configured provider metadata without the API key", async (t) => {
  const app = await createApp();
  t.after(async () => {
    await app.close();
  });

  const response = await app.inject({
    method: "GET",
    url: "/v1/system/summary"
  });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.publicBaseURL, "http://127.0.0.1:8787");
  assert.equal(body.userAuthConfigured, false);
  assert.equal(body.runnerAuthConfigured, false);
  assert.equal(body.deployment.deployDir, "");
  assert.deepEqual(body.codexConfig.protectedProfileNames, ["1000", "plus"]);
});

test("user-facing routes require a bearer token when user auth is configured", async (t) => {
  const app = await createApp({
    userBearerToken: "user-secret"
  });
  t.after(async () => {
    await app.close();
  });

  const unauthorized = await app.inject({
    method: "GET",
    url: "/v1/system/summary"
  });
  assert.equal(unauthorized.statusCode, 401);

  const authorized = await app.inject({
    method: "GET",
    url: "/v1/system/summary",
    headers: {
      authorization: "Bearer user-secret"
    }
  });
  assert.equal(authorized.statusCode, 200);

  const runnerHello = await app.inject({
    method: "POST",
    url: "/v1/runner/hello",
    headers: runnerHeaders(),
    payload: {
      id: "runner-auth-test",
      name: "Auth Test Runner",
      platform: "macOS",
      labels: ["local"],
      capabilities: ["codex_cli"],
      version: "0.1.0",
      hostname: "test-host"
    }
  });
  assert.equal(runnerHello.statusCode, 200);
});

test("runner hello registers a runner and exposes it through the list endpoint", async (t) => {
  const app = await createApp();
  t.after(async () => {
    await app.close();
  });

  const hello = await app.inject({
    method: "POST",
    url: "/v1/runner/hello",
    headers: runnerHeaders(),
    payload: {
      id: "runner-test",
      name: "Test Runner",
      platform: "macOS",
      labels: ["local"],
      capabilities: ["codex_cli"],
      version: "0.1.0",
      hostname: "test-host"
    }
  });

  assert.equal(hello.statusCode, 200);

  const list = await app.inject({
    method: "GET",
    url: "/v1/runners"
  });

  assert.equal(list.statusCode, 200);
  const runners = list.json();
  assert.equal(runners.length, 1);
  assert.equal(runners[0].id, "runner-test");
  assert.equal(runners[0].hostname, "test-host");
});

test("system summary exposes the runner Codex config state", async (t) => {
  const app = await createApp();
  t.after(async () => {
    await app.close();
  });

  const hello = await app.inject({
    method: "POST",
    url: "/v1/runner/hello",
    headers: runnerHeaders(),
    payload: {
      id: "runner-config-test",
      name: "Config Runner",
      platform: "macOS",
      labels: ["local"],
      capabilities: ["codex_cli"],
      version: "0.1.0",
      hostname: "config-host",
      codexConfigProfiles: ["1000", "plus"],
      activeCodexConfigProfile: "plus"
    }
  });
  assert.equal(hello.statusCode, 200);

  const response = await app.inject({
    method: "GET",
    url: "/v1/system/summary"
  });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.deepEqual(body.codexConfig.profiles, ["1000", "plus"]);
  assert.equal(body.codexConfig.activeProfileName, "plus");
});

test("system routes queue Codex config switch utilities", async (t) => {
  const app = await createApp();
  t.after(async () => {
    await app.close();
  });

  await app.inject({
    method: "POST",
    url: "/v1/runner/hello",
    headers: runnerHeaders(),
    payload: {
      id: "runner-switch-test",
      name: "Switch Runner",
      platform: "macOS",
      labels: ["local"],
      capabilities: ["codex_cli"],
      version: "0.1.0",
      hostname: "switch-host",
      codexConfigProfiles: ["1000", "plus"],
      activeCodexConfigProfile: "plus"
    }
  });

  const queued = await app.inject({
    method: "POST",
    url: "/v1/system/codex-configs/switch",
    payload: {
      profileName: "1000"
    }
  });
  assert.equal(queued.statusCode, 200);
  assert.match(queued.body, /1000/);

  const summary = await app.inject({
    method: "GET",
    url: "/v1/system/summary"
  });
  assert.equal(summary.statusCode, 200);
  assert.equal(summary.json().codexConfig.pendingAction, "switch");
  assert.equal(summary.json().codexConfig.pendingProfileName, "1000");

  const claimed = await app.inject({
    method: "POST",
    url: "/v1/runner/runner-switch-test/utilities/claim",
    headers: runnerHeaders(),
    payload: {}
  });
  assert.equal(claimed.statusCode, 200);
  const assignment = claimed.json();
  assert.equal(assignment.kind, "switch_codex_profile");
  assert.equal(assignment.profileName, "1000");
});

test("system routes queue Codex config creation utilities", async (t) => {
  const app = await createApp();
  t.after(async () => {
    await app.close();
  });

  await app.inject({
    method: "POST",
    url: "/v1/runner/hello",
    headers: runnerHeaders(),
    payload: {
      id: "runner-create-config-test",
      name: "Create Config Runner",
      platform: "macOS",
      labels: ["local"],
      capabilities: ["codex_cli"],
      version: "0.1.0",
      hostname: "create-config-host",
      codexConfigProfiles: ["1000", "plus"],
      activeCodexConfigProfile: "plus"
    }
  });

  const queued = await app.inject({
    method: "POST",
    url: "/v1/system/codex-configs/create",
    payload: {
      profileName: "demo",
      baseURL: "https://demo.example/v1",
      apiKey: "demo-token"
    }
  });
  assert.equal(queued.statusCode, 200);
  assert.match(queued.body, /demo/);

  const claimed = await app.inject({
    method: "POST",
    url: "/v1/runner/runner-create-config-test/utilities/claim",
    headers: runnerHeaders(),
    payload: {}
  });
  assert.equal(claimed.statusCode, 200);
  const assignment = claimed.json();
  assert.equal(assignment.kind, "create_codex_profile");
  assert.equal(assignment.profileName, "demo");
  assert.equal(assignment.baseURL, "https://demo.example/v1");
  assert.equal(assignment.apiKey, "demo-token");
});

test("system routes reject creating a Codex config with an existing profile name", async (t) => {
  const app = await createApp();
  t.after(async () => {
    await app.close();
  });

  await app.inject({
    method: "POST",
    url: "/v1/runner/hello",
    headers: runnerHeaders(),
    payload: {
      id: "runner-existing-config-test",
      name: "Existing Config Runner",
      platform: "macOS",
      labels: ["local"],
      capabilities: ["codex_cli"],
      version: "0.1.0",
      hostname: "existing-config-host",
      codexConfigProfiles: ["1000", "plus"],
      activeCodexConfigProfile: "plus"
    }
  });

  const response = await app.inject({
    method: "POST",
    url: "/v1/system/codex-configs/create",
    payload: {
      profileName: "plus",
      baseURL: "https://demo.example/v1",
      apiKey: "demo-token"
    }
  });

  assert.equal(response.statusCode, 409);
  assert.match(response.body, /already exists/i);
});

test("system routes queue Codex config deletion utilities", async (t) => {
  const app = await createApp();
  t.after(async () => {
    await app.close();
  });

  await app.inject({
    method: "POST",
    url: "/v1/runner/hello",
    headers: runnerHeaders(),
    payload: {
      id: "runner-delete-config-test",
      name: "Delete Config Runner",
      platform: "macOS",
      labels: ["local"],
      capabilities: ["codex_cli"],
      version: "0.1.0",
      hostname: "delete-config-host",
      codexConfigProfiles: ["1000", "plus", "demo"],
      activeCodexConfigProfile: "plus"
    }
  });

  const queued = await app.inject({
    method: "POST",
    url: "/v1/system/codex-configs/delete",
    payload: {
      profileName: "demo"
    }
  });
  assert.equal(queued.statusCode, 200);
  assert.match(queued.body, /demo/);

  const claimed = await app.inject({
    method: "POST",
    url: "/v1/runner/runner-delete-config-test/utilities/claim",
    headers: runnerHeaders(),
    payload: {}
  });
  assert.equal(claimed.statusCode, 200);
  const assignment = claimed.json();
  assert.equal(assignment.kind, "delete_codex_profile");
  assert.equal(assignment.profileName, "demo");
});

test("system routes reject deleting a protected Codex config", async (t) => {
  const app = await createApp();
  t.after(async () => {
    await app.close();
  });

  await app.inject({
    method: "POST",
    url: "/v1/runner/hello",
    headers: runnerHeaders(),
    payload: {
      id: "runner-protected-config-test",
      name: "Protected Config Runner",
      platform: "macOS",
      labels: ["local"],
      capabilities: ["codex_cli"],
      version: "0.1.0",
      hostname: "protected-config-host",
      codexConfigProfiles: ["1000", "plus", "demo"],
      activeCodexConfigProfile: "demo"
    }
  });

  const response = await app.inject({
    method: "POST",
    url: "/v1/system/codex-configs/delete",
    payload: {
      profileName: "1000"
    }
  });

  assert.equal(response.statusCode, 409);
  assert.match(response.body, /cannot be deleted/i);
});

test("runner control routes reject stale runner instances after a replacement hello", async (t) => {
  const app = await createApp();
  t.after(async () => {
    await app.close();
  });

  const basePayload = {
    id: "runner-test",
    name: "Test Runner",
    platform: "macOS" as const,
    labels: ["local"],
    capabilities: ["codex_cli"],
    version: "0.1.0",
    hostname: "test-host"
  };

  const firstHello = await app.inject({
    method: "POST",
    url: "/v1/runner/hello",
    headers: runnerHeaders("instance-a"),
    payload: basePayload
  });
  assert.equal(firstHello.statusCode, 200);

  const secondHello = await app.inject({
    method: "POST",
    url: "/v1/runner/hello",
    headers: runnerHeaders("instance-b"),
    payload: basePayload
  });
  assert.equal(secondHello.statusCode, 200);

  const staleHeartbeat = await app.inject({
    method: "POST",
    url: "/v1/runner/runner-test/heartbeat",
    headers: runnerHeaders("instance-a"),
    payload: {}
  });
  assert.equal(staleHeartbeat.statusCode, 409);
  assert.match(staleHeartbeat.body, /instance mismatch/i);

  const activeHeartbeat = await app.inject({
    method: "POST",
    url: "/v1/runner/runner-test/heartbeat",
    headers: runnerHeaders("instance-b"),
    payload: {}
  });
  assert.equal(activeHeartbeat.statusCode, 200);
});

test("runner can claim a task and report a planning result through the API", async (t) => {
  const app = await createApp();
  t.after(async () => {
    await app.close();
  });

  await app.inject({
    method: "POST",
    url: "/v1/runner/hello",
    headers: runnerHeaders(),
    payload: {
      id: "runner-test",
      name: "Test Runner",
      platform: "macOS",
      labels: ["local"],
      capabilities: ["codex_cli"],
      version: "0.1.0",
      hostname: "test-host"
    }
  });

  const created = await app.inject({
    method: "POST",
    url: "/v1/tasks",
    payload: {
      workflowKey: "coding_session",
      title: "Implement feature",
      prompt: "Add the requested feature",
      repo: "/tmp/demo-repo",
      baseBranch: "main",
      executionMode: "new_thread"
    }
  });

  assert.equal(created.statusCode, 200);
  const task = created.json();

  const claimed = await app.inject({
    method: "POST",
    url: "/v1/runner/runner-test/claim",
    headers: runnerHeaders(),
    payload: {}
  });

  assert.equal(claimed.statusCode, 200);
  const assignment = claimed.json();
  assert.equal(assignment.kind, "generate_plan");
  assert.equal(assignment.taskId, task.id);

  const completed = await app.inject({
    method: "POST",
    url: `/v1/runner/runner-test/tasks/${task.id}/complete`,
    headers: runnerHeaders(),
    payload: withCommandIdentity(assignment, {
      outcome: "plan_ready",
      planSummary: "1. Inspect\n2. Change\n3. Validate",
      session: {
        executorType: "codex_cli",
        threadId: "thread-1",
        cwd: "/tmp/worktrees/task-1",
        materializedFromHistory: false,
        lastTurnAt: "2026-03-31T10:00:00.000Z"
      }
    })
  });

  assert.equal(completed.statusCode, 200);
  const snapshot = completed.json();
  assert.equal(snapshot.status, "awaiting_plan_approval");
  assert.equal(snapshot.approvals[0]?.type, "plan.execute");
});

test("dirty workspace decision route queues the dedicated runner command", async (t) => {
  const app = await createApp();
  t.after(async () => {
    await app.close();
  });

  await app.inject({
    method: "POST",
    url: "/v1/runner/hello",
    headers: runnerHeaders(),
    payload: {
      id: "runner-test",
      name: "Test Runner",
      platform: "macOS",
      labels: ["local"],
      capabilities: ["codex_cli"],
      version: "0.1.0",
      hostname: "test-host"
    }
  });

  const created = await app.inject({
    method: "POST",
    url: "/v1/tasks",
    payload: {
      workflowKey: "coding_session",
      title: "Inspect dirty repo",
      prompt: "Handle the local repo changes safely.",
      repo: "/tmp/demo-repo",
      baseBranch: "main",
      executionMode: "new_thread"
    }
  });
  const task = created.json();

  const claimed = await app.inject({
    method: "POST",
    url: "/v1/runner/runner-test/claim",
    headers: runnerHeaders(),
    payload: {}
  });
  assert.equal(claimed.statusCode, 200);
  const initialAssignment = claimed.json();

  await app.inject({
    method: "POST",
    url: `/v1/runner/runner-test/tasks/${task.id}/complete`,
    headers: runnerHeaders(),
    payload: withCommandIdentity(initialAssignment, {
      outcome: "dirty_workspace_detected",
      summary: "Repository has uncommitted local changes on dev_3.0. Choose how to proceed before Codex edits this repo.",
      currentBranch: "dev_3.0",
      statusSummary: "## dev_3.0\n M README.md"
    })
  });

  const resolved = await app.inject({
    method: "POST",
    url: `/v1/tasks/${task.id}/actions/dirty-workspace`,
    payload: {
      decision: "plan_only"
    }
  });
  assert.equal(resolved.statusCode, 200);
  assert.equal(resolved.json().status, "queued");

  const resolutionClaim = await app.inject({
    method: "POST",
    url: "/v1/runner/runner-test/claim",
    headers: runnerHeaders(),
    payload: {}
  });
  assert.equal(resolutionClaim.statusCode, 200);
  assert.equal(resolutionClaim.json().kind, "resolve_dirty_workspace");
  assert.equal(resolutionClaim.json().dirtyWorkspaceDecision, "plan_only");
});

test("workspace recheck route queues the dedicated inspection command", async (t) => {
  const app = await createApp();
  t.after(async () => {
    await app.close();
  });

  await app.inject({
    method: "POST",
    url: "/v1/runner/hello",
    headers: runnerHeaders(),
    payload: {
      id: "runner-test",
      name: "Test Runner",
      platform: "macOS",
      labels: ["local"],
      capabilities: ["codex_cli"],
      version: "0.1.0",
      hostname: "test-host"
    }
  });

  const created = await app.inject({
    method: "POST",
    url: "/v1/tasks",
    payload: {
      workflowKey: "coding_session",
      title: "Recheck workspace",
      prompt: "Refresh the task workspace state.",
      repo: "/tmp/demo-repo",
      baseBranch: "main",
      executionMode: "new_thread"
    }
  });
  const task = created.json();

  const claimedPlan = await app.inject({
    method: "POST",
    url: "/v1/runner/runner-test/claim",
    headers: runnerHeaders(),
    payload: {}
  });
  assert.equal(claimedPlan.statusCode, 200);
  const planAssignment = claimedPlan.json();

  const completedPlan = await app.inject({
    method: "POST",
    url: `/v1/runner/runner-test/tasks/${task.id}/complete`,
    headers: runnerHeaders(),
    payload: withCommandIdentity(planAssignment, {
      outcome: "plan_ready",
      planSummary: "1. Inspect the repo\n2. Make the change",
      session: {
        executorType: "codex_cli",
        threadId: "thread-inspect",
        cwd: "/tmp/demo-repo",
        materializedFromHistory: false,
        lastTurnAt: "2026-04-03T00:10:00.000Z"
      }
    })
  });
  assert.equal(completedPlan.statusCode, 200);

  const approval = completedPlan.json().approvals[0];
  assert.equal(approval.type, "plan.execute");

  const approved = await app.inject({
    method: "POST",
    url: `/v1/approvals/${approval.id}/decision`,
    payload: {
      decision: "approve"
    }
  });
  assert.equal(approved.statusCode, 200);

  const claimedTurn = await app.inject({
    method: "POST",
    url: "/v1/runner/runner-test/claim",
    headers: runnerHeaders(),
    payload: {}
  });
  assert.equal(claimedTurn.statusCode, 200);
  const turnAssignment = claimedTurn.json();

  const completedTurn = await app.inject({
    method: "POST",
    url: `/v1/runner/runner-test/tasks/${task.id}/complete`,
    headers: runnerHeaders(),
    payload: withCommandIdentity(turnAssignment, {
      outcome: "turn_complete",
      summary: "Implementation complete."
    })
  });
  assert.equal(completedTurn.statusCode, 200);
  assert.equal(completedTurn.json().status, "completed");

  const rechecked = await app.inject({
    method: "POST",
    url: `/v1/tasks/${task.id}/actions/recheck-workspace`,
    payload: {}
  });
  assert.equal(rechecked.statusCode, 200);
  assert.equal(rechecked.json().status, "queued");

  const claim = await app.inject({
    method: "POST",
    url: "/v1/runner/runner-test/claim",
    headers: runnerHeaders(),
    payload: {}
  });
  assert.equal(claim.statusCode, 200);
  assert.equal(claim.json().kind, "inspect_workspace");
});

test("manual complete route marks awaiting-input tasks as completed without queueing runner work", async (t) => {
  const app = await createApp();
  t.after(async () => {
    await app.close();
  });

  await app.inject({
    method: "POST",
    url: "/v1/runner/hello",
    headers: runnerHeaders(),
    payload: {
      id: "runner-test",
      name: "Test Runner",
      platform: "macOS",
      labels: ["local"],
      capabilities: ["codex_cli", "git_guard"],
      version: "0.1.0",
      hostname: "test-host"
    }
  });

  const created = await app.inject({
    method: "POST",
    url: "/v1/tasks",
    payload: {
      workflowKey: "coding_session",
      deliveryMode: "direct_commit",
      title: "Manual complete",
      prompt: "Finish the current work without committing.",
      repo: "/tmp/manual-complete",
      baseBranch: "main",
      executionMode: "new_thread"
    }
  });
  assert.equal(created.statusCode, 200);
  const task = created.json();

  const claimedPlan = await app.inject({
    method: "POST",
    url: "/v1/runner/runner-test/claim",
    headers: runnerHeaders(),
    payload: {}
  });
  assert.equal(claimedPlan.statusCode, 200);
  const planAssignment = claimedPlan.json();

  await app.inject({
    method: "POST",
    url: `/v1/runner/runner-test/tasks/${task.id}/complete`,
    headers: runnerHeaders(),
    payload: withCommandIdentity(planAssignment, {
      outcome: "plan_ready",
      planSummary: "1. Update\n2. Verify\n3. Stop before committing",
      session: {
        executorType: "codex_cli",
        threadId: "thread-manual-complete",
        cwd: "/tmp/manual-complete",
        materializedFromHistory: false,
        lastTurnAt: "2026-04-10T10:00:00.000Z"
      }
    })
  });

  const claimedTurn = await app.inject({
    method: "POST",
    url: "/v1/runner/runner-test/claim",
    headers: runnerHeaders(),
    payload: {}
  });
  assert.equal(claimedTurn.statusCode, 200);
  const turnAssignment = claimedTurn.json();

  await app.inject({
    method: "POST",
    url: `/v1/runner/runner-test/tasks/${task.id}/complete`,
    headers: runnerHeaders(),
    payload: withCommandIdentity(turnAssignment, {
      outcome: "turn_complete",
      summary: "Implemented the change but stopped before committing."
    })
  });

  const completed = await app.inject({
    method: "POST",
    url: `/v1/tasks/${task.id}/actions/complete`,
    payload: {}
  });
  assert.equal(completed.statusCode, 200);
  const snapshot = completed.json();
  assert.equal(snapshot.status, "completed");
  assert.equal(
    snapshot.summary,
    "Task marked completed from iPhone without creating a local commit. Repository state was not changed."
  );

  const claim = await app.inject({
    method: "POST",
    url: "/v1/runner/runner-test/claim",
    headers: runnerHeaders(),
    payload: {}
  });
  assert.equal(claim.statusCode, 200);
  assert.equal(claim.body, "null");
});

test("resume_thread tasks can be created without a thread id", async (t) => {
  const app = await createApp();
  t.after(async () => {
    await app.close();
  });

  await app.inject({
    method: "POST",
    url: "/v1/runner/hello",
    headers: runnerHeaders(),
    payload: {
      id: "runner-test",
      name: "Test Runner",
      platform: "macOS",
      labels: ["local"],
      capabilities: ["codex_cli"],
      version: "0.1.0",
      hostname: "test-host"
    }
  });

  const response = await app.inject({
    method: "POST",
    url: "/v1/tasks",
    payload: {
      workflowKey: "coding_session",
      title: "Resume task",
      prompt: "Continue working",
      repo: "/tmp/demo-repo",
      baseBranch: "main",
      executionMode: "resume_thread"
    }
  });

  assert.equal(response.statusCode, 200);
  const task = response.json();
  assert.equal(task.executionMode, "resume_thread");
  assert.equal(task.resumeThreadId, undefined);
});

test("project resume_thread tasks can be created without a thread id", async (t) => {
  const app = await createApp();
  t.after(async () => {
    await app.close();
  });

  await app.inject({
    method: "POST",
    url: "/v1/runner/hello",
    headers: runnerHeaders(),
    payload: {
      id: "runner-test",
      name: "Test Runner",
      platform: "macOS",
      labels: ["local"],
      capabilities: ["codex_cli"],
      version: "0.1.0",
      hostname: "test-host"
    }
  });

  const sync = await app.inject({
    method: "POST",
    url: "/v1/runner/runner-test/projects/sync",
    headers: runnerHeaders(),
    payload: {
      projects: [
        {
          id: "project_resume",
          name: "resume-project",
          repo: "/tmp/resume-project",
          baseBranch: "main",
          deliveryMode: "review_required",
          autoPush: true,
          defaultTaskTitle: "Resume project task",
          defaultPrompt: "Continue the requested change.",
          isFeatured: false
        }
      ]
    }
  });
  assert.equal(sync.statusCode, 200);

  const response = await app.inject({
    method: "POST",
    url: "/v1/projects/project_resume/tasks",
    payload: {
      title: "Resume project task",
      prompt: "Continue working",
      executionMode: "resume_thread"
    }
  });

  assert.equal(response.statusCode, 200);
  const task = response.json();
  assert.equal(task.projectId, "project_resume");
  assert.equal(task.executionMode, "resume_thread");
  assert.equal(task.resumeThreadId, undefined);
});

test("placeholder repository values are rejected", async (t) => {
  const app = await createApp();
  t.after(async () => {
    await app.close();
  });

  await app.inject({
    method: "POST",
    url: "/v1/runner/hello",
    headers: runnerHeaders(),
    payload: {
      id: "runner-test",
      name: "Test Runner",
      platform: "macOS",
      labels: ["local"],
      capabilities: ["codex_cli"],
      version: "0.1.0",
      hostname: "test-host"
    }
  });

  const response = await app.inject({
    method: "POST",
    url: "/v1/tasks",
    payload: {
      workflowKey: "coding_session",
      title: "Placeholder repo task",
      prompt: "Try to run with the sample repo value",
      repo: "~/code/your-repo",
      baseBranch: "main",
      executionMode: "new_thread"
    }
  });

  assert.equal(response.statusCode, 400);
  assert.match(response.body, /repo must be a real local repository path or a real Git remote/);
});

test("creating a second unfinished task for the same repository returns a conflict", async (t) => {
  const app = await createApp();
  t.after(async () => {
    await app.close();
  });

  await app.inject({
    method: "POST",
    url: "/v1/runner/hello",
    headers: runnerHeaders(),
    payload: {
      id: "runner-test",
      name: "Test Runner",
      platform: "macOS",
      labels: ["local"],
      capabilities: ["codex_cli"],
      version: "0.1.0",
      hostname: "test-host"
    }
  });

  const first = await app.inject({
    method: "POST",
    url: "/v1/tasks",
    payload: {
      workflowKey: "coding_session",
      title: "First task",
      prompt: "Handle the first repo task",
      repo: "/tmp/shared-repo",
      baseBranch: "main",
      executionMode: "new_thread"
    }
  });
  assert.equal(first.statusCode, 200);

  const second = await app.inject({
    method: "POST",
    url: "/v1/tasks",
    payload: {
      workflowKey: "coding_session",
      title: "Second task",
      prompt: "Try to open the same repo again",
      repo: "/tmp/shared-repo/",
      baseBranch: "main",
      executionMode: "new_thread"
    }
  });

  assert.equal(second.statusCode, 409);
  assert.match(second.body, /already has an unfinished task/);
});

test("creating a second unfinished task for the same repository can be explicitly allowed", async (t) => {
  const app = await createApp();
  t.after(async () => {
    await app.close();
  });

  await app.inject({
    method: "POST",
    url: "/v1/runner/hello",
    headers: runnerHeaders(),
    payload: {
      id: "runner-test",
      name: "Test Runner",
      platform: "macOS",
      labels: ["local"],
      capabilities: ["codex_cli"],
      version: "0.1.0",
      hostname: "test-host"
    }
  });

  const first = await app.inject({
    method: "POST",
    url: "/v1/tasks",
    payload: {
      workflowKey: "coding_session",
      title: "First task",
      prompt: "Handle the first repo task",
      repo: "/tmp/shared-repo",
      baseBranch: "main",
      executionMode: "new_thread"
    }
  });
  assert.equal(first.statusCode, 200);

  const second = await app.inject({
    method: "POST",
    url: "/v1/tasks",
    payload: {
      workflowKey: "coding_session",
      title: "Second task",
      prompt: "Open the same repo in parallel",
      repo: "/tmp/shared-repo/",
      baseBranch: "main",
      executionMode: "new_thread",
      allowParallel: true
    }
  });

  assert.equal(second.statusCode, 200);
  const createdTask = second.json();
  assert.equal(createdTask.repo, "/tmp/shared-repo/");
});

test("task delete route deletes terminal history and rejects unfinished tasks", async (t) => {
  const app = await createApp();
  t.after(async () => {
    await app.close();
  });

  await app.inject({
    method: "POST",
    url: "/v1/runner/hello",
    headers: runnerHeaders(),
    payload: {
      id: "runner-test",
      name: "Test Runner",
      platform: "macOS",
      labels: ["local"],
      capabilities: ["codex_cli"],
      version: "0.1.0",
      hostname: "test-host"
    }
  });

  const created = await app.inject({
    method: "POST",
    url: "/v1/tasks",
    payload: {
      workflowKey: "coding_session",
      title: "Delete me later",
      prompt: "Create a disposable task",
      repo: "/tmp/delete-repo",
      baseBranch: "main",
      executionMode: "new_thread"
    }
  });
  assert.equal(created.statusCode, 200);
  const task = created.json();

  const prematureDelete = await app.inject({
    method: "DELETE",
    url: `/v1/tasks/${task.id}`
  });
  assert.equal(prematureDelete.statusCode, 409);
  assert.match(prematureDelete.body, /must be completed, failed, or canceled/);

  const claimed = await app.inject({
    method: "POST",
    url: "/v1/runner/runner-test/claim",
    headers: runnerHeaders(),
    payload: {}
  });
  assert.equal(claimed.statusCode, 200);

  const failed = await app.inject({
    method: "POST",
    url: `/v1/runner/runner-test/tasks/${task.id}/complete`,
    headers: runnerHeaders(),
    payload: withCommandIdentity(claimed.json(), {
      outcome: "failed",
      summary: "Runner failed while preparing the workspace.",
      detail: "workspace lock timed out"
    })
  });
  assert.equal(failed.statusCode, 200);

  const deleted = await app.inject({
    method: "DELETE",
    url: `/v1/tasks/${task.id}`
  });
  assert.equal(deleted.statusCode, 204);

  const fetchDeleted = await app.inject({
    method: "GET",
    url: `/v1/tasks/${task.id}`
  });
  assert.equal(fetchDeleted.statusCode, 404);
});

test("task stop and delete routes accept an empty JSON content-type body", async (t) => {
  const app = await createApp();
  t.after(async () => {
    await app.close();
  });

  await app.inject({
    method: "POST",
    url: "/v1/runner/hello",
    headers: runnerHeaders(),
    payload: {
      id: "runner-test",
      name: "Test Runner",
      platform: "macOS",
      labels: ["local"],
      capabilities: ["codex_cli"],
      version: "0.1.0",
      hostname: "test-host"
    }
  });

  const created = await app.inject({
    method: "POST",
    url: "/v1/tasks",
    payload: {
      workflowKey: "coding_session",
      title: "Empty body compatibility",
      prompt: "Exercise empty JSON parser compatibility.",
      repo: "/tmp/empty-body-repo",
      baseBranch: "main",
      executionMode: "new_thread"
    }
  });
  assert.equal(created.statusCode, 200);
  const task = created.json();

  const stopped = await app.inject({
    method: "POST",
    url: `/v1/tasks/${task.id}/actions/stop`,
    headers: {
      "content-type": "application/json"
    }
  });
  assert.equal(stopped.statusCode, 200);
  assert.equal(stopped.json().status, "canceled");

  const deleted = await app.inject({
    method: "DELETE",
    url: `/v1/tasks/${task.id}`,
    headers: {
      "content-type": "application/json"
    }
  });
  assert.equal(deleted.statusCode, 204);
});

test("directory preset sync and create-directory utility flow works through the API", async (t) => {
  const app = await createApp();
  t.after(async () => {
    await app.close();
  });

  await app.inject({
    method: "POST",
    url: "/v1/runner/hello",
    headers: runnerHeaders(),
    payload: {
      id: "runner-test",
      name: "Test Runner",
      platform: "macOS",
      labels: ["local"],
      capabilities: ["codex_cli"],
      version: "0.1.0",
      hostname: "test-host"
    }
  });

  const sync = await app.inject({
    method: "POST",
    url: "/v1/runner/runner-test/directories/sync",
    headers: runnerHeaders(),
    payload: {
      presets: [
        {
          id: "preset_projects",
          label: "Projects",
          rootPath: "/Users/test/Projects"
        }
      ]
    }
  });
  assert.equal(sync.statusCode, 200);

  const directories = await app.inject({
    method: "GET",
    url: "/v1/directories"
  });
  assert.equal(directories.statusCode, 200);
  const presetId = directories.json()[0]?.id;
  assert.equal(presetId, "runner-test:preset_projects");

  const queued = await app.inject({
    method: "POST",
    url: "/v1/directories/actions/create",
    payload: {
      presetId,
      relativePath: "feature/app-shell"
    }
  });
  assert.equal(queued.statusCode, 200);
  assert.equal(queued.json().absolutePath, "/Users/test/Projects/feature/app-shell");

  const claim = await app.inject({
    method: "POST",
    url: "/v1/runner/runner-test/utilities/claim",
    headers: runnerHeaders(),
    payload: {}
  });
  assert.equal(claim.statusCode, 200);
  assert.equal(claim.json().kind, "create_directory");
  assert.equal(claim.json().absolutePath, "/Users/test/Projects/feature/app-shell");

  const completed = await app.inject({
    method: "POST",
    url: `/v1/runner/runner-test/utilities/${claim.json().id}/complete`,
    headers: runnerHeaders(),
    payload: {
      claimToken: claim.json().claimToken,
      outcome: "completed",
      absolutePath: "/Users/test/Projects/feature/app-shell",
      message: "created"
    }
  });
  assert.equal(completed.statusCode, 200);

  const nextClaim = await app.inject({
    method: "POST",
    url: "/v1/runner/runner-test/utilities/claim",
    headers: runnerHeaders(),
    payload: {}
  });
  assert.equal(nextClaim.statusCode, 200);
  assert.equal(nextClaim.body, "null");
});

test("runner project sync enables project-first task creation and listing", async (t) => {
  const app = await createApp();
  t.after(async () => {
    await app.close();
  });

  await app.inject({
    method: "POST",
    url: "/v1/runner/hello",
    headers: runnerHeaders(),
    payload: {
      id: "runner-test",
      name: "Test Runner",
      platform: "macOS",
      labels: ["local"],
      capabilities: ["codex_cli"],
      version: "0.1.0",
      hostname: "test-host"
    }
  });

  const sync = await app.inject({
    method: "POST",
    url: "/v1/runner/runner-test/projects/sync",
    headers: runnerHeaders(),
    payload: {
      projects: [
        {
          id: "project_ring",
          name: "ring",
          repo: "/tmp/ring",
          baseBranch: "main",
          deliveryMode: "direct_commit",
          autoPush: true,
          defaultTaskTitle: "Continue ring task",
          defaultPrompt: "Implement the requested change.",
          isFeatured: true
        }
      ]
    }
  });

  assert.equal(sync.statusCode, 200);

  const projects = await app.inject({
    method: "GET",
    url: "/v1/projects"
  });

  assert.equal(projects.statusCode, 200);
  const [project] = projects.json();
  assert.equal(project.id, "project_ring");
  assert.equal(project.runnerId, "runner-test");
  assert.equal(project.deliveryMode, "direct_commit");
  assert.equal(project.autoPush, true);
  assert.equal(project.isFeatured, true);
  assert.equal(project.recentTasksCount, 0);

  const created = await app.inject({
    method: "POST",
    url: "/v1/projects/project_ring/tasks",
    payload: {
      title: "Fix ring detail screen",
      prompt: "Adjust the spacing in the detail screen.",
      executionMode: "new_thread"
    }
  });

  assert.equal(created.statusCode, 200);
  const task = created.json();
  assert.equal(task.projectId, "project_ring");
  assert.equal(task.projectName, "ring");
  assert.equal(task.repo, "/tmp/ring");
  assert.equal(task.baseBranch, "main");
  assert.equal(task.deliveryMode, "direct_commit");
  assert.equal(task.autoPush, true);
  assert.equal(task.branchMode, "current_branch");
  assert.equal(task.branchName, undefined);

  const claimedPlan = await app.inject({
    method: "POST",
    url: "/v1/runner/runner-test/claim",
    headers: runnerHeaders(),
    payload: {}
  });
  assert.equal(claimedPlan.statusCode, 200);
  const planAssignment = claimedPlan.json();

  await app.inject({
    method: "POST",
    url: `/v1/runner/runner-test/tasks/${task.id}/complete`,
    headers: runnerHeaders(),
    payload: withCommandIdentity(planAssignment, {
      outcome: "plan_ready",
      planSummary: "1. Inspect\n2. Adjust spacing\n3. Verify",
      session: {
        executorType: "codex_cli",
        threadId: "thread-ring",
        cwd: "/tmp/worktrees/ring-task",
        materializedFromHistory: false,
        lastTurnAt: "2026-04-01T10:00:00.000Z"
      }
    })
  });

  const approvals = await app.inject({
    method: "GET",
    url: "/v1/approvals"
  });
  const planApproval = approvals.json().find((candidate: { taskId: string; type: string }) => {
    return candidate.taskId === task.id && candidate.type === "plan.execute";
  });
  assert.equal(planApproval, undefined);

  const claimedTurn = await app.inject({
    method: "POST",
    url: "/v1/runner/runner-test/claim",
    headers: runnerHeaders(),
    payload: {}
  });
  assert.equal(claimedTurn.statusCode, 200);
  const turnAssignment = claimedTurn.json();

  await app.inject({
    method: "POST",
    url: `/v1/runner/runner-test/tasks/${task.id}/complete`,
    headers: runnerHeaders(),
    payload: withCommandIdentity(turnAssignment, {
      outcome: "turn_complete",
      summary: "Adjusted the detail screen spacing and confirmed the layout.",
      testsSummary: "xcodebuild -scheme ring-app test",
      reportURL: "https://reports.example.com/blob/main/ring_feature-task-report_task-report_2026-04-01_18-05-00.md",
      lastPublishedAt: "2026-04-01T10:05:00.000Z",
      latestResultSummary: "Spacing adjusted and verified."
    })
  });

  const projectDetail = await app.inject({
    method: "GET",
    url: "/v1/projects/project_ring"
  });

  assert.equal(projectDetail.statusCode, 200);
  const projectSnapshot = projectDetail.json();
  assert.equal(projectSnapshot.recentTasksCount, 1);
  assert.equal(projectSnapshot.latestTaskId, task.id);
  assert.equal(projectSnapshot.latestTaskStatus, "awaiting_human_input");
  assert.equal(projectSnapshot.latestReportURL, "https://reports.example.com/blob/main/ring_feature-task-report_task-report_2026-04-01_18-05-00.md");
  assert.equal(projectSnapshot.latestResultSummary, "Spacing adjusted and verified.");

  const taskList = await app.inject({
    method: "GET",
    url: "/v1/projects/project_ring/tasks?status=awaiting_human_input&limit=5"
  });

  assert.equal(taskList.statusCode, 200);
  const scopedTasks = taskList.json();
  assert.equal(scopedTasks.length, 1);
  assert.equal(scopedTasks[0].id, task.id);
  assert.equal(scopedTasks[0].reportURL, "https://reports.example.com/blob/main/ring_feature-task-report_task-report_2026-04-01_18-05-00.md");
  assert.equal(scopedTasks[0].latestResultSummary, "Spacing adjusted and verified.");
});

test("direct-commit implementation completions surface completed status through project APIs", async (t) => {
  const app = await createApp();
  t.after(async () => {
    await app.close();
  });

  await app.inject({
    method: "POST",
    url: "/v1/runner/hello",
    headers: runnerHeaders(),
    payload: {
      id: "runner-test",
      name: "Test Runner",
      platform: "macOS",
      labels: ["local"],
      capabilities: ["codex_cli", "git_guard"],
      version: "0.1.0",
      hostname: "test-host"
    }
  });

  await app.inject({
    method: "POST",
    url: "/v1/runner/runner-test/projects/sync",
    headers: runnerHeaders(),
    payload: {
      projects: [
        {
          id: "project_direct_complete",
          name: "direct",
          repo: "/tmp/direct-complete",
          baseBranch: "main",
          deliveryMode: "direct_commit",
          autoPush: true,
          defaultTaskTitle: "Ship direct task",
          defaultPrompt: "Make the change and commit it locally.",
          isFeatured: false
        }
      ]
    }
  });

  const created = await app.inject({
    method: "POST",
    url: "/v1/projects/project_direct_complete/tasks",
    payload: {
      title: "Finish local commit flow",
      prompt: "Update the task semantics and commit locally.",
      executionMode: "new_thread"
    }
  });

  assert.equal(created.statusCode, 200);
  const task = created.json();

  const claimedPlan = await app.inject({
    method: "POST",
    url: "/v1/runner/runner-test/claim",
    headers: runnerHeaders(),
    payload: {}
  });
  assert.equal(claimedPlan.statusCode, 200);
  const planAssignment = claimedPlan.json();

  await app.inject({
    method: "POST",
    url: `/v1/runner/runner-test/tasks/${task.id}/complete`,
    headers: runnerHeaders(),
    payload: withCommandIdentity(planAssignment, {
      outcome: "plan_ready",
      planSummary: "1. Inspect\n2. Change\n3. Commit locally",
      session: {
        executorType: "codex_cli",
        threadId: "thread-direct-complete",
        cwd: "/tmp/worktrees/direct-complete",
        materializedFromHistory: false,
        lastTurnAt: "2026-04-08T10:00:00.000Z"
      }
    })
  });

  const claimedTurn = await app.inject({
    method: "POST",
    url: "/v1/runner/runner-test/claim",
    headers: runnerHeaders(),
    payload: {}
  });
  assert.equal(claimedTurn.statusCode, 200);
  const turnAssignment = claimedTurn.json();

  const completedTurn = await app.inject({
    method: "POST",
    url: `/v1/runner/runner-test/tasks/${task.id}/complete`,
    headers: runnerHeaders(),
    payload: withCommandIdentity(turnAssignment, {
      outcome: "turn_complete",
      summary: "Updated the task semantics and created a local commit.",
      implementationCommitCreated: true,
      latestResultSummary: "Task semantics updated and committed locally."
    })
  });
  assert.equal(completedTurn.statusCode, 200);

  const projectDetail = await app.inject({
    method: "GET",
    url: "/v1/projects/project_direct_complete"
  });
  assert.equal(projectDetail.statusCode, 200);
  const projectSnapshot = projectDetail.json();
  assert.equal(projectSnapshot.latestTaskId, task.id);
  assert.equal(projectSnapshot.latestTaskStatus, "completed");
  assert.equal(projectSnapshot.latestResultSummary, "Task semantics updated and committed locally.");

  const completedTasks = await app.inject({
    method: "GET",
    url: "/v1/projects/project_direct_complete/tasks?status=completed&limit=5"
  });
  assert.equal(completedTasks.statusCode, 200);
  const scopedTasks = completedTasks.json();
  assert.equal(scopedTasks.length, 1);
  assert.equal(scopedTasks[0].id, task.id);
  assert.equal(scopedTasks[0].status, "completed");
});
