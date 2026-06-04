import os from "node:os";
import path from "node:path";
import type { DeliveryMode } from "./models.js";

export interface LocalProjectDefinition {
  id: string;
  name: string;
  repo: string;
  baseBranch: string;
  deliveryMode: DeliveryMode;
  autoPush: boolean;
  defaultTaskTitle: string;
  defaultPrompt: string;
  isFeatured: boolean;
  reportNamespace?: string;
}

export interface LocalDirectoryPresetDefinition {
  id: string;
  label: string;
  rootPath: string;
}

function expandHomeDirectory(input: string): string {
  const trimmed = input.trim();
  if (trimmed === "~") {
    return os.homedir();
  }
  if (trimmed.startsWith("~/")) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return trimmed;
}

function normalizeOptionalLocalPath(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.startsWith("/") || trimmed === "~" || trimmed.startsWith("~/") || /^[A-Za-z]:[\\/]/.test(trimmed)) {
    return path.resolve(expandHomeDirectory(trimmed));
  }
  return trimmed;
}

function normalizeDeliveryMode(value: unknown): DeliveryMode {
  return value === "direct_commit" ? "direct_commit" : "review_required";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeReportNamespace(value: unknown): string | undefined {
  if (!isNonEmptyString(value)) {
    return undefined;
  }

  const normalized = value
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join("/");

  return normalized.length > 0 ? normalized : undefined;
}

function normalizeProjectDefinition(value: unknown): LocalProjectDefinition | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const candidate = value as Record<string, unknown>;
  const requiredFields = ["id", "name", "repo", "baseBranch", "defaultTaskTitle", "defaultPrompt"];
  if (!requiredFields.every((field) => isNonEmptyString(candidate[field]))) {
    return undefined;
  }

  const repo = normalizeOptionalLocalPath(String(candidate.repo));
  if (!repo) {
    return undefined;
  }

  return {
    id: String(candidate.id).trim(),
    name: String(candidate.name).trim(),
    repo,
    baseBranch: String(candidate.baseBranch).trim(),
    deliveryMode: normalizeDeliveryMode(candidate.deliveryMode),
    autoPush: candidate.autoPush !== false,
    defaultTaskTitle: String(candidate.defaultTaskTitle).trim(),
    defaultPrompt: String(candidate.defaultPrompt).trim(),
    isFeatured: candidate.isFeatured === true,
    reportNamespace: normalizeReportNamespace(candidate.reportNamespace)
  };
}

function normalizeDirectoryPresetDefinition(value: unknown): LocalDirectoryPresetDefinition | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const candidate = value as Record<string, unknown>;
  if (!["id", "label", "rootPath"].every((field) => isNonEmptyString(candidate[field]))) {
    return undefined;
  }

  const rootPath = normalizeOptionalLocalPath(String(candidate.rootPath));
  if (!rootPath || !path.isAbsolute(rootPath)) {
    return undefined;
  }

  return {
    id: String(candidate.id).trim(),
    label: String(candidate.label).trim(),
    rootPath
  };
}

export function parseProjectCatalog(input: unknown): LocalProjectDefinition[] {
  if (!Array.isArray(input)) {
    throw new Error("Project catalog must be a JSON array");
  }

  return input.flatMap((entry) => {
    const normalized = normalizeProjectDefinition(entry);
    if (normalized) {
      return [normalized];
    }

    const id = typeof entry === "object" && entry && "id" in entry ? String((entry as { id?: unknown }).id ?? "") : "<unknown>";
    console.warn(`[runner] skipping project catalog entry ${id} because required fields are missing or invalid`);
    return [];
  });
}

export function parseDirectoryCatalog(input: unknown): LocalDirectoryPresetDefinition[] {
  if (!Array.isArray(input)) {
    throw new Error("Directory catalog must be a JSON array");
  }

  return input.flatMap((entry) => {
    const normalized = normalizeDirectoryPresetDefinition(entry);
    if (normalized) {
      return [normalized];
    }

    const id = typeof entry === "object" && entry && "id" in entry ? String((entry as { id?: unknown }).id ?? "") : "<unknown>";
    console.warn(
      `[runner] skipping directory preset ${id} because rootPath must be absolute or start with ~/`
    );
    return [];
  });
}

export function createProjectCatalogSeed(): LocalProjectDefinition[] {
  return [];
}

export function createDirectoryCatalogSeed(): LocalDirectoryPresetDefinition[] {
  return [];
}

export function createProjectCatalogExample(homeDirectory = os.homedir()): LocalProjectDefinition[] {
  return [
    {
      id: "sample_project",
      name: "Sample Project",
      repo: path.join(homeDirectory, "Code", "sample-project"),
      baseBranch: "main",
      deliveryMode: "review_required",
      autoPush: true,
      defaultTaskTitle: "Continue sample project task",
      defaultPrompt: "Implement the requested change, run the most relevant checks, and follow the selected Git workflow.",
      isFeatured: true,
      reportNamespace: "samples/sample-project"
    }
  ];
}

export function createDirectoryCatalogExample(homeDirectory = os.homedir()): LocalDirectoryPresetDefinition[] {
  return [
    {
      id: "code",
      label: "Code",
      rootPath: path.join(homeDirectory, "Code")
    }
  ];
}
