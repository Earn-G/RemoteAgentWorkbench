import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const AUTH_FILE_NAME = "auth.json";
const CONFIG_FILE_NAME = "config.toml";

export interface CodexConfigSnapshot {
  profiles: string[];
  activeProfileName?: string;
}

interface CodexConfigApplyResult {
  snapshot: CodexConfigSnapshot;
  profileName: string;
  profileDirectory: string;
}

type ExecFileLike = (file: string, args?: readonly string[]) => Promise<{
  stdout: string;
  stderr: string;
}>;

interface ProcessMatchTarget {
  mode: "exact" | "full";
  pattern: string;
}

const CODEX_RESTART_TARGETS: ProcessMatchTarget[] = [
  { mode: "exact", pattern: "Codex" },
  { mode: "full", pattern: "Contents/Resources/codex app-server" },
  { mode: "exact", pattern: "codex" }
];

export function resolveLiveCodexDirectory(configuredCodexHome: string): string {
  return configuredCodexHome.trim().length > 0
    ? configuredCodexHome.trim()
    : path.join(os.homedir(), ".codex");
}

export function sortCodexProfileNames(profileNames: string[]): string[] {
  const unique = Array.from(new Set(profileNames.map((name) => name.trim()).filter(Boolean)));
  return unique.sort((lhs, rhs) => profileSortKey(lhs).localeCompare(profileSortKey(rhs)));
}

export async function readCodexConfigSnapshot(
  profilesRoot: string,
  liveCodexDirectory: string
): Promise<CodexConfigSnapshot> {
  const profiles = await readProfileNames(profilesRoot);
  const liveFiles = await readPairIfPresent(liveCodexDirectory);
  if (!liveFiles) {
    return { profiles };
  }

  for (const profileName of profiles) {
    const profileDirectory = path.join(profilesRoot, profileName);
    const profileFiles = await readPairIfPresent(profileDirectory);
    if (!profileFiles) {
      continue;
    }

    if (profileFiles.auth === liveFiles.auth && profileFiles.config === liveFiles.config) {
      return {
        profiles,
        activeProfileName: profileName
      };
    }
  }

  return { profiles };
}

export async function switchCodexProfile(
  profilesRoot: string,
  liveCodexDirectory: string,
  profileName: string
): Promise<CodexConfigApplyResult> {
  const normalizedProfileName = validateProfileName(profileName);
  const profileDirectory = path.join(profilesRoot, normalizedProfileName);
  await ensureProfileFilesExist(profileDirectory);
  await fs.mkdir(liveCodexDirectory, { recursive: true });

  await copyFileAtomically(
    path.join(profileDirectory, AUTH_FILE_NAME),
    path.join(liveCodexDirectory, AUTH_FILE_NAME)
  );
  await copyFileAtomically(
    path.join(profileDirectory, CONFIG_FILE_NAME),
    path.join(liveCodexDirectory, CONFIG_FILE_NAME)
  );

  return {
    snapshot: await readCodexConfigSnapshot(profilesRoot, liveCodexDirectory),
    profileName: normalizedProfileName,
    profileDirectory
  };
}

export async function createCodexProfile(options: {
  profilesRoot: string;
  liveCodexDirectory: string;
  templateProfileName: string;
  profileName: string;
  baseURL: string;
  apiKey: string;
}): Promise<CodexConfigApplyResult> {
  const normalizedProfileName = validateProfileName(options.profileName);
  const normalizedTemplateName = validateProfileName(options.templateProfileName);
  const normalizedBaseURL = new URL(options.baseURL.trim()).toString();
  const normalizedAPIKey = options.apiKey.trim();
  if (!normalizedAPIKey) {
    throw new Error("Codex API token cannot be empty");
  }

  const templateDirectory = path.join(options.profilesRoot, normalizedTemplateName);
  await ensureProfileFilesExist(templateDirectory);

  const templateConfigPath = path.join(templateDirectory, CONFIG_FILE_NAME);
  const templateAuthPath = path.join(templateDirectory, AUTH_FILE_NAME);
  const [templateConfig, templateAuth, templateConfigStat, templateAuthStat] = await Promise.all([
    fs.readFile(templateConfigPath, "utf8"),
    fs.readFile(templateAuthPath, "utf8"),
    fs.stat(templateConfigPath),
    fs.stat(templateAuthPath)
  ]);

  const profileDirectory = path.join(options.profilesRoot, normalizedProfileName);
  if (await fileExists(profileDirectory)) {
    throw new Error(`Codex config profile ${normalizedProfileName} already exists`);
  }
  await fs.mkdir(profileDirectory, { recursive: true });

  await writeFileAtomically(
    path.join(profileDirectory, CONFIG_FILE_NAME),
    replaceCodexBaseURL(templateConfig, normalizedBaseURL),
    templateConfigStat.mode
  );
  await writeFileAtomically(
    path.join(profileDirectory, AUTH_FILE_NAME),
    replaceCodexAPIKey(templateAuth, normalizedAPIKey),
    templateAuthStat.mode
  );

  return switchCodexProfile(options.profilesRoot, options.liveCodexDirectory, normalizedProfileName);
}

export async function deleteCodexProfile(
  profilesRoot: string,
  liveCodexDirectory: string,
  profileName: string
): Promise<CodexConfigApplyResult> {
  const normalizedProfileName = validateProfileName(profileName);
  const snapshotBeforeDelete = await readCodexConfigSnapshot(profilesRoot, liveCodexDirectory);
  if (snapshotBeforeDelete.activeProfileName === normalizedProfileName) {
    throw new Error(`Codex config profile ${normalizedProfileName} is currently active and cannot be deleted`);
  }

  const profileDirectory = path.join(profilesRoot, normalizedProfileName);
  if (!(await fileExists(profileDirectory))) {
    throw new Error(`Codex config profile ${normalizedProfileName} not found`);
  }

  await fs.rm(profileDirectory, { recursive: true, force: false });

  return {
    snapshot: await readCodexConfigSnapshot(profilesRoot, liveCodexDirectory),
    profileName: normalizedProfileName,
    profileDirectory
  };
}

export async function restartCodexApp(options?: {
  execFile?: ExecFileLike;
  timeoutMs?: number;
  pollIntervalMs?: number;
}): Promise<void> {
  const execFileImpl = options?.execFile ?? execFileAsync;
  const timeoutMs = options?.timeoutMs ?? 5000;
  const pollIntervalMs = options?.pollIntervalMs ?? 100;

  for (const target of CODEX_RESTART_TARGETS) {
    await killMatchingProcesses(execFileImpl, target);
  }

  await waitForProcessesToExit(execFileImpl, CODEX_RESTART_TARGETS, timeoutMs, pollIntervalMs);
  await execFileImpl("/usr/bin/open", ["-a", "Codex"]);
}

function profileSortKey(profileName: string): string {
  if (profileName === "1000") {
    return "0000";
  }
  if (profileName === "plus") {
    return "0001";
  }
  return `1000-${profileName.toLowerCase()}`;
}

function validateProfileName(profileName: string): string {
  const normalized = profileName.trim();
  if (!normalized) {
    throw new Error("Codex config name cannot be empty");
  }
  if (normalized === "." || normalized === ".." || /[\\/]/.test(normalized)) {
    throw new Error("Codex config name must not contain path separators");
  }
  return normalized;
}

function replaceCodexBaseURL(configText: string, baseURL: string): string {
  const pattern = /(\[model_providers\.codex\][\s\S]*?base_url\s*=\s*")([^"]*)(")/m;
  if (!pattern.test(configText)) {
    throw new Error("Template config.toml is missing [model_providers.codex].base_url");
  }
  return configText.replace(pattern, `$1${baseURL}$3`);
}

function replaceCodexAPIKey(authText: string, apiKey: string): string {
  const parsed = JSON.parse(authText) as Record<string, unknown>;
  parsed.OPENAI_API_KEY = apiKey;
  return `${JSON.stringify(parsed, null, 4)}\n`;
}

async function readProfileNames(profilesRoot: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(profilesRoot, { withFileTypes: true });
    const directories = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    const validNames: string[] = [];

    for (const name of directories) {
      const profileDirectory = path.join(profilesRoot, name);
      if (await hasRequiredProfileFiles(profileDirectory)) {
        validNames.push(name);
      }
    }

    return sortCodexProfileNames(validNames);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function hasRequiredProfileFiles(profileDirectory: string): Promise<boolean> {
  const result = await Promise.all([
    fileExists(path.join(profileDirectory, AUTH_FILE_NAME)),
    fileExists(path.join(profileDirectory, CONFIG_FILE_NAME))
  ]);
  return result.every(Boolean);
}

async function ensureProfileFilesExist(profileDirectory: string): Promise<void> {
  if (!(await hasRequiredProfileFiles(profileDirectory))) {
    throw new Error(`Codex config profile is missing auth.json or config.toml at ${profileDirectory}`);
  }
}

async function readPairIfPresent(profileDirectory: string): Promise<{ auth: string; config: string } | undefined> {
  if (!(await hasRequiredProfileFiles(profileDirectory))) {
    return undefined;
  }

  const [auth, config] = await Promise.all([
    fs.readFile(path.join(profileDirectory, AUTH_FILE_NAME), "utf8"),
    fs.readFile(path.join(profileDirectory, CONFIG_FILE_NAME), "utf8")
  ]);
  return { auth, config };
}

async function copyFileAtomically(sourcePath: string, destinationPath: string): Promise<void> {
  const tempPath = `${destinationPath}.tmp-${process.pid}-${Date.now()}`;
  await fs.copyFile(sourcePath, tempPath);
  await fs.rename(tempPath, destinationPath);
}

async function writeFileAtomically(destinationPath: string, content: string, mode: number): Promise<void> {
  const tempPath = `${destinationPath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tempPath, content, { encoding: "utf8", mode });
  await fs.rename(tempPath, destinationPath);
}

async function fileExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function killMatchingProcesses(execFileImpl: ExecFileLike, target: ProcessMatchTarget): Promise<void> {
  try {
    await execFileImpl(
      "/usr/bin/pkill",
      target.mode === "exact" ? ["-x", target.pattern] : ["-f", target.pattern]
    );
  } catch (error) {
    if (isProcessLookupError(error)) {
      return;
    }
    throw error;
  }
}

async function waitForProcessesToExit(
  execFileImpl: ExecFileLike,
  targets: ProcessMatchTarget[],
  timeoutMs: number,
  pollIntervalMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const runningTargets: string[] = [];
    for (const target of targets) {
      if (await hasMatchingProcess(execFileImpl, target)) {
        runningTargets.push(target.pattern);
      }
    }

    if (runningTargets.length === 0) {
      return;
    }

    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for Codex processes to exit: ${runningTargets.join(", ")}`);
    }

    await delay(pollIntervalMs);
  }
}

async function hasMatchingProcess(execFileImpl: ExecFileLike, target: ProcessMatchTarget): Promise<boolean> {
  try {
    await execFileImpl(
      "/usr/bin/pgrep",
      target.mode === "exact" ? ["-x", target.pattern] : ["-f", target.pattern]
    );
    return true;
  } catch (error) {
    if (isProcessLookupError(error)) {
      return false;
    }
    throw error;
  }
}

function isProcessLookupError(error: unknown): boolean {
  return (error as { code?: number | string }).code === 1;
}
