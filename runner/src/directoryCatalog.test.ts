import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DirectoryCatalog } from "./directoryCatalog.js";

test("directory catalog seeds defaults and only syncs when presets change", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "raw-directory-catalog-"));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const filePath = path.join(tempRoot, "directories.json");
  const catalog = new DirectoryCatalog(filePath);
  const syncCalls: Array<{ runnerId: string; presets: Array<{ id: string; rootPath: string }> }> = [];
  const client = {
    async syncDirectoryPresets(
      runnerId: string,
      payload: { presets: Array<{ id: string; rootPath: string }> }
    ) {
      syncCalls.push({
        runnerId,
        presets: payload.presets
      });
    }
  };

  const seeded = await catalog.loadPresets();
  assert.deepEqual(seeded, []);
  assert.equal(await fs.readFile(filePath, "utf8"), "[]\n");

  assert.equal(await catalog.syncIfChanged(client as never, "runner-test"), true);
  assert.deepEqual(syncCalls, [
    {
      runnerId: "runner-test",
      presets: []
    }
  ]);

  assert.equal(await catalog.syncIfChanged(client as never, "runner-test"), false);

  await fs.writeFile(
    filePath,
    `${JSON.stringify(
      [
        {
          id: "preset_projects",
          label: "Projects",
          rootPath: "/Users/test/Projects"
        }
      ],
      null,
      2
    )}\n`,
    "utf8"
  );

  const loaded = await catalog.loadPresets();
  assert.deepEqual(loaded, [
    {
      id: "preset_projects",
      label: "Projects",
      rootPath: "/Users/test/Projects"
    }
  ]);

  assert.equal(await catalog.syncIfChanged(client as never, "runner-test"), true);
  assert.deepEqual(syncCalls.at(-1), {
    runnerId: "runner-test",
    presets: [
      {
        id: "preset_projects",
        label: "Projects",
        rootPath: "/Users/test/Projects"
      }
    ]
  });
});

test("directory catalog expands ~/ and drops relative root paths", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "raw-directory-catalog-paths-"));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const filePath = path.join(tempRoot, "directories.json");
  await fs.writeFile(
    filePath,
    `${JSON.stringify(
      [
        {
          id: "preset_home",
          label: "Home Projects",
          rootPath: "~/Projects"
        },
        {
          id: "preset_relative",
          label: "Relative",
          rootPath: "Desktop/demo"
        }
      ],
      null,
      2
    )}\n`,
    "utf8"
  );

  const catalog = new DirectoryCatalog(filePath);
  const loaded = await catalog.loadPresets();

  assert.deepEqual(loaded, [
    {
      id: "preset_home",
      label: "Home Projects",
      rootPath: path.join(os.homedir(), "Projects")
    }
  ]);
});
