import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import chalk from 'chalk';
import { command, positional, option, flag, string, optional } from 'cmd-ts';
import { syncWorkspace, syncUserWorkspace } from '../../core/sync.js';
import {
  addDisabledSkill,
  removeDisabledSkill,
  removeEnabledSkill,
  addEnabledSkill,
  addPlugin,
  setPluginSkillsMode,
} from '../../core/workspace-modify.js';
import {
  addUserDisabledSkill,
  removeUserDisabledSkill,
  removeUserEnabledSkill,
  addUserEnabledSkill,
  isUserConfigPath,
  addUserPlugin,
  setUserPluginSkillsMode,
} from '../../core/user-workspace.js';
import { getAllSkillsFromPlugins, findSkillByName, discoverSkillNames } from '../../core/skills.js';
import { isJsonMode, jsonOutput } from '../json-output.js';
import { buildDescription, conciseSubcommands } from '../help.js';
import {
  skillsListMeta,
  skillsRemoveMeta,
  skillsAddMeta,
  skillsSearchMeta,
} from '../metadata/plugin-skills.js';
import {
  searchSkills,
  SkillSearchError,
  type SkillSearchOptions,
} from '../../core/skill-search.js';
import { getHomeDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE } from '../../constants.js';
import { isGitHubUrl, parseGitHubUrl, stripGitRef } from '../../utils/plugin-path.js';
import { fetchPlugin, getPluginName, seedFetchCache } from '../../core/plugin.js';
import {
  computeSkillFolderHash,
  upsertSyncStateSource,
  upsertSyncStateSkill,
} from '../../core/sync-state.js';
import { parseSkillMetadata } from '../../validators/skill.js';
import {
  addMarketplace,
  findMarketplace,
  listMarketplacePlugins,
  updateMarketplace,
} from '../../core/marketplace.js';
import { parseMarketplaceManifest, resolvePluginSourcePath } from '../../utils/marketplace-manifest-parser.js';
import { formatSyncHeader, formatSyncSummary } from '../format-sync.js';
import type { SyncResult } from '../../core/sync.js';

/**
 * Check if a directory has a project-level .allagents config
 */
function hasProjectConfig(dir: string): boolean {
  return existsSync(join(dir, CONFIG_DIR, WORKSPACE_CONFIG_FILE));
}

/**
 * Determine effective scope when no --scope flag is provided.
 * Defaults to user scope unless cwd has a project config.
 */
function resolveScope(cwd: string): 'user' | 'project' {
  if (isUserConfigPath(cwd)) return 'user';
  if (hasProjectConfig(cwd)) return 'project';
  return 'user';
}

/**
 * Resolve the on-disk skill folder for a given plugin cache path and skill name.
 * Mirrors `resolveSkillMdPath` further down but returns the *folder* containing
 * the SKILL.md rather than the file itself.
 */
function resolveSkillFolder(pluginPath: string, skillName: string): string | null {
  const candidates = [
    join(pluginPath, 'skills', skillName),
    join(pluginPath, skillName),
    pluginPath,
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'SKILL.md'))) return candidate;
  }
  return null;
}

/**
 * Record per-source provenance (resolvedRef + resolvedSha + optional pin) and
 * per-skill content hash + timestamps into sync-state for the given install.
 *
 * The source key is the spec with any `@<ref>` suffix stripped so all installs
 * of `owner/repo` map to one entry regardless of pin.
 *
 * No-op for non-GitHub sources (local paths, marketplace shorthand) since we
 * can't resolve a SHA from them.
 */
async function recordContentProvenance(opts: {
  from: string;
  skills: string[];
  pinnedRef?: string | undefined;
  workspacePath: string;
  isUser: boolean;
}): Promise<void> {
  const { from, skills, pinnedRef, workspacePath, isUser } = opts;
  if (!isGitHubUrl(from)) return;
  const parsed = parseGitHubUrl(from);
  if (!parsed) return;

  const fetchResult = await fetchPlugin(from, {
    ...(parsed.branch && { branch: parsed.branch }),
  });
  if (!fetchResult.success || !fetchResult.resolvedSha) return;

  const stateRoot = isUser ? getHomeDir() : workspacePath;
  const key = stripGitRef(`${parsed.owner}/${parsed.repo}`);

  await upsertSyncStateSource(stateRoot, key, {
    pluginSpec: key,
    resolvedRef: fetchResult.resolvedRef ?? parsed.branch ?? 'HEAD',
    resolvedSha: fetchResult.resolvedSha,
    ...(pinnedRef && { pinnedRef }),
  });

  // Resolve the plugin root inside the cached repo (handle subpath layouts).
  const pluginRoot = parsed.subpath
    ? join(fetchResult.cachePath, parsed.subpath)
    : fetchResult.cachePath;

  const now = new Date().toISOString();
  for (const skillName of skills) {
    const folder = resolveSkillFolder(pluginRoot, skillName);
    if (!folder) continue;
    const hash = await computeSkillFolderHash(folder);
    if (!hash) continue;
    await upsertSyncStateSkill(stateRoot, key, skillName, {
      contentHash: hash,
      installedAt: now,
      updatedAt: now,
    });
  }
}

/**
 * Extract the inline `@<ref>` suffix from a plugin source spec, if present.
 * Only matches owner/repo-style sources (must have a slash before the `@`),
 * so `plugin@marketplace` returns undefined.
 */
function extractInlineRef(spec: string): string | undefined {
  const slashIdx = spec.indexOf('/');
  if (slashIdx === -1) return undefined;
  const atIdx = spec.indexOf('@', slashIdx);
  if (atIdx === -1) return undefined;
  const ref = spec.slice(atIdx + 1);
  // If the @ref contains another slash, it's the subpath portion; the ref is
  // the chunk between @ and the next slash.
  const nextSlash = ref.indexOf('/');
  const cleanRef = nextSlash === -1 ? ref : ref.slice(0, nextSlash);
  return cleanRef.length > 0 ? cleanRef : undefined;
}

/**
 * If the skill argument is a GitHub URL, extract the skill name and return
 * it along with the URL as the plugin source. Returns null if not a URL.
 *
 * With subpath: skill name = last path segment
 * Without subpath: skill name = repo name (caller should use resolveSkillNameFromRepo to check frontmatter)
 */
export function resolveSkillFromUrl(
  skill: string,
): { skill: string; from: string; parsed: ReturnType<typeof parseGitHubUrl> } | null {
  if (!isGitHubUrl(skill)) return null;

  const parsed = parseGitHubUrl(skill);
  if (!parsed) return null;

  if (parsed.subpath) {
    const segments = parsed.subpath.split('/').filter(Boolean);
    const name = segments[segments.length - 1];
    if (!name) return null;
    return { skill: name, from: skill, parsed };
  }

  return { skill: parsed.repo, from: skill, parsed };
}

/**
 * For a no-subpath GitHub URL, fetch the repo and read SKILL.md frontmatter
 * to get the real skill name. Falls back to the provided default name.
 */
export async function resolveSkillNameFromRepo(
  url: string,
  parsed: NonNullable<ReturnType<typeof parseGitHubUrl>>,
  fallbackName: string,
  fetchFn: typeof fetchPlugin = fetchPlugin,
): Promise<string> {
  const fetchResult = await fetchFn(url, {
    ...(parsed.branch && { branch: parsed.branch }),
  });
  if (!fetchResult.success) return fallbackName;

  try {
    const skillMd = await readFile(join(fetchResult.cachePath, 'SKILL.md'), 'utf-8');
    const metadata = parseSkillMetadata(skillMd);
    return metadata?.name ?? fallbackName;
  } catch {
    return fallbackName;
  }
}

/**
 * Group skills by plugin for display
 */
function groupSkillsByPlugin(
  skills: Array<{ name: string; pluginName: string; pluginSource: string; disabled: boolean }>,
): Map<string, { source: string; skills: Array<{ name: string; disabled: boolean }> }> {
  const grouped = new Map<string, { source: string; skills: Array<{ name: string; disabled: boolean }> }>();

  for (const skill of skills) {
    const existing = grouped.get(skill.pluginName);
    if (existing) {
      existing.skills.push({ name: skill.name, disabled: skill.disabled });
    } else {
      grouped.set(skill.pluginName, {
        source: skill.pluginSource,
        skills: [{ name: skill.name, disabled: skill.disabled }],
      });
    }
  }

  return grouped;
}

// =============================================================================
// plugin skills list
// =============================================================================

const listCmd = command({
  name: 'list',
  description: buildDescription(skillsListMeta),
  args: {
    scope: option({
      type: optional(string),
      long: 'scope',
      short: 's',
      description: 'Scope: "project" (default) or "user"',
    }),
  },
  handler: async ({ scope }) => {
    try {
      const cwd = process.cwd();
      const inProjectDir = !isUserConfigPath(cwd) && hasProjectConfig(cwd);

      // Resolve which scopes to display
      const showUser = scope !== 'project';
      const showProject = scope === 'project' || (!scope && inProjectDir);

      const userSkills = showUser ? await getAllSkillsFromPlugins(getHomeDir()) : [];
      const projectSkills = showProject ? await getAllSkillsFromPlugins(cwd) : [];

      // For dedup: if same plugin:skill exists in both, only show in user
      const userKeys = new Set(userSkills.map((s) => `${s.pluginName}:${s.name}`));
      const dedupedProjectSkills = projectSkills.filter(
        (s) => !userKeys.has(`${s.pluginName}:${s.name}`),
      );

      if (isJsonMode()) {
        const effectiveScope = scope === 'user' ? 'user' : scope === 'project' ? 'project' : 'all';
        const allSkills = [...userSkills, ...dedupedProjectSkills];
        jsonOutput({
          success: true,
          command: 'skill list',
          data: {
            scope: effectiveScope,
            skills: allSkills.map((s) => ({
              name: s.name,
              plugin: s.pluginName,
              disabled: s.disabled,
            })),
          },
        });
        return;
      }

      if (userSkills.length === 0 && dedupedProjectSkills.length === 0) {
        console.log('No skills found. Install a plugin first with:');
        console.log('  allagents plugin install <plugin>');
        return;
      }

      // Display user skills
      if (userSkills.length > 0 && scope !== 'project') {
        console.log(`\n${chalk.whiteBright('User Skills:')}`);
        const grouped = groupSkillsByPlugin(userSkills);
        for (const [pluginName, data] of grouped) {
          console.log(`\n${chalk.hex("#89b4fa")(pluginName)} (${data.source}):`);
          for (const skill of data.skills) {
            const icon = skill.disabled ? '\u2717' : '\u2713';
            const status = skill.disabled ? ' (disabled)' : '';
            console.log(`  ${icon} ${skill.name}${status}`);
          }
        }
      }

      // Display project skills
      if (dedupedProjectSkills.length > 0) {
        console.log(`\n${chalk.whiteBright('Project Skills:')}`);
        const grouped = groupSkillsByPlugin(dedupedProjectSkills);
        for (const [pluginName, data] of grouped) {
          console.log(`\n${chalk.hex("#89b4fa")(pluginName)} (${data.source}):`);
          for (const skill of data.skills) {
            const icon = skill.disabled ? '\u2717' : '\u2713';
            const status = skill.disabled ? ' (disabled)' : '';
            console.log(`  ${icon} ${skill.name}${status}`);
          }
        }
      }
      console.log();
    } catch (error) {
      if (error instanceof Error) {
        if (isJsonMode()) {
          jsonOutput({ success: false, command: 'skill list', error: error.message });
          process.exit(1);
        }
        console.error(`Error: ${error.message}`);
        process.exit(1);
      }
      throw error;
    }
  },
});

// =============================================================================
// plugin skills remove
// =============================================================================

const removeCmd = command({
  name: 'remove',
  description: buildDescription(skillsRemoveMeta),
  args: {
    skill: positional({ type: string, displayName: 'skill' }),
    scope: option({
      type: optional(string),
      long: 'scope',
      short: 's',
      description: 'Scope: "project" (default) or "user"',
    }),
    plugin: option({
      type: optional(string),
      long: 'plugin',
      short: 'p',
      description: 'Plugin name (required if skill exists in multiple plugins)',
    }),
  },
  handler: async ({ skill, scope, plugin }) => {
    try {
      const isUser = scope === 'user' || (!scope && resolveScope(process.cwd()) === 'user');
      const workspacePath = isUser ? getHomeDir() : process.cwd();

      // Find the skill
      const matches = await findSkillByName(skill, workspacePath);

      if (matches.length === 0) {
        const allSkills = await getAllSkillsFromPlugins(workspacePath);
        const skillNames = [...new Set(allSkills.map((s) => s.name))].join(', ');
        const error = `Skill '${skill}' not found in any installed plugin.\n\nAvailable skills: ${skillNames || 'none'}`;
        if (isJsonMode()) {
          jsonOutput({ success: false, command: 'skill remove', error });
          process.exit(1);
        }
        console.error(`Error: ${error}`);
        process.exit(1);
      }

      // Handle ambiguity
      let targetSkill = matches[0];
      if (!targetSkill) {
        // This should never happen since we checked matches.length === 0 above
        throw new Error('Unexpected empty matches array');
      }
      if (matches.length > 1) {
        if (!plugin) {
          const pluginList = matches.map((m) => `  - ${m.pluginName} (${m.pluginSource})`).join('\n');
          const error = `'${skill}' exists in multiple plugins:\n${pluginList}\n\nUse --plugin to specify: allagents skill remove ${skill} --plugin <name>`;
          if (isJsonMode()) {
            jsonOutput({ success: false, command: 'skill remove', error });
            process.exit(1);
          }
          console.error(`Error: ${error}`);
          process.exit(1);
        }
        const filtered = matches.find((m) => m.pluginName === plugin);
        if (!filtered) {
          const error = `Plugin '${plugin}' not found. Installed plugins: ${matches.map((m) => m.pluginName).join(', ')}`;
          if (isJsonMode()) {
            jsonOutput({ success: false, command: 'skill remove', error });
            process.exit(1);
          }
          console.error(`Error: ${error}`);
          process.exit(1);
        }
        targetSkill = filtered;
      }

      // Check if already disabled
      if (targetSkill.disabled) {
        const msg = `Skill '${skill}' is already disabled.`;
        if (isJsonMode()) {
          jsonOutput({ success: false, command: 'skill remove', error: msg });
          process.exit(1);
        }
        console.log(msg);
        return;
      }

      const skillKey = `${targetSkill.pluginName}:${skill}`;

      const result = targetSkill.pluginSkillsMode === 'allowlist'
        ? isUser ? await removeUserEnabledSkill(skillKey) : await removeEnabledSkill(skillKey, workspacePath)
        : isUser ? await addUserDisabledSkill(skillKey) : await addDisabledSkill(skillKey, workspacePath);

      if (!result.success) {
        if (isJsonMode()) {
          jsonOutput({ success: false, command: 'skill remove', error: result.error ?? 'Unknown error' });
          process.exit(1);
        }
        console.error(`Error: ${result.error}`);
        process.exit(1);
      }

      if (!isJsonMode()) {
        console.log(`\u2713 Disabled skill: ${skill} (${targetSkill.pluginName})`);
      }

      const syncResult = isUser ? await syncUserWorkspace() : await syncWorkspace(workspacePath);

      if (isJsonMode()) {
        jsonOutput({
          success: syncResult.success,
          command: 'skill remove',
          data: {
            skill,
            plugin: targetSkill.pluginName,
            syncResult: {
              copied: syncResult.totalCopied,
              failed: syncResult.totalFailed,
            },
          },
        });
        if (!syncResult.success) process.exit(1);
        return;
      }
    } catch (error) {
      if (error instanceof Error) {
        if (isJsonMode()) {
          jsonOutput({ success: false, command: 'skill remove', error: error.message });
          process.exit(1);
        }
        console.error(`Error: ${error.message}`);
        process.exit(1);
      }
      throw error;
    }
  },
});

// =============================================================================
// Install skill from --from source (marketplace-aware)
// =============================================================================

type InstallSkillResult =
  | { success: true; pluginName: string; syncResult: { copied: number; failed: number } }
  | { success: false; error: string };

/**
 * Install a skill from a --from source. If the source is a marketplace
 * (has .claude-plugin/marketplace.json), register/update the marketplace,
 * find the plugin containing the skill, and install it via plugin@marketplace.
 * Otherwise, install the source directly as a plugin.
 *
 * In both cases, set the plugin to allowlist mode with only the requested skill.
 */
async function installSkillFromSource(opts: {
  skill: string;
  from: string;
  isUser: boolean;
  workspacePath: string;
}): Promise<InstallSkillResult> {
  const { skill, from, isUser, workspacePath } = opts;

  if (!isJsonMode()) {
    console.log(`Installing skill '${skill}' from ${from}...`);
  }

  // Fetch the source to a local cache so we can inspect it
  const parsed = isGitHubUrl(from) ? parseGitHubUrl(from) : null;
  const fetchResult = await fetchPlugin(from, {
    ...(parsed?.branch && { branch: parsed.branch }),
  });
  if (!fetchResult.success) {
    return { success: false, error: `Failed to fetch '${from}': ${fetchResult.error ?? 'Unknown error'}` };
  }

  // Check if the source is a marketplace
  const manifestResult = await parseMarketplaceManifest(fetchResult.cachePath);

  if (manifestResult.success) {
    return installSkillViaMarketplace({ skill, from, isUser, workspacePath });
  }

  // Not a marketplace — install as a direct plugin
  return installSkillDirect({ skill, from, isUser, workspacePath, cachePath: fetchResult.cachePath });
}

/**
 * Source is a marketplace: register it, find the plugin with the skill, install via spec.
 */
async function installSkillViaMarketplace(opts: {
  skill: string;
  from: string;
  isUser: boolean;
  workspacePath: string;
}): Promise<InstallSkillResult> {
  const { skill, from, isUser, workspacePath } = opts;

  const parsed = isGitHubUrl(from) ? parseGitHubUrl(from) : null;
  const sourceLocation = parsed ? `${parsed.owner}/${parsed.repo}` : undefined;

  // Check if the marketplace is already registered at any scope (user or project)
  let marketplaceName: string | undefined;
  const existingAnyScope = await findMarketplace(
    parsed?.repo ?? from,
    sourceLocation,
    isUser ? undefined : workspacePath,
  );

  if (existingAnyScope) {
    marketplaceName = existingAnyScope.name;
    await updateMarketplace(marketplaceName, isUser ? undefined : workspacePath);
  } else {
    // Register at the target scope
    const scopeOptions = isUser
      ? undefined
      : { scope: 'project' as const, workspacePath };

    const mktResult = await addMarketplace(
      from,
      parsed?.branch ? `${parsed.repo}-${parsed.branch}` : undefined,
      parsed?.branch ?? undefined,
      undefined,
      scopeOptions,
    );

    if (mktResult.success) {
      marketplaceName = mktResult.marketplace?.name;
    }
  }

  if (!marketplaceName) {
    return { success: false, error: `Failed to register marketplace from '${from}'` };
  }

  // List plugins in the marketplace and scan each for the requested skill
  const mktPlugins = await listMarketplacePlugins(marketplaceName, isUser ? undefined : workspacePath);
  if (mktPlugins.plugins.length === 0) {
    return { success: false, error: `No plugins found in marketplace '${marketplaceName}'.` };
  }

  let targetPluginName: string | null = null;
  const allAvailableSkills: string[] = [];
  for (const mktPlugin of mktPlugins.plugins) {
    // Use manifest skill paths when available (last path segment = skill name),
    // fall back to filesystem discovery
    const skillNames = mktPlugin.skills
      ? mktPlugin.skills.map((s) => s.split('/').pop() ?? '').filter(Boolean)
      : await discoverSkillNames(mktPlugin.path);
    allAvailableSkills.push(...skillNames);
    if (!targetPluginName && skillNames.includes(skill)) {
      targetPluginName = mktPlugin.name;
    }
  }

  if (!targetPluginName) {
    return {
      success: false,
      error: `Skill '${skill}' not found in marketplace '${marketplaceName}'.\n\nAvailable skills: ${allAvailableSkills.join(', ') || 'none'}`,
    };
  }

  // Install the specific plugin via plugin@marketplace spec
  const pluginSpec = `${targetPluginName}@${marketplaceName}`;

  const installResult = isUser
    ? await addUserPlugin(pluginSpec)
    : await addPlugin(pluginSpec, workspacePath);

  if (!installResult.success) {
    // Plugin may already be installed — that's fine, we just need to add the skill
    if (!installResult.error?.includes('already exists') && !installResult.error?.includes('duplicates existing')) {
      return { success: false, error: `Failed to install plugin '${pluginSpec}': ${installResult.error ?? 'Unknown error'}` };
    }
  }

  // Set allowlist or add skill to existing allowlist
  return applySkillAllowlist({ skill, pluginName: targetPluginName, isUser, workspacePath });
}

/**
 * Source is not a marketplace — install the GitHub URL / path directly as a plugin.
 */
async function installSkillDirect(opts: {
  skill: string;
  from: string;
  isUser: boolean;
  workspacePath: string;
  cachePath: string;
}): Promise<InstallSkillResult> {
  const { skill, from, isUser, workspacePath, cachePath } = opts;

  // Verify the skill exists in the cached plugin before installing
  const availableSkills = await discoverSkillNames(cachePath);
  if (!availableSkills.includes(skill)) {
    return {
      success: false,
      error: `Skill '${skill}' not found in plugin '${from}'.\n\nAvailable skills: ${availableSkills.join(', ') || 'none'}\n\nTip: run \`allagents skill list\` to see all installed skills.`,
    };
  }

  const installResult = isUser
    ? await addUserPlugin(from)
    : await addPlugin(from, workspacePath);

  if (!installResult.success) {
    if (!installResult.error?.includes('already exists') && !installResult.error?.includes('duplicates existing')) {
      return { success: false, error: `Failed to install plugin '${from}': ${installResult.error ?? 'Unknown error'}` };
    }
    if (!isJsonMode()) {
      console.log('Plugin already installed.');
    }
  }

  const pluginName = getPluginName(cachePath);
  return applySkillAllowlist({ skill, pluginName, isUser, workspacePath });
}

/**
 * Set or extend the plugin's skill allowlist with the requested skill, then sync.
 */
async function applySkillAllowlist(opts: {
  skill: string;
  pluginName: string;
  isUser: boolean;
  workspacePath: string;
}): Promise<InstallSkillResult> {
  const { skill, pluginName, isUser, workspacePath } = opts;

  // Check current state: if plugin already has an allowlist, add to it; otherwise create one
  const allSkills = await getAllSkillsFromPlugins(workspacePath);
  const pluginSkills = allSkills.filter((s) => s.pluginName === pluginName);
  const currentMode = pluginSkills[0]?.pluginSkillsMode ?? 'none';

  if (currentMode === 'allowlist') {
    // Add to existing allowlist
    const skillKey = `${pluginName}:${skill}`;
    const addResult = isUser
      ? await addUserEnabledSkill(skillKey)
      : await addEnabledSkill(skillKey, workspacePath);

    if (!addResult.success) {
      // Already in allowlist = already enabled
      if (!addResult.error?.includes('already enabled')) {
        return { success: false, error: `Failed to enable skill: ${addResult.error ?? 'Unknown error'}` };
      }
    }
  } else {
    // No allowlist yet — create one with just this skill
    const setModeResult = isUser
      ? await setUserPluginSkillsMode(pluginName, 'allowlist', [skill])
      : await setPluginSkillsMode(pluginName, 'allowlist', [skill], workspacePath);

    if (!setModeResult.success) {
      return { success: false, error: `Failed to configure skill allowlist: ${setModeResult.error ?? 'Unknown error'}` };
    }
  }

  if (!isJsonMode()) {
    console.log(`\u2713 Enabled skill: ${skill} (${pluginName})`);
  }

  const syncResult = isUser ? await syncUserWorkspace() : await syncWorkspace(workspacePath);
  if (!syncResult.success) {
    return { success: false, error: 'Sync failed' };
  }

  return {
    success: true,
    pluginName,
    syncResult: {
      copied: syncResult.totalCopied,
      failed: syncResult.totalFailed,
    },
  };
}

// =============================================================================
// Skill discovery helpers (for --list and --all)
// =============================================================================

interface DiscoveredSkill {
  name: string;
  description: string;
  pluginName?: string;
}

/**
 * Resolve the SKILL.md path for a skill name in a plugin directory.
 * Handles standard (skills/<name>/), flat (<name>/), and root layouts.
 */
function resolveSkillMdPath(pluginPath: string, skillName: string): string {
  const standardPath = join(pluginPath, 'skills', skillName, 'SKILL.md');
  if (existsSync(standardPath)) return standardPath;

  const flatPath = join(pluginPath, skillName, 'SKILL.md');
  if (existsSync(flatPath)) return flatPath;

  return join(pluginPath, 'SKILL.md');
}

/**
 * Read SKILL.md frontmatter for each discovered skill in a plugin directory.
 */
export async function discoverSkillsWithMetadata(
  pluginPath: string,
  pluginName?: string,
): Promise<DiscoveredSkill[]> {
  const names = await discoverSkillNames(pluginPath);
  const results: DiscoveredSkill[] = [];

  for (const name of names) {
    const skillMdPath = resolveSkillMdPath(pluginPath, name);
    let description = '';
    try {
      const content = await readFile(skillMdPath, 'utf-8');
      const metadata = parseSkillMetadata(content);
      description = metadata?.description ?? '';
    } catch {
      // Leave description empty
    }
    results.push({ name, description, ...(pluginName && { pluginName }) });
  }

  return results;
}

/**
 * Discover all skills available at a --from source. Handles both direct plugins
 * and marketplaces (in which case skills from all marketplace plugins are returned).
 */
async function discoverSkillsFromSource(from: string): Promise<
  | { success: true; skills: DiscoveredSkill[]; isMarketplace: boolean }
  | { success: false; error: string }
> {
  const parsed = isGitHubUrl(from) ? parseGitHubUrl(from) : null;
  const fetchResult = await fetchPlugin(from, {
    ...(parsed?.branch && { branch: parsed.branch }),
  });
  if (!fetchResult.success) {
    return { success: false, error: `Failed to fetch '${from}': ${fetchResult.error ?? 'Unknown error'}` };
  }

  const manifestResult = await parseMarketplaceManifest(fetchResult.cachePath);
  if (manifestResult.success) {
    const all: DiscoveredSkill[] = [];
    for (const plugin of manifestResult.data.plugins) {
      // Skip remote URL sources — listing would need extra fetches
      if (typeof plugin.source === 'object') continue;
      const resolved = resolvePluginSourcePath(plugin.source, fetchResult.cachePath);
      if (!existsSync(resolved)) continue;
      const skills = await discoverSkillsWithMetadata(resolved, plugin.name);
      all.push(...skills);
    }
    return { success: true, skills: all, isMarketplace: true };
  }

  const skills = await discoverSkillsWithMetadata(fetchResult.cachePath);
  return { success: true, skills, isMarketplace: false };
}

/**
 * Install all skills from a --from source. Mirrors installSkillFromSource but
 * enables every discovered skill rather than a single named one.
 */
async function installAllSkillsFromSource(opts: {
  from: string;
  isUser: boolean;
  workspacePath: string;
}): Promise<
  | { success: true; installed: Array<{ pluginName: string; skills: string[] }>; syncResult: SyncResult }
  | { success: false; error: string }
> {
  const { from, isUser, workspacePath } = opts;

  if (!isJsonMode()) {
    console.log(`Installing all skills from ${from}...`);
  }

  const parsed = isGitHubUrl(from) ? parseGitHubUrl(from) : null;
  const fetchResult = await fetchPlugin(from, {
    ...(parsed?.branch && { branch: parsed.branch }),
  });
  if (!fetchResult.success) {
    return { success: false, error: `Failed to fetch '${from}': ${fetchResult.error ?? 'Unknown error'}` };
  }

  const manifestResult = await parseMarketplaceManifest(fetchResult.cachePath);

  if (manifestResult.success) {
    return installAllViaMarketplace({ from, isUser, workspacePath, cachedPath: fetchResult.cachePath });
  }

  // Direct plugin install — enable every discovered skill
  const skillNames = await discoverSkillNames(fetchResult.cachePath);
  if (skillNames.length === 0) {
    return { success: false, error: `No skills found in '${from}'.` };
  }

  const installResult = isUser ? await addUserPlugin(from) : await addPlugin(from, workspacePath);
  if (!installResult.success) {
    if (!installResult.error?.includes('already exists') && !installResult.error?.includes('duplicates existing')) {
      return { success: false, error: `Failed to install plugin '${from}': ${installResult.error ?? 'Unknown error'}` };
    }
    if (!isJsonMode()) {
      console.log('Plugin already installed.');
    }
  }

  const pluginName = getPluginName(fetchResult.cachePath);

  const setModeResult = isUser
    ? await setUserPluginSkillsMode(pluginName, 'allowlist', skillNames)
    : await setPluginSkillsMode(pluginName, 'allowlist', skillNames, workspacePath);

  if (!setModeResult.success) {
    return { success: false, error: `Failed to configure skill allowlist: ${setModeResult.error ?? 'Unknown error'}` };
  }

  if (!isJsonMode()) {
    console.log(`✓ Enabled ${skillNames.length} skill(s) from ${pluginName}: ${skillNames.join(', ')}`);
  }

  const syncResult = isUser ? await syncUserWorkspace() : await syncWorkspace(workspacePath);
  if (!syncResult.success) {
    return { success: false, error: 'Sync failed' };
  }

  return {
    success: true,
    installed: [{ pluginName, skills: skillNames }],
    syncResult,
  };
}

/**
 * Install every plugin from a marketplace source and enable every skill in each.
 */
async function installAllViaMarketplace(opts: {
  from: string;
  isUser: boolean;
  workspacePath: string;
  cachedPath?: string;
}): Promise<
  | { success: true; installed: Array<{ pluginName: string; skills: string[] }>; syncResult: SyncResult }
  | { success: false; error: string }
> {
  const { from, isUser, workspacePath, cachedPath } = opts;
  const parsed = isGitHubUrl(from) ? parseGitHubUrl(from) : null;
  const sourceLocation = parsed ? `${parsed.owner}/${parsed.repo}` : undefined;

  let marketplaceName: string | undefined;
  const existingAnyScope = await findMarketplace(
    parsed?.repo ?? from,
    sourceLocation,
    isUser ? undefined : workspacePath,
  );

  if (existingAnyScope) {
    marketplaceName = existingAnyScope.name;
    await updateMarketplace(marketplaceName, isUser ? undefined : workspacePath);
  } else {
    // Seed the fetch cache so any fetchPlugin calls for individual plugins
    // within the marketplace reuse the already-fetched content.
    if (cachedPath) seedFetchCache(from, cachedPath);

    const scopeOptions = isUser
      ? undefined
      : { scope: 'project' as const, workspacePath };

    const mktResult = await addMarketplace(
      from,
      parsed?.branch ? `${parsed.repo}-${parsed.branch}` : undefined,
      parsed?.branch ?? undefined,
      undefined,
      scopeOptions,
    );

    if (mktResult.success) {
      marketplaceName = mktResult.marketplace?.name;
    }
  }

  if (!marketplaceName) {
    return { success: false, error: `Failed to register marketplace from '${from}'` };
  }

  const mktPlugins = await listMarketplacePlugins(marketplaceName, isUser ? undefined : workspacePath);
  if (mktPlugins.plugins.length === 0) {
    return { success: false, error: `No plugins found in marketplace '${marketplaceName}'.` };
  }

  const installed: Array<{ pluginName: string; skills: string[] }> = [];

  for (const mktPlugin of mktPlugins.plugins) {
    const skillNames = mktPlugin.skills
      ? mktPlugin.skills.map((s) => s.split('/').pop() ?? '').filter(Boolean)
      : await discoverSkillNames(mktPlugin.path);

    if (skillNames.length === 0) continue;

    const pluginSpec = `${mktPlugin.name}@${marketplaceName}`;
    const installResult = isUser
      ? await addUserPlugin(pluginSpec)
      : await addPlugin(pluginSpec, workspacePath);

    if (!installResult.success) {
      if (!installResult.error?.includes('already exists') && !installResult.error?.includes('duplicates existing')) {
        return { success: false, error: `Failed to install plugin '${pluginSpec}': ${installResult.error ?? 'Unknown error'}` };
      }
    }

    const setModeResult = isUser
      ? await setUserPluginSkillsMode(mktPlugin.name, 'allowlist', skillNames)
      : await setPluginSkillsMode(mktPlugin.name, 'allowlist', skillNames, workspacePath);

    if (!setModeResult.success) {
      return { success: false, error: `Failed to configure skill allowlist for '${mktPlugin.name}': ${setModeResult.error ?? 'Unknown error'}` };
    }

    installed.push({ pluginName: mktPlugin.name, skills: skillNames });
  }

  if (installed.length === 0) {
    return { success: false, error: `No skills found across plugins in marketplace '${marketplaceName}'.` };
  }

  if (!isJsonMode()) {
    const total = installed.reduce((sum, i) => sum + i.skills.length, 0);
    console.log(`✓ Enabled ${total} skill(s) across ${installed.length} plugin(s)`);
  }

  const syncResult = isUser ? await syncUserWorkspace() : await syncWorkspace(workspacePath);
  if (!syncResult.success) {
    return { success: false, error: 'Sync failed' };
  }

  return {
    success: true,
    installed,
    syncResult,
  };
}

// =============================================================================
// plugin skills add
// =============================================================================

const addCmd = command({
  name: 'add',
  description: buildDescription(skillsAddMeta),
  args: {
    skill: positional({ type: optional(string), displayName: 'skill' }),
    scope: option({
      type: optional(string),
      long: 'scope',
      short: 's',
      description: 'Scope: "project" (default) or "user"',
    }),
    plugin: option({
      type: optional(string),
      long: 'plugin',
      short: 'p',
      description: 'Plugin name (required if skill exists in multiple plugins)',
    }),
    from: option({
      type: optional(string),
      long: 'from',
      short: 'f',
      description: 'Plugin source to install if the skill is not already available',
    }),
    pin: option({
      type: optional(string),
      long: 'pin',
      description: 'Pin the plugin to a specific Git ref (tag, branch, or SHA). Mutually exclusive with inline @ref in --from.',
    }),
    list: flag({
      long: 'list',
      short: 'l',
      description: 'List available skills at --from without installing',
    }),
    all: flag({
      long: 'all',
      description: 'Install every skill from --from',
    }),
  },
  handler: async ({ skill: skillArg, scope, plugin, from: fromArg, pin, list, all }) => {
    try {
      // Resolve --pin together with inline @ref. Three legal states:
      //   • --pin only  → splice into fromArg
      //   • inline @ref → leave fromArg alone, remember pinnedRef
      //   • neither     → no pin
      // Mutex: --pin combined with inline @ref is rejected.
      let pinnedRef: string | undefined;
      if (pin || fromArg) {
        const inlineRef = fromArg ? extractInlineRef(fromArg) : undefined;
        if (pin && inlineRef) {
          const error = 'Cannot combine inline @version in --from with --pin. Use one or the other.';
          if (isJsonMode()) {
            jsonOutput({ success: false, command: 'skill add', error });
            process.exit(1);
          }
          console.error(`Error: ${error}`);
          process.exit(1);
        }
        if (pin && fromArg) {
          // Splice the pin into the source string so downstream parseGitHubUrl
          // picks it up as the branch/tag.
          fromArg = `${fromArg}@${pin}`;
          pinnedRef = pin;
        } else if (inlineRef) {
          pinnedRef = inlineRef;
        } else if (pin && !fromArg) {
          const error = '--pin requires --from to specify a plugin source.';
          if (isJsonMode()) {
            jsonOutput({ success: false, command: 'skill add', error });
            process.exit(1);
          }
          console.error(`Error: ${error}`);
          process.exit(1);
        }
      }

      // --list: dry-run discovery, no workspace changes
      if (list) {
        if (skillArg) {
          const error = 'Cannot combine a skill argument with --list. Use --list alone to discover available skills.';
          if (isJsonMode()) {
            jsonOutput({ success: false, command: 'skill add', error });
            process.exit(1);
          }
          console.error(`Error: ${error}`);
          process.exit(1);
        }
        if (!fromArg) {
          const error = '--list requires --from to specify a plugin source.';
          if (isJsonMode()) {
            jsonOutput({ success: false, command: 'skill add', error });
            process.exit(1);
          }
          console.error(`Error: ${error}`);
          process.exit(1);
        }
        if (all) {
          const error = '--list and --all cannot be used together.';
          if (isJsonMode()) {
            jsonOutput({ success: false, command: 'skill add', error });
            process.exit(1);
          }
          console.error(`Error: ${error}`);
          process.exit(1);
        }

        const discovered = await discoverSkillsFromSource(fromArg);
        if (!discovered.success) {
          if (isJsonMode()) {
            jsonOutput({ success: false, command: 'skill add', error: discovered.error });
            process.exit(1);
          }
          console.error(`Error: ${discovered.error}`);
          process.exit(1);
        }

        if (isJsonMode()) {
          jsonOutput({
            success: true,
            command: 'skill add',
            data: {
              source: fromArg,
              isMarketplace: discovered.isMarketplace,
              skills: discovered.skills.map((s) => ({
                name: s.name,
                description: s.description,
                ...(s.pluginName && { plugin: s.pluginName }),
              })),
            },
          });
          return;
        }

        if (discovered.skills.length === 0) {
          console.log(`No skills found in ${fromArg}.`);
          return;
        }

        console.log(`\nAvailable skills in ${fromArg}:\n`);
        for (const s of discovered.skills) {
          const label = s.pluginName ? `${s.name} ${chalk.gray(`(${s.pluginName})`)}` : s.name;
          console.log(`  ${chalk.hex('#89b4fa')(label)}`);
          if (s.description) console.log(`    ${s.description}`);
          console.log();
        }
        return;
      }

      // --all: bulk install
      if (all) {
        if (!fromArg) {
          const error = '--all requires --from to specify a plugin source.';
          if (isJsonMode()) {
            jsonOutput({ success: false, command: 'skill add', error });
            process.exit(1);
          }
          console.error(`Error: ${error}`);
          process.exit(1);
        }
        if (skillArg) {
          const error = 'Cannot combine a skill argument with --all. Use --all alone to install every skill.';
          if (isJsonMode()) {
            jsonOutput({ success: false, command: 'skill add', error });
            process.exit(1);
          }
          console.error(`Error: ${error}`);
          process.exit(1);
        }

        const isUserAll = scope === 'user';
        const workspacePathAll = isUserAll ? getHomeDir() : process.cwd();

        const installResult = await installAllSkillsFromSource({
          from: fromArg,
          isUser: isUserAll,
          workspacePath: workspacePathAll,
        });

        if (!installResult.success) {
          if (isJsonMode()) {
            jsonOutput({ success: false, command: 'skill add', error: installResult.error });
            process.exit(1);
          }
          console.error(`Error: ${installResult.error}`);
          process.exit(1);
        }

        // Record provenance (resolved ref/SHA + optional pin + per-skill
        // content hashes) for every skill installed via --all.
        const everySkill = installResult.installed.flatMap((i) => i.skills);
        await recordContentProvenance({
          from: fromArg,
          skills: everySkill,
          pinnedRef,
          workspacePath: workspacePathAll,
          isUser: isUserAll,
        });

        if (isJsonMode()) {
          jsonOutput({
            success: true,
            command: 'skill add',
            data: {
              source: fromArg,
              installed: installResult.installed,
              syncResult: {
                copied: installResult.syncResult.totalCopied,
                failed: installResult.syncResult.totalFailed,
              },
              ...(pinnedRef && { pinnedRef }),
            },
          });
          return;
        }

        for (const line of formatSyncHeader(installResult.syncResult)) {
          console.log(line);
        }
        const summaryLines = formatSyncSummary(installResult.syncResult);
        if (summaryLines.length > 0) {
          console.log('');
          for (const line of summaryLines) {
            console.log(line);
          }
        }
        return;
      }

      // Without --list or --all, skill argument is required.
      if (!skillArg) {
        const error = 'A skill name is required. Use --list to discover available skills or --all to install everything.';
        if (isJsonMode()) {
          jsonOutput({ success: false, command: 'skill add', error });
          process.exit(1);
        }
        console.error(`Error: ${error}`);
        process.exit(1);
      }

      let skill = skillArg;
      let from = fromArg;

      // Auto-detect GitHub URL as skill argument
      const urlResolved = resolveSkillFromUrl(skill);
      if (urlResolved) {
        if (from) {
          const error =
            'Cannot use --from when the skill argument is a GitHub URL. The URL is used as the plugin source automatically.';
          if (isJsonMode()) {
            jsonOutput({ success: false, command: 'skill add', error });
            process.exit(1);
          }
          console.error(`Error: ${error}`);
          process.exit(1);
        }
        from = urlResolved.from;

        // For URLs without subpath, try to read skill name from SKILL.md frontmatter
        if (urlResolved.parsed && !urlResolved.parsed.subpath) {
          skill = await resolveSkillNameFromRepo(skill, urlResolved.parsed, urlResolved.skill);
        } else {
          skill = urlResolved.skill;
        }
      }

      // When --from is used (installing a new plugin), default to project scope
      const hasFromSource = Boolean(from);
      const isUser = scope === 'user' || (!scope && !hasFromSource && resolveScope(process.cwd()) === 'user');
      const workspacePath = isUser ? getHomeDir() : process.cwd();

      // Find the skill
      const matches = await findSkillByName(skill, workspacePath);

      if (matches.length === 0) {
        if (from) {
          // Install the plugin from --from source, then enable only the requested skill
          const installFromResult = await installSkillFromSource({
            skill,
            from,
            isUser,
            workspacePath,
          });

          if (!installFromResult.success) {
            if (isJsonMode()) {
              jsonOutput({ success: false, command: 'skill add', error: installFromResult.error });
              process.exit(1);
            }
            console.error(`Error: ${installFromResult.error}`);
            process.exit(1);
          }

          // Record per-source ref/SHA + optional pin + per-skill content
          // hash for drift detection on subsequent syncs.
          await recordContentProvenance({
            from,
            skills: [skill],
            pinnedRef,
            workspacePath,
            isUser,
          });

          if (isJsonMode()) {
            jsonOutput({
              success: true,
              command: 'skill add',
              data: {
                skill,
                plugin: installFromResult.pluginName,
                syncResult: installFromResult.syncResult,
                ...(pinnedRef && { pinnedRef }),
              },
            });
            return;
          }

          if (pinnedRef) {
            console.log(`Pinned to ${pinnedRef}.`);
          }
          return;
        }

        const allSkills = await getAllSkillsFromPlugins(workspacePath);
        const skillNames = [...new Set(allSkills.map((s) => s.name))].join(', ');
        const error = `Skill '${skill}' not found in any installed plugin.\n\nAvailable skills: ${skillNames || 'none'}`;
        if (isJsonMode()) {
          jsonOutput({ success: false, command: 'skill add', error });
          process.exit(1);
        }
        console.error(`Error: ${error}`);
        process.exit(1);
      }

      // Handle ambiguity
      let targetSkill = matches[0];
      if (!targetSkill) {
        // This should never happen since we checked matches.length === 0 above
        throw new Error('Unexpected empty matches array');
      }
      if (matches.length > 1) {
        if (!plugin) {
          const pluginList = matches.map((m) => `  - ${m.pluginName} (${m.pluginSource})`).join('\n');
          const error = `'${skill}' exists in multiple plugins:\n${pluginList}\n\nUse --plugin to specify: allagents skill add ${skill} --plugin <name>`;
          if (isJsonMode()) {
            jsonOutput({ success: false, command: 'skill add', error });
            process.exit(1);
          }
          console.error(`Error: ${error}`);
          process.exit(1);
        }
        const filtered = matches.find((m) => m.pluginName === plugin);
        if (!filtered) {
          const error = `Plugin '${plugin}' not found. Installed plugins: ${matches.map((m) => m.pluginName).join(', ')}`;
          if (isJsonMode()) {
            jsonOutput({ success: false, command: 'skill add', error });
            process.exit(1);
          }
          console.error(`Error: ${error}`);
          process.exit(1);
        }
        targetSkill = filtered;
      }

      // Check if already enabled
      if (!targetSkill.disabled) {
        const msg = `Skill '${skill}' is already enabled.`;
        if (isJsonMode()) {
          jsonOutput({ success: false, command: 'skill add', error: msg });
          process.exit(1);
        }
        console.log(msg);
        return;
      }

      const skillKey = `${targetSkill.pluginName}:${skill}`;

      const result = targetSkill.pluginSkillsMode === 'blocklist'
        ? isUser ? await removeUserDisabledSkill(skillKey) : await removeDisabledSkill(skillKey, workspacePath)
        : isUser ? await addUserEnabledSkill(skillKey) : await addEnabledSkill(skillKey, workspacePath);

      if (!result.success) {
        if (isJsonMode()) {
          jsonOutput({ success: false, command: 'skill add', error: result.error ?? 'Unknown error' });
          process.exit(1);
        }
        console.error(`Error: ${result.error}`);
        process.exit(1);
      }

      if (!isJsonMode()) {
        console.log(`\u2713 Enabled skill: ${skill} (${targetSkill.pluginName})`);
      }

      const syncResult = isUser ? await syncUserWorkspace() : await syncWorkspace(workspacePath);

      if (isJsonMode()) {
        jsonOutput({
          success: syncResult.success,
          command: 'skill add',
          data: {
            skill,
            plugin: targetSkill.pluginName,
            syncResult: {
              copied: syncResult.totalCopied,
              failed: syncResult.totalFailed,
            },
          },
        });
        if (!syncResult.success) process.exit(1);
        return;
      }
    } catch (error) {
      if (error instanceof Error) {
        if (isJsonMode()) {
          jsonOutput({ success: false, command: 'skill add', error: error.message });
          process.exit(1);
        }
        console.error(`Error: ${error.message}`);
        process.exit(1);
      }
      throw error;
    }
  },
});

// =============================================================================
// skill search (GitHub Code Search)
// =============================================================================

const searchCmd = command({
  name: 'search',
  description: buildDescription(skillsSearchMeta),
  args: {
    query: positional({ type: string, displayName: 'query' }),
    owner: option({
      type: optional(string),
      long: 'owner',
      description: 'Scope to a single GitHub owner (org or user).',
    }),
    page: option({
      type: optional(string),
      long: 'page',
      description: 'Result page (1-indexed, default 1).',
    }),
    limit: option({
      type: optional(string),
      long: 'limit',
      description: 'Results per page (1–100, default 30).',
    }),
  },
  handler: async ({ query, owner, page, limit }) => {
    try {
      const opts: SkillSearchOptions = {};
      if (owner) opts.owner = owner;
      if (page !== undefined) {
        const n = Number.parseInt(page, 10);
        if (Number.isNaN(n)) {
          const err = '--page must be an integer.';
          if (isJsonMode()) {
            jsonOutput({ success: false, command: 'skill search', error: err });
            process.exit(2);
          }
          console.error(`Error: ${err}`);
          process.exit(2);
        }
        opts.page = n;
      }
      if (limit !== undefined) {
        const n = Number.parseInt(limit, 10);
        if (Number.isNaN(n)) {
          const err = '--limit must be an integer.';
          if (isJsonMode()) {
            jsonOutput({ success: false, command: 'skill search', error: err });
            process.exit(2);
          }
          console.error(`Error: ${err}`);
          process.exit(2);
        }
        opts.limit = n;
      }

      const result = await searchSkills(query, opts);

      if (isJsonMode()) {
        jsonOutput({
          success: true,
          command: 'skill search',
          data: result,
        });
        return;
      }

      if (result.items.length === 0) {
        console.log(`No skills found for "${query}".`);
        return;
      }

      console.log(`Found ${result.total} skill(s)${result.truncated ? ' (results truncated)' : ''}:`);
      for (const item of result.items) {
        const repoCol = item.repo.padEnd(28);
        const nameCol = item.name.padEnd(28);
        const desc = item.description ? `  ${item.description}` : '';
        console.log(`  ${repoCol}  ${nameCol}${desc}`);
      }
    } catch (error) {
      if (error instanceof SkillSearchError) {
        const exitCode = error.kind === 'validation' ? 2 : 1;
        if (isJsonMode()) {
          jsonOutput({ success: false, command: 'skill search', error: error.message });
          process.exit(exitCode);
        }
        console.error(`Error: ${error.message}`);
        process.exit(exitCode);
      }
      if (error instanceof Error) {
        if (isJsonMode()) {
          jsonOutput({ success: false, command: 'skill search', error: error.message });
          process.exit(1);
        }
        console.error(`Error: ${error.message}`);
        process.exit(1);
      }
      throw error;
    }
  },
});

// =============================================================================
// skill subcommands group (canonical singular; `skills` is a CLI alias)
// =============================================================================

export const skillsCmd = conciseSubcommands({
  name: 'skill',
  description: 'Manage individual skills from plugins',
  cmds: {
    list: listCmd,
    remove: removeCmd,
    add: addCmd,
    search: searchCmd,
  },
});
