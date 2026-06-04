import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "./config.js";

const execFileAsync = promisify(execFile);

async function commandVersion(command: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args);
    const combined = `${stdout}\n${stderr}`.trim();
    return combined.split("\n").find(Boolean);
  } catch {
    return undefined;
  }
}

async function commandSucceeds(command: string, args: string[]): Promise<boolean> {
  try {
    await execFileAsync(command, args);
    return true;
  } catch {
    return false;
  }
}

export async function detectCapabilities(): Promise<string[]> {
  const capabilities = ["git_guard"];

  if (await commandVersion("codex", ["-V"])) {
    capabilities.push("codex_cli", "codex_app_server");
  }

  if (await commandVersion("xcodebuild", ["-version"])) {
    capabilities.push("xcodebuild");
  }

  if (await commandVersion("gh", ["--version"]) && await commandSucceeds("gh", ["auth", "status"])) {
    capabilities.push("github_pr");
  }

  if (config.gitlab.token.trim().length > 0) {
    capabilities.push("gitlab_mr");
  }

  return capabilities;
}

export async function detectVersions(): Promise<{ runnerVersion: string; codexVersion?: string; xcodeVersion?: string; hostname: string }> {
  const codexVersion = await commandVersion("codex", ["-V"]);
  const xcodeVersion = await commandVersion("xcodebuild", ["-version"]);

  return {
    runnerVersion: config.runnerVersion,
    codexVersion,
    xcodeVersion,
    hostname: os.hostname()
  };
}
