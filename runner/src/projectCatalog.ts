import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { DeliveryMode } from "./models.js";
import type { ControlPlaneClient } from "./controlPlaneClient.js";
import {
  createProjectCatalogSeed,
  parseProjectCatalog,
  type LocalProjectDefinition
} from "./catalogConfig.js";

export type { LocalProjectDefinition } from "./catalogConfig.js";

function trimmed(value?: string): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "folder";
}

function projectIdForDirectory(absolutePath: string, name: string): string {
  const hash = createHash("sha1").update(path.resolve(absolutePath)).digest("hex").slice(0, 8);
  return `folder_${slugify(name)}_${hash}`;
}

export interface DirectoryProjectInput {
  absolutePath: string;
  name?: string;
  baseBranch?: string;
  deliveryMode?: DeliveryMode;
  autoPush?: boolean;
  defaultTaskTitle?: string;
  defaultPrompt?: string;
}

export class ProjectCatalog {
  private lastSerialized = "";

  constructor(private readonly filePath: string) {}

  async loadProjects(): Promise<LocalProjectDefinition[]> {
    await this.ensureSeeded();

    const raw = await fs.readFile(this.filePath, "utf8");
    return parseProjectCatalog(JSON.parse(raw) as unknown);
  }

  async upsertDirectoryProject(input: DirectoryProjectInput): Promise<LocalProjectDefinition> {
    await this.ensureSeeded();
    const absolutePath = path.resolve(input.absolutePath);
    const displayName = trimmed(input.name) ?? (path.basename(absolutePath) || "Local Folder");
    const projects = await this.loadProjects();
    const existingIndex = projects.findIndex((project) => project.repo === absolutePath);
    const existing = existingIndex >= 0 ? projects[existingIndex] : undefined;
    const project: LocalProjectDefinition = {
      id: existing?.id ?? projectIdForDirectory(absolutePath, displayName),
      name: trimmed(input.name) ?? existing?.name ?? displayName,
      repo: absolutePath,
      baseBranch: trimmed(input.baseBranch) ?? existing?.baseBranch ?? "main",
      deliveryMode: input.deliveryMode ?? existing?.deliveryMode ?? "direct_commit",
      autoPush: input.autoPush ?? existing?.autoPush ?? false,
      defaultTaskTitle: trimmed(input.defaultTaskTitle) ?? existing?.defaultTaskTitle ?? `Work on ${displayName}`,
      defaultPrompt: trimmed(input.defaultPrompt) ?? existing?.defaultPrompt ?? `Describe the outcome you want in ${displayName}. Mention files to create or change and checks to run.`,
      isFeatured: existing?.isFeatured ?? true,
      reportNamespace: existing?.reportNamespace ?? `folders/${slugify(displayName)}`
    };

    if (existingIndex >= 0) {
      projects[existingIndex] = project;
    } else {
      projects.push(project);
    }

    await fs.writeFile(this.filePath, `${JSON.stringify(projects, null, 2)}\n`, "utf8");
    this.lastSerialized = "";
    return project;
  }

  async syncIfChanged(client: ControlPlaneClient, runnerId: string, options?: { force?: boolean }): Promise<boolean> {
    const projects = await this.loadProjects();
    const serialized = JSON.stringify(projects);
    if (!options?.force && serialized === this.lastSerialized) {
      return false;
    }

    await client.syncProjects(runnerId, { projects });
    this.lastSerialized = serialized;
    return true;
  }

  async ensureSeeded(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });

    try {
      await fs.access(this.filePath);
      return;
    } catch {
      await fs.writeFile(this.filePath, `${JSON.stringify(createProjectCatalogSeed(), null, 2)}\n`, "utf8");
    }
  }

  async findProject(options: { projectId?: string; repo?: string }): Promise<LocalProjectDefinition | undefined> {
    const projects = await this.loadProjects();
    if (options.projectId) {
      const byId = projects.find((project) => project.id === options.projectId);
      if (byId) {
        return byId;
      }
    }

    if (options.repo) {
      return projects.find((project) => project.repo === options.repo);
    }

    return undefined;
  }

  async resolveReportNamespace(options: { projectId?: string; projectName?: string; repo?: string }): Promise<string> {
    const project = await this.findProject(options);
    if (project?.reportNamespace) {
      return project.reportNamespace;
    }

    if (project?.id) {
      return project.id;
    }

    const fallback = options.projectId?.trim() || options.projectName?.trim() || "unscoped";
    return fallback
      .toLowerCase()
      .replace(/[^a-z0-9/_-]+/g, "-")
      .replace(/\/{2,}/g, "/")
      .replace(/^-+|-+$/g, "") || "unscoped";
  }
}
