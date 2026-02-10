import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { load } from 'js-yaml';
import { CONFIG_DIR, WORKSPACE_CONFIG_FILE } from '../constants.js';
import type { WorkspaceConfig } from '../models/workspace-config.js';
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
 * Resolve a plugin source to its local path
 */
async function resolvePluginPath(
  pluginSource: string,
  workspacePath: string,
): Promise<string | null> {
  if (isPluginSpec(pluginSource)) {
    const resolved = await resolvePluginSpecWithAutoRegister(pluginSource, {
      offline: true,
    });
    return resolved.success ? resolved.path ?? null : null;
  }

  if (isGitHubUrl(pluginSource)) {
    const parsed = parseGitHubUrl(pluginSource);
    const result = await fetchPlugin(pluginSource, {
      offline: true,
      ...(parsed?.branch && { branch: parsed.branch }),
    });
    if (!result.success) return null;
    return parsed?.subpath
      ? join(result.cachePath, parsed.subpath)
      : result.cachePath;
  }

  // Local path
  const resolved = resolve(workspacePath, pluginSource);
  return existsSync(resolved) ? resolved : null;
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
  const skills: SkillInfo[] = [];

  for (const pluginSource of config.plugins) {
    const pluginPath = await resolvePluginPath(pluginSource, workspacePath);
    if (!pluginPath) continue;

    const pluginName = await getPluginName(pluginPath);
    const skillsDir = join(pluginPath, 'skills');

    if (!existsSync(skillsDir)) continue;

    const entries = await readdir(skillsDir, { withFileTypes: true });
    const skillDirs = entries.filter((e) => e.isDirectory());

    for (const entry of skillDirs) {
      const skillKey = `${pluginName}:${entry.name}`;
      skills.push({
        name: entry.name,
        pluginName,
        pluginSource,
        path: join(skillsDir, entry.name),
        disabled: disabledSkills.has(skillKey),
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
