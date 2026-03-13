import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { load } from 'js-yaml';
import { CONFIG_DIR, WORKSPACE_CONFIG_FILE } from '../constants.js';
import { getPluginSource, type WorkspaceConfig } from '../models/workspace-config.js';
import { fetchPlugin, getPluginName } from './plugin.js';
import { isGitHubUrl, parseGitHubUrl } from '../utils/plugin-path.js';
import { isPluginSpec, resolvePluginSpecWithAutoRegister } from './marketplace.js';

/**
 * Information about a skill from an installed plugin
 */
export interface SkillInfo {
  /** Skill folder name */
  name: string;
  /** Plugin name this skill belongs to */
  pluginName: string;
  /** Plugin source reference */
  pluginSource: string;
  /** Path to the skill directory */
  path: string;
  /** Whether the skill is disabled */
  disabled: boolean;
}

/**
 * Result of resolving a plugin source
 */
interface ResolvedPlugin {
  path: string;
  /** Plugin name from marketplace manifest (overrides directory basename) */
  pluginName?: string | undefined;
}

/**
 * Resolve a plugin source to its local path and optional manifest-derived name
 */
async function resolvePluginPath(
  pluginSource: string,
  workspacePath: string,
): Promise<ResolvedPlugin | null> {
  if (isPluginSpec(pluginSource)) {
    const resolved = await resolvePluginSpecWithAutoRegister(pluginSource, {
      offline: true,
    });
    if (!resolved.success || !resolved.path) return null;
    return {
      path: resolved.path,
      pluginName: resolved.pluginName,
    };
  }

  if (isGitHubUrl(pluginSource)) {
    const parsed = parseGitHubUrl(pluginSource);
    const result = await fetchPlugin(pluginSource, {
      offline: true,
      ...(parsed?.branch && { branch: parsed.branch }),
    });
    if (!result.success) return null;
    const path = parsed?.subpath
      ? join(result.cachePath, parsed.subpath)
      : result.cachePath;
    return { path };
  }

  // Local path
  const resolved = resolve(workspacePath, pluginSource);
  return existsSync(resolved) ? { path: resolved } : null;
}

/**
 * Get all skills from all installed plugins
 * @param workspacePath - Path to workspace directory
 * @returns Array of skill information
 */
export async function getAllSkillsFromPlugins(
  workspacePath: string = process.cwd(),
): Promise<SkillInfo[]> {
  const configPath = join(workspacePath, CONFIG_DIR, WORKSPACE_CONFIG_FILE);

  if (!existsSync(configPath)) {
    return [];
  }

  const content = await readFile(configPath, 'utf-8');
  const config = load(content) as WorkspaceConfig;
  const disabledSkills = new Set(config.disabledSkills ?? []);
  const enabledSkills = config.enabledSkills ? new Set(config.enabledSkills) : null;
  const skills: SkillInfo[] = [];

  for (const pluginEntry of config.plugins) {
    const pluginSource = getPluginSource(pluginEntry);
    const resolved = await resolvePluginPath(pluginSource, workspacePath);
    if (!resolved) continue;

    const pluginPath = resolved.path;
    const pluginName = resolved.pluginName ?? getPluginName(pluginPath);
    const skillsDir = join(pluginPath, 'skills');

    // Only apply enabledSkills to plugins that actually have entries in the set
    const hasEnabledEntries = enabledSkills &&
      [...enabledSkills].some((s) => s.startsWith(`${pluginName}:`));

    let skillEntries: { name: string; skillPath: string }[];

    if (existsSync(skillsDir)) {
      // Standard layout: plugin/skills/<skill-name>/
      const entries = await readdir(skillsDir, { withFileTypes: true });
      skillEntries = entries
        .filter((e) => e.isDirectory())
        .map((e) => ({ name: e.name, skillPath: join(skillsDir, e.name) }));
    } else {
      // Flat layout: plugin/<skill-name>/SKILL.md
      const entries = await readdir(pluginPath, { withFileTypes: true });
      const flatSkills: { name: string; skillPath: string }[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillMdPath = join(pluginPath, entry.name, 'SKILL.md');
        if (existsSync(skillMdPath)) {
          flatSkills.push({ name: entry.name, skillPath: join(pluginPath, entry.name) });
        }
      }
      skillEntries = flatSkills;
    }

    for (const { name, skillPath } of skillEntries) {
      const skillKey = `${pluginName}:${name}`;
      const isDisabled = hasEnabledEntries
        ? !enabledSkills?.has(skillKey)
        : disabledSkills.has(skillKey);

      skills.push({
        name,
        pluginName,
        pluginSource,
        path: skillPath,
        disabled: isDisabled,
      });
    }
  }

  return skills;
}

/**
 * Find a skill by name across all plugins
 * @param skillName - The skill name to find
 * @param workspacePath - Path to workspace directory
 * @returns Matching skills (may be multiple if name exists in multiple plugins)
 */
export async function findSkillByName(
  skillName: string,
  workspacePath: string = process.cwd(),
): Promise<SkillInfo[]> {
  const allSkills = await getAllSkillsFromPlugins(workspacePath);
  return allSkills.filter((s) => s.name === skillName);
}
