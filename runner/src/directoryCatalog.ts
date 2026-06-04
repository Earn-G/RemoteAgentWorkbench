import fs from "node:fs/promises";
import path from "node:path";
import type { ControlPlaneClient } from "./controlPlaneClient.js";
import {
  createDirectoryCatalogSeed,
  parseDirectoryCatalog,
  type LocalDirectoryPresetDefinition
} from "./catalogConfig.js";

export type { LocalDirectoryPresetDefinition } from "./catalogConfig.js";

export class DirectoryCatalog {
  private lastSerialized = "";

  constructor(private readonly filePath: string) {}

  async loadPresets(): Promise<LocalDirectoryPresetDefinition[]> {
    await this.ensureSeeded();

    const raw = await fs.readFile(this.filePath, "utf8");
    return parseDirectoryCatalog(JSON.parse(raw) as unknown);
  }

  async syncIfChanged(client: ControlPlaneClient, runnerId: string, options?: { force?: boolean }): Promise<boolean> {
    const presets = await this.loadPresets();
    const serialized = JSON.stringify(presets);
    if (!options?.force && serialized === this.lastSerialized) {
      return false;
    }

    await client.syncDirectoryPresets(runnerId, { presets });
    this.lastSerialized = serialized;
    return true;
  }

  async ensureSeeded(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });

    try {
      await fs.access(this.filePath);
      return;
    } catch {
      await fs.writeFile(this.filePath, `${JSON.stringify(createDirectoryCatalogSeed(), null, 2)}\n`, "utf8");
    }
  }
}
