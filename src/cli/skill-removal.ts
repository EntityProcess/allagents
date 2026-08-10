import { randomUUID } from 'node:crypto';
import { readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { dump, load } from 'js-yaml';
import { CONFIG_DIR, WORKSPACE_CONFIG_FILE } from '../constants.js';
import type {
  PreparedUnitReconciliation,
  SkillUpdateInstallation,
  SkillUpdateUnit,
} from '../core/skill-update.js';
import { type SkillInfo, getAllSkillsFromPlugins } from '../core/skills.js';
import {
  addUserDisabledSkill,
  getUserWorkspaceConfigPath,
  removeUserEnabledSkill,
  removeUserPlugin,
} from '../core/user-workspace.js';
import {
  addDisabledSkill,
  pruneDisabledSkillsForPlugin,
  pruneEnabledSkillsForPlugin,
  removeEnabledSkill,
  removePlugin,
} from '../core/workspace-modify.js';
import {
  type WorkspaceConfig,
  WorkspaceConfigSchema,
  getPluginSource,
} from '../models/workspace-config.js';

export interface RemoveInstalledSkillOptions {
  targetSkill: Pick<
    SkillInfo,
    'name' | 'pluginName' | 'pluginSource' | 'pluginSkillsMode'
  >;
  isUser: boolean;
  workspacePath: string;
  allSkills?: SkillInfo[];
}

export interface RemoveInstalledSkillResult {
  success: boolean;
  error?: string;
  action?: 'removed-plugin' | 'removed-skill' | 'disabled-skill';
}

export interface CreateSkillUpdateReconcilerOptions {
  workspacePath: string;
  userConfigPath?: string;
  /** Fault-injection seam used to prove multi-file rollback. */
  beforeReplace?: (path: string) => void | Promise<void>;
}

interface ConfigStage {
  path: string;
  original: string;
  tempPath: string;
}

function configPathForInstallation(
  installation: SkillUpdateInstallation,
  options: CreateSkillUpdateReconcilerOptions,
): string {
  return installation.scope === 'project'
    ? join(options.workspacePath, CONFIG_DIR, WORKSPACE_CONFIG_FILE)
    : (options.userConfigPath ?? getUserWorkspaceConfigPath());
}

function parseConfig(content: string, path: string): WorkspaceConfig {
  const raw = load(content);
  const parsed = WorkspaceConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Invalid workspace config at ${path}: ${parsed.error.issues
        .map((issue) => issue.message)
        .join('; ')}`,
    );
  }
  // Validate with the schema, but transform the raw object so Zod defaults and
  // client shorthand normalization do not rewrite unrelated user config.
  return raw as WorkspaceConfig;
}

function removePluginEntry(config: WorkspaceConfig, index: number): void {
  const entry = config.plugins[index];
  if (!entry) throw new Error(`Plugin entry at index ${index} not found`);
  const source = getPluginSource(entry);
  config.plugins.splice(index, 1);
  pruneDisabledSkillsForPlugin(config, source);
  pruneEnabledSkillsForPlugin(config, source);
}

function selectorForImpact(
  allowlist: string[],
  impact: SkillUpdateUnit['deleted'][number],
): string | undefined {
  if (impact.selector && allowlist.includes(impact.selector)) {
    return impact.selector;
  }
  if (allowlist.includes(impact.subpath)) return impact.subpath;
  // Older bare-name configs did not retain a qualified selector. Only use the
  // leaf fallback when there is no competing qualified selector in the entry.
  if (
    allowlist.includes(impact.name) &&
    !allowlist.some(
      (selector) =>
        selector !== impact.name && selector.split('/').at(-1) === impact.name,
    )
  ) {
    return impact.name;
  }
  return undefined;
}

function transformConfig(
  original: string,
  path: string,
  installations: SkillUpdateInstallation[],
  unit: SkillUpdateUnit,
): string {
  const config = parseConfig(original, path);
  const removedInstallationIds = new Set(unit.removedInstallationIds ?? []);
  const removeIndexes = new Set<number>();

  for (const installation of installations) {
    const entry = config.plugins[installation.configIndex];
    if (!entry) {
      throw new Error(
        `Plugin entry ${installation.configIndex} for ${installation.rawSource} no longer exists in ${path}`,
      );
    }
    if (getPluginSource(entry) !== installation.rawSource) {
      throw new Error(
        `Plugin entry ${installation.configIndex} changed in ${path}; expected ${installation.rawSource}`,
      );
    }

    if (removedInstallationIds.has(installation.id)) {
      removeIndexes.add(installation.configIndex);
      continue;
    }

    const deleted = unit.deleted.filter(
      (impact) => impact.installationId === installation.id,
    );
    if (deleted.length === 0 || typeof entry === 'string') continue;
    if (!Array.isArray(entry.skills)) {
      // Implicit and blocklist installs are purged by the confirmed offline
      // sync. Recording an exclusion for content that no longer exists would
      // leave stale user configuration behind.
      continue;
    }

    const selectors = new Set<string>();
    for (const impact of deleted) {
      const selector = selectorForImpact(entry.skills, impact);
      if (!selector) {
        throw new Error(
          `Configured selector for ${installation.pluginName}:${impact.subpath} no longer matches ${path}`,
        );
      }
      selectors.add(selector);
    }
    entry.skills = entry.skills.filter((selector) => !selectors.has(selector));
    if (entry.skills.length === 0 && installation.standaloneSkillSource) {
      removeIndexes.add(installation.configIndex);
    }
  }

  for (const index of [...removeIndexes].sort((left, right) => right - left)) {
    removePluginEntry(config, index);
  }

  const replacement = dump(config, { lineWidth: -1 });
  parseConfig(replacement, path);
  return replacement;
}

function tempPathFor(path: string, label: string): string {
  return join(
    dirname(path),
    `.${basename(path)}.allagents-${label}-${randomUUID()}.tmp`,
  );
}

async function writeTemp(
  path: string,
  content: string,
  mode: number,
): Promise<void> {
  await writeFile(path, content, {
    encoding: 'utf-8',
    flag: 'wx',
    mode,
  });
}

async function cleanupTemp(path: string): Promise<void> {
  await unlink(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

/**
 * Build the config side of a physical skill-update transaction. Preparation
 * validates and stages every affected file without changing live config. The
 * returned commit replaces files atomically one at a time and restores every
 * earlier replacement if a later one fails.
 */
export function createSkillUpdateReconciler(
  options: CreateSkillUpdateReconcilerOptions,
): (unit: SkillUpdateUnit) => Promise<PreparedUnitReconciliation> {
  return async (unit: SkillUpdateUnit) => {
    const byPath = new Map<string, SkillUpdateInstallation[]>();
    for (const installation of unit.installations) {
      if (
        !unit.deleted.some(
          (impact) => impact.installationId === installation.id,
        ) &&
        !(unit.removedInstallationIds ?? []).includes(installation.id)
      ) {
        continue;
      }
      const path = configPathForInstallation(installation, options);
      const entries = byPath.get(path) ?? [];
      entries.push(installation);
      byPath.set(path, entries);
    }

    const stages: ConfigStage[] = [];
    try {
      for (const [path, installations] of byPath) {
        const original = await readFile(path, 'utf-8');
        const replacement = transformConfig(
          original,
          path,
          installations,
          unit,
        );
        if (replacement === original) continue;
        const tempPath = tempPathFor(path, 'next');
        const currentStat = await stat(path);
        await writeTemp(tempPath, replacement, currentStat.mode);
        stages.push({ path, original, tempPath });
      }
    } catch (error) {
      await Promise.all(stages.map((stage) => cleanupTemp(stage.tempPath)));
      throw error;
    }

    let state: 'prepared' | 'committed' | 'rolled-back' = 'prepared';
    const committed: ConfigStage[] = [];

    const restore = async (stage: ConfigStage): Promise<void> => {
      const current = await readFile(stage.path, 'utf-8');
      if (current === stage.original) return;
      const restorePath = tempPathFor(stage.path, 'rollback');
      const currentStat = await stat(stage.path);
      try {
        await writeTemp(restorePath, stage.original, currentStat.mode);
        await rename(restorePath, stage.path);
      } finally {
        await cleanupTemp(restorePath);
      }
    };

    const rollback = async (): Promise<void> => {
      if (state === 'rolled-back') return;
      for (const stage of [...committed].reverse()) await restore(stage);
      await Promise.all(stages.map((stage) => cleanupTemp(stage.tempPath)));
      state = 'rolled-back';
    };

    return {
      commit: async () => {
        if (state !== 'prepared') {
          throw new Error(`Config reconciliation is already ${state}`);
        }
        // Fail before the first rename if any config changed since preflight.
        for (const stage of stages) {
          if ((await readFile(stage.path, 'utf-8')) !== stage.original) {
            await rollback();
            throw new Error(
              `Workspace config changed during update: ${stage.path}`,
            );
          }
        }
        try {
          for (const stage of stages) {
            await options.beforeReplace?.(stage.path);
            await rename(stage.tempPath, stage.path);
            committed.push(stage);
          }
          state = 'committed';
        } catch (error) {
          await rollback();
          throw error;
        }
      },
      rollback,
    };
  };
}

export async function removeInstalledSkill(
  options: RemoveInstalledSkillOptions,
): Promise<RemoveInstalledSkillResult> {
  const { targetSkill, isUser, workspacePath } = options;
  const allSkills =
    options.allSkills ?? (await getAllSkillsFromPlugins(workspacePath));
  const pluginSkills = allSkills.filter(
    (skill) => skill.pluginSource === targetSkill.pluginSource,
  );
  const remainingEnabledSkills = pluginSkills.filter(
    (skill) => !skill.disabled && skill.name !== targetSkill.name,
  );

  if (remainingEnabledSkills.length === 0) {
    const result = isUser
      ? await removeUserPlugin(targetSkill.pluginSource)
      : await removePlugin(targetSkill.pluginSource, workspacePath);

    return result.success
      ? { success: true, action: 'removed-plugin' }
      : { success: false, error: result.error ?? 'Unknown error' };
  }

  const skillKey = `${targetSkill.pluginName}:${targetSkill.name}`;
  const result =
    targetSkill.pluginSkillsMode === 'allowlist'
      ? isUser
        ? await removeUserEnabledSkill(skillKey)
        : await removeEnabledSkill(skillKey, workspacePath)
      : isUser
        ? await addUserDisabledSkill(skillKey)
        : await addDisabledSkill(skillKey, workspacePath);

  if (!result.success) {
    return { success: false, error: result.error ?? 'Unknown error' };
  }

  return {
    success: true,
    action:
      targetSkill.pluginSkillsMode === 'allowlist'
        ? 'removed-skill'
        : 'disabled-skill',
  };
}
