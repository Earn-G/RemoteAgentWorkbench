import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import {
  createCodexProfile,
  deleteCodexProfile,
  readCodexConfigSnapshot,
  restartCodexApp,
  resolveLiveCodexDirectory,
  sortCodexProfileNames,
  switchCodexProfile
} from "./codexConfigManager.js";

test("sortCodexProfileNames keeps 1000 and plus at the front", () => {
  assert.deepEqual(
    sortCodexProfileNames(["demo", "plus", "1000", "alpha"]),
    ["1000", "plus", "alpha", "demo"]
  );
});

test("readCodexConfigSnapshot detects the active profile from ~/.codex", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-config-snapshot-"));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const profilesRoot = path.join(tempRoot, "profiles");
  const liveRoot = path.join(tempRoot, ".codex");
  await fs.mkdir(path.join(profilesRoot, "1000"), { recursive: true });
  await fs.mkdir(path.join(profilesRoot, "plus"), { recursive: true });
  await fs.mkdir(liveRoot, { recursive: true });

  await fs.writeFile(path.join(profilesRoot, "1000", "auth.json"), "{\n    \"OPENAI_API_KEY\": \"token-1000\"\n}\n");
  await fs.writeFile(path.join(profilesRoot, "1000", "config.toml"), "[model_providers.codex]\nbase_url = \"https://1000.example/v1\"\n");
  await fs.writeFile(path.join(profilesRoot, "plus", "auth.json"), "{\n    \"OPENAI_API_KEY\": \"token-plus\"\n}\n");
  await fs.writeFile(path.join(profilesRoot, "plus", "config.toml"), "[model_providers.codex]\nbase_url = \"https://plus.example/v1\"\n");

  await fs.copyFile(path.join(profilesRoot, "plus", "auth.json"), path.join(liveRoot, "auth.json"));
  await fs.copyFile(path.join(profilesRoot, "plus", "config.toml"), path.join(liveRoot, "config.toml"));

  const snapshot = await readCodexConfigSnapshot(profilesRoot, liveRoot);
  assert.deepEqual(snapshot.profiles, ["1000", "plus"]);
  assert.equal(snapshot.activeProfileName, "plus");
});

test("createCodexProfile uses the 1000 template, saves a new profile, and activates it", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-config-create-"));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const profilesRoot = path.join(tempRoot, "profiles");
  const liveRoot = path.join(tempRoot, ".codex");
  await fs.mkdir(path.join(profilesRoot, "1000"), { recursive: true });

  await fs.writeFile(
    path.join(profilesRoot, "1000", "config.toml"),
    "model_provider = \"codex\"\n\n[model_providers.codex]\nname = \"codex\"\nbase_url = \"https://template.example/v1\"\nwire_api = \"responses\"\n"
  );
  await fs.writeFile(
    path.join(profilesRoot, "1000", "auth.json"),
    "{\n    \"OPENAI_API_KEY\": \"template-token\"\n}\n"
  );

  const result = await createCodexProfile({
    profilesRoot,
    liveCodexDirectory: liveRoot,
    templateProfileName: "1000",
    profileName: "demo",
    baseURL: "https://demo.example/v1",
    apiKey: "demo-token"
  });

  assert.equal(result.profileName, "demo");
  assert.equal(result.snapshot.activeProfileName, "demo");
  assert.deepEqual(result.snapshot.profiles, ["1000", "demo"]);

  const createdConfig = await fs.readFile(path.join(profilesRoot, "demo", "config.toml"), "utf8");
  const createdAuth = await fs.readFile(path.join(profilesRoot, "demo", "auth.json"), "utf8");
  const liveConfig = await fs.readFile(path.join(liveRoot, "config.toml"), "utf8");
  const liveAuth = await fs.readFile(path.join(liveRoot, "auth.json"), "utf8");

  assert.match(createdConfig, /https:\/\/demo\.example\/v1/);
  assert.match(createdAuth, /demo-token/);
  assert.equal(liveConfig, createdConfig);
  assert.equal(liveAuth, createdAuth);
});

test("createCodexProfile rejects an existing profile name instead of overwriting it", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-config-create-duplicate-"));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const profilesRoot = path.join(tempRoot, "profiles");
  const liveRoot = path.join(tempRoot, ".codex");
  await fs.mkdir(path.join(profilesRoot, "1000"), { recursive: true });
  await fs.mkdir(path.join(profilesRoot, "demo"), { recursive: true });

  await fs.writeFile(
    path.join(profilesRoot, "1000", "config.toml"),
    "model_provider = \"codex\"\n\n[model_providers.codex]\nbase_url = \"https://template.example/v1\"\n"
  );
  await fs.writeFile(
    path.join(profilesRoot, "1000", "auth.json"),
    "{\n    \"OPENAI_API_KEY\": \"template-token\"\n}\n"
  );
  await fs.writeFile(
    path.join(profilesRoot, "demo", "config.toml"),
    "[model_providers.codex]\nbase_url = \"https://existing.example/v1\"\n"
  );
  await fs.writeFile(
    path.join(profilesRoot, "demo", "auth.json"),
    "{\n    \"OPENAI_API_KEY\": \"existing-token\"\n}\n"
  );

  await assert.rejects(
    () =>
      createCodexProfile({
        profilesRoot,
        liveCodexDirectory: liveRoot,
        templateProfileName: "1000",
        profileName: "demo",
        baseURL: "https://demo.example/v1",
        apiKey: "demo-token"
      }),
    /already exists/
  );

  const existingConfig = await fs.readFile(path.join(profilesRoot, "demo", "config.toml"), "utf8");
  const existingAuth = await fs.readFile(path.join(profilesRoot, "demo", "auth.json"), "utf8");
  assert.match(existingConfig, /https:\/\/existing\.example\/v1/);
  assert.match(existingAuth, /existing-token/);
});

test("switchCodexProfile copies an existing profile into the live Codex directory", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-config-switch-"));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const profilesRoot = path.join(tempRoot, "profiles");
  const liveRoot = path.join(tempRoot, ".codex");
  await fs.mkdir(path.join(profilesRoot, "plus"), { recursive: true });

  await fs.writeFile(path.join(profilesRoot, "plus", "config.toml"), "[model_providers.codex]\nbase_url = \"https://plus.example/v1\"\n");
  await fs.writeFile(path.join(profilesRoot, "plus", "auth.json"), "{\n    \"OPENAI_API_KEY\": \"plus-token\"\n}\n");

  const result = await switchCodexProfile(profilesRoot, liveRoot, "plus");
  assert.equal(result.snapshot.activeProfileName, "plus");

  const liveConfig = await fs.readFile(path.join(liveRoot, "config.toml"), "utf8");
  const liveAuth = await fs.readFile(path.join(liveRoot, "auth.json"), "utf8");
  assert.match(liveConfig, /https:\/\/plus\.example\/v1/);
  assert.match(liveAuth, /plus-token/);
});

test("deleteCodexProfile removes an inactive custom profile and keeps the active one unchanged", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-config-delete-"));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const profilesRoot = path.join(tempRoot, "profiles");
  const liveRoot = path.join(tempRoot, ".codex");
  await fs.mkdir(path.join(profilesRoot, "1000"), { recursive: true });
  await fs.mkdir(path.join(profilesRoot, "plus"), { recursive: true });
  await fs.mkdir(path.join(profilesRoot, "demo"), { recursive: true });
  await fs.mkdir(liveRoot, { recursive: true });

  await fs.writeFile(path.join(profilesRoot, "1000", "config.toml"), "[model_providers.codex]\nbase_url = \"https://1000.example/v1\"\n");
  await fs.writeFile(path.join(profilesRoot, "1000", "auth.json"), "{\n    \"OPENAI_API_KEY\": \"token-1000\"\n}\n");
  await fs.writeFile(path.join(profilesRoot, "plus", "config.toml"), "[model_providers.codex]\nbase_url = \"https://plus.example/v1\"\n");
  await fs.writeFile(path.join(profilesRoot, "plus", "auth.json"), "{\n    \"OPENAI_API_KEY\": \"token-plus\"\n}\n");
  await fs.writeFile(path.join(profilesRoot, "demo", "config.toml"), "[model_providers.codex]\nbase_url = \"https://demo.example/v1\"\n");
  await fs.writeFile(path.join(profilesRoot, "demo", "auth.json"), "{\n    \"OPENAI_API_KEY\": \"token-demo\"\n}\n");

  await fs.copyFile(path.join(profilesRoot, "plus", "auth.json"), path.join(liveRoot, "auth.json"));
  await fs.copyFile(path.join(profilesRoot, "plus", "config.toml"), path.join(liveRoot, "config.toml"));

  const result = await deleteCodexProfile(profilesRoot, liveRoot, "demo");
  assert.equal(result.profileName, "demo");
  assert.deepEqual(result.snapshot.profiles, ["1000", "plus"]);
  assert.equal(result.snapshot.activeProfileName, "plus");

  await assert.rejects(() => fs.access(path.join(profilesRoot, "demo")));
});

test("deleteCodexProfile rejects deleting the active profile", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-config-delete-active-"));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const profilesRoot = path.join(tempRoot, "profiles");
  const liveRoot = path.join(tempRoot, ".codex");
  await fs.mkdir(path.join(profilesRoot, "demo"), { recursive: true });
  await fs.mkdir(liveRoot, { recursive: true });
  await fs.writeFile(path.join(profilesRoot, "demo", "config.toml"), "[model_providers.codex]\nbase_url = \"https://demo.example/v1\"\n");
  await fs.writeFile(path.join(profilesRoot, "demo", "auth.json"), "{\n    \"OPENAI_API_KEY\": \"token-demo\"\n}\n");
  await fs.copyFile(path.join(profilesRoot, "demo", "auth.json"), path.join(liveRoot, "auth.json"));
  await fs.copyFile(path.join(profilesRoot, "demo", "config.toml"), path.join(liveRoot, "config.toml"));

  await assert.rejects(
    () => deleteCodexProfile(profilesRoot, liveRoot, "demo"),
    /currently active/
  );

  await fs.access(path.join(profilesRoot, "demo"));
});

test("resolveLiveCodexDirectory falls back to ~/.codex when RUNNER_CODEX_HOME is empty", () => {
  assert.equal(resolveLiveCodexDirectory(""), path.join(os.homedir(), ".codex"));
});

test("restartCodexApp kills both Codex app and codex app-server before reopening", async () => {
  const exactMatches = new Set(["Codex", "codex"]);
  const fullMatches = new Set(["Contents/Resources/codex app-server"]);
  const calls: Array<{ file: string; args: string[] }> = [];

  const execFile = async (file: string, args: readonly string[] = []) => {
    calls.push({ file, args: [...args] });

    if (file === "/usr/bin/pkill") {
      if (args[0] === "-x" && exactMatches.has(args[1]!)) {
        exactMatches.delete(args[1]!);
        return { stdout: "", stderr: "" };
      }

      if (args[0] === "-f" && fullMatches.has(args[1]!)) {
        fullMatches.delete(args[1]!);
        return { stdout: "", stderr: "" };
      }

      const error = new Error("no matching process") as Error & { code?: number };
      error.code = 1;
      throw error;
    }

    if (file === "/usr/bin/pgrep") {
      const isRunning = args[0] === "-x"
        ? exactMatches.has(args[1]!)
        : fullMatches.has(args[1]!);

      if (isRunning) {
        return { stdout: "123\n", stderr: "" };
      }

      const error = new Error("no matching process") as Error & { code?: number };
      error.code = 1;
      throw error;
    }

    assert.equal(file, "/usr/bin/open");
    assert.deepEqual(args, ["-a", "Codex"]);
    return { stdout: "", stderr: "" };
  };

  await restartCodexApp({
    execFile,
    timeoutMs: 1000,
    pollIntervalMs: 0
  });

  assert.deepEqual(exactMatches.size, 0);
  assert.deepEqual(fullMatches.size, 0);
  assert.deepEqual(
    calls.slice(0, 3).map((call) => `${call.file} ${call.args.join(" ")}`),
    [
      "/usr/bin/pkill -x Codex",
      "/usr/bin/pkill -f Contents/Resources/codex app-server",
      "/usr/bin/pkill -x codex"
    ]
  );
  assert.equal(calls.at(-1)?.file, "/usr/bin/open");
});
