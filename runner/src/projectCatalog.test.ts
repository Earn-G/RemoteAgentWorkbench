import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ProjectCatalog } from "./projectCatalog.js";

test("project catalog seeds defaults and only syncs when the catalog changes", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "raw-project-catalog-"));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const filePath = path.join(tempRoot, "projects.json");
  const catalog = new ProjectCatalog(filePath);
  const syncCalls: Array<{
    runnerId: string;
    projects: Array<{ id: string; deliveryMode: string; autoPush: boolean; isFeatured: boolean }>;
  }> = [];
  const client = {
    async syncProjects(
      runnerId: string,
      payload: { projects: Array<{ id: string; deliveryMode: string; autoPush: boolean; isFeatured: boolean }> }
    ) {
      syncCalls.push({
        runnerId,
        projects: payload.projects.map((project) => ({
          id: project.id,
          deliveryMode: project.deliveryMode,
          autoPush: project.autoPush,
          isFeatured: project.isFeatured
        }))
      });
    }
  };

  const seeded = await catalog.loadProjects();
  assert.deepEqual(seeded, []);
  assert.equal(await fs.readFile(filePath, "utf8"), "[]\n");

  assert.equal(await catalog.syncIfChanged(client as never, "runner-test"), true);
  assert.deepEqual(syncCalls, [
    {
      runnerId: "runner-test",
      projects: []
    }
  ]);

  assert.equal(await catalog.syncIfChanged(client as never, "runner-test"), false);

  await fs.writeFile(
    filePath,
    `${JSON.stringify(
      [
        {
          id: "project_demo",
          name: "Demo",
          repo: "/tmp/demo",
          baseBranch: "main",
          deliveryMode: "direct_commit",
          autoPush: false,
          defaultTaskTitle: "Continue demo task",
          defaultPrompt: "Implement the requested demo change.",
          isFeatured: true
        }
      ],
      null,
      2
    )}\n`,
    "utf8"
  );

  assert.equal(await catalog.syncIfChanged(client as never, "runner-test"), true);
  assert.deepEqual(syncCalls.at(-1), {
    runnerId: "runner-test",
    projects: [{ id: "project_demo", deliveryMode: "direct_commit", autoPush: false, isFeatured: true }]
  });

  assert.equal(
    await catalog.resolveReportNamespace({ projectId: "project_demo", repo: "/tmp/demo" }),
    "project_demo"
  );

  assert.equal(await catalog.syncIfChanged(client as never, "runner-test", { force: true }), true);
  assert.deepEqual(syncCalls.at(-1), {
    runnerId: "runner-test",
    projects: [{ id: "project_demo", deliveryMode: "direct_commit", autoPush: false, isFeatured: true }]
  });
});

test("project catalog prefers explicit report namespaces when configured", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "raw-project-catalog-namespace-"));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const filePath = path.join(tempRoot, "projects.json");
  await fs.writeFile(
    filePath,
    `${JSON.stringify(
      [
        {
          id: "project_demo",
          name: "Demo",
          repo: "/tmp/demo",
          baseBranch: "main",
          defaultTaskTitle: "Continue demo task",
          defaultPrompt: "Implement the requested demo change.",
          isFeatured: true,
          reportNamespace: "ios/demo"
        }
      ],
      null,
      2
    )}\n`,
    "utf8"
  );

  const catalog = new ProjectCatalog(filePath);
  const [project] = await catalog.loadProjects();
  assert.equal(project?.deliveryMode, "review_required");
  assert.equal(project?.autoPush, true);
  assert.equal(
    await catalog.resolveReportNamespace({ projectId: "project_demo", repo: "/tmp/demo" }),
    "ios/demo"
  );
});

test("project catalog expands ~/ repos and skips invalid entries", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "raw-project-catalog-paths-"));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const filePath = path.join(tempRoot, "projects.json");
  await fs.writeFile(
    filePath,
    `${JSON.stringify(
      [
        {
          id: "project_home",
          name: "Home Project",
          repo: "~/Code/demo",
          baseBranch: "main",
          defaultTaskTitle: "Continue home project task",
          defaultPrompt: "Implement the requested change."
        },
        {
          id: "project_invalid",
          name: "Invalid",
          repo: "",
          baseBranch: "main",
          defaultTaskTitle: "Invalid",
          defaultPrompt: "Invalid"
        }
      ],
      null,
      2
    )}\n`,
    "utf8"
  );

  const catalog = new ProjectCatalog(filePath);
  const loaded = await catalog.loadProjects();
  assert.deepEqual(loaded, [
    {
      id: "project_home",
      name: "Home Project",
      repo: path.join(os.homedir(), "Code", "demo"),
      baseBranch: "main",
      deliveryMode: "review_required",
      autoPush: true,
      defaultTaskTitle: "Continue home project task",
      defaultPrompt: "Implement the requested change.",
      isFeatured: false,
      reportNamespace: undefined
    }
  ]);
});

test("project catalog can pin a newly created local folder as a project", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "raw-project-catalog-directory-"));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const filePath = path.join(tempRoot, "projects.json");
  const directoryPath = path.join(tempRoot, "Clients", "Acme Demo");
  const catalog = new ProjectCatalog(filePath);

  const project = await catalog.upsertDirectoryProject({
    absolutePath: directoryPath,
    name: "Acme Demo",
    deliveryMode: "direct_commit",
    autoPush: false
  });

  assert.match(project.id, /^folder_acme-demo_[a-f0-9]{8}$/);
  assert.equal(project.name, "Acme Demo");
  assert.equal(project.repo, directoryPath);
  assert.equal(project.baseBranch, "main");
  assert.equal(project.deliveryMode, "direct_commit");
  assert.equal(project.autoPush, false);
  assert.equal(project.isFeatured, true);
  assert.equal(project.reportNamespace, "folders/acme-demo");

  const updated = await catalog.upsertDirectoryProject({
    absolutePath: directoryPath,
    name: "Acme Demo Updated",
    baseBranch: "trunk",
    deliveryMode: "review_required",
    autoPush: true
  });
  const loaded = await catalog.loadProjects();

  assert.equal(updated.id, project.id);
  assert.equal(updated.name, "Acme Demo Updated");
  assert.equal(updated.baseBranch, "trunk");
  assert.equal(updated.deliveryMode, "review_required");
  assert.equal(updated.autoPush, true);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0]?.id, project.id);
});
