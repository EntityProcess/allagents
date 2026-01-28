/**
 * Skill name resolver for handling duplicate skill names across plugins
 *
 * Resolution rules:
 * 1. No conflict - Use skill folder name as-is
 * 2. Skill folder name conflicts across plugins - Qualify with plugin name: {plugin}_{skill}
 * 3. Both plugin name AND skill folder name conflict - Add org/UUID prefix: {orgOrUuid}_{plugin}_{skill}
 */

import { getShortId } from './hash.js';
import { extractOrgFromSource } from './source-parser.js';

/**
 * Input skill entry for name resolution
 */
export interface SkillEntry {
  /** Skill folder name (e.g., "my-skill") */
  folderName: string;
  /** Plugin name from plugin.json (e.g., "my-plugin") */
  pluginName: string;
  /** Plugin source - GitHub URL/shorthand or local path */
  pluginSource: string;
}

/**
 * Resolved skill name entry
 */
export interface ResolvedSkillName {
  /** Original skill entry */
  original: SkillEntry;
  /** Resolved unique name for the skill */
  resolvedName: string;
  /** Indicates if the name was modified from the original folder name */
  wasRenamed: boolean;
}

/**
 * Result of skill name resolution
 */
export interface SkillNameResolutionResult {
  /** Array of resolved skill names */
  resolved: ResolvedSkillName[];
  /** Map from original key to resolved name for quick lookup */
  nameMap: Map<string, string>;
}

/**
 * Generate a unique key for a skill entry
 * Used for internal mapping and deduplication
 */
export function getSkillKey(entry: SkillEntry): string {
  return `${entry.pluginSource}::${entry.pluginName}::${entry.folderName}`;
}

/**
 * Get the disambiguator prefix for a plugin source
 * Returns the GitHub org name for GitHub sources, or a 6-char hash for local paths
 */
export function getDisambiguatorPrefix(pluginSource: string): string {
  const org = extractOrgFromSource(pluginSource);
  if (org) {
    return org;
  }
  // For local paths, use a 6-char hash of the source
  return getShortId(pluginSource);
}

/**
 * Resolve skill names to ensure uniqueness across all plugins
 *
 * @param skills - Array of skill entries to resolve
 * @returns Resolution result with resolved names and lookup map
 */
export function resolveSkillNames(
  skills: SkillEntry[],
): SkillNameResolutionResult {
  const resolved: ResolvedSkillName[] = [];
  const nameMap = new Map<string, string>();

  // Step 1: Group skills by folder name
  const byFolderName = new Map<string, SkillEntry[]>();
  for (const skill of skills) {
    const existing = byFolderName.get(skill.folderName) || [];
    existing.push(skill);
    byFolderName.set(skill.folderName, existing);
  }

  // Step 2: Process each group
  for (const [folderName, group] of byFolderName) {
    if (group.length === 1) {
      // No conflict - use folder name as-is
      const skill = group[0];
      if (skill) {
        const resolvedEntry: ResolvedSkillName = {
          original: skill,
          resolvedName: folderName,
          wasRenamed: false,
        };
        resolved.push(resolvedEntry);
        nameMap.set(getSkillKey(skill), folderName);
      }
    } else {
      // Conflict detected - need to qualify names
      // Check if plugin names are unique within this group
      const byPluginName = new Map<string, SkillEntry[]>();
      for (const skill of group) {
        const existing = byPluginName.get(skill.pluginName) || [];
        existing.push(skill);
        byPluginName.set(skill.pluginName, existing);
      }

      // Determine if plugin names are unique
      const hasPluginNameConflict = Array.from(byPluginName.values()).some(
        (pluginGroup) => pluginGroup.length > 1,
      );

      if (!hasPluginNameConflict) {
        // Plugin names are unique - use {plugin}_{skill}
        for (const skill of group) {
          const resolvedName = `${skill.pluginName}_${folderName}`;
          const resolvedEntry: ResolvedSkillName = {
            original: skill,
            resolvedName,
            wasRenamed: true,
          };
          resolved.push(resolvedEntry);
          nameMap.set(getSkillKey(skill), resolvedName);
        }
      } else {
        // Plugin names also conflict - need org/hash prefix
        for (const skill of group) {
          const prefix = getDisambiguatorPrefix(skill.pluginSource);
          const resolvedName = `${prefix}_${skill.pluginName}_${folderName}`;
          const resolvedEntry: ResolvedSkillName = {
            original: skill,
            resolvedName,
            wasRenamed: true,
          };
          resolved.push(resolvedEntry);
          nameMap.set(getSkillKey(skill), resolvedName);
        }
      }
    }
  }

  return { resolved, nameMap };
}

/**
 * Get the resolved name for a specific skill
 *
 * @param result - The resolution result from resolveSkillNames
 * @param skill - The skill entry to look up
 * @returns The resolved name, or undefined if not found
 */
export function getResolvedName(
  result: SkillNameResolutionResult,
  skill: SkillEntry,
): string | undefined {
  return result.nameMap.get(getSkillKey(skill));
}
