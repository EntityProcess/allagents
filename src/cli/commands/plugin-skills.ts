import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import chalk from 'chalk';
import { command, positional, option, string, optional } from 'cmd-ts';
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
} from '../metadata/plugin-skills.js';
import { getHomeDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE } from '../../constants.js';
import { isGitHubUrl, parseGitHubUrl } from '../../utils/plugin-path.js';
import { fetchPlugin, getPluginName } from '../../core/plugin.js';
import { parseSkillMetadata } from '../../validators/skill.js';
import {
  addMarketplace,
  findMarketplace,
  listMarketplacePlugins,
  updateMarketplace,
} from '../../core/marketplace.js';
import { parseMarketplaceManifest } from '../../utils/marketplace-manifest-parser.js';

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
          command: 'plugin skills list',
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
          jsonOutput({ success: false, command: 'plugin skills list', error: error.message });
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
          jsonOutput({ success: false, command: 'plugin skills remove', error });
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
          const error = `'${skill}' exists in multiple plugins:\n${pluginList}\n\nUse --plugin to specify: allagents plugin skills remove ${skill} --plugin <name>`;
          if (isJsonMode()) {
            jsonOutput({ success: false, command: 'plugin skills remove', error });
            process.exit(1);
          }
          console.error(`Error: ${error}`);
          process.exit(1);
        }
        const filtered = matches.find((m) => m.pluginName === plugin);
        if (!filtered) {
          const error = `Plugin '${plugin}' not found. Installed plugins: ${matches.map((m) => m.pluginName).join(', ')}`;
          if (isJsonMode()) {
            jsonOutput({ success: false, command: 'plugin skills remove', error });
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
          jsonOutput({ success: false, command: 'plugin skills remove', error: msg });
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
          jsonOutput({ success: false, command: 'plugin skills remove', error: result.error ?? 'Unknown error' });
          process.exit(1);
        }
        console.error(`Error: ${result.error}`);
        process.exit(1);
      }

      // Run sync
      if (!isJsonMode()) {
        console.log(`\u2713 Disabled skill: ${skill} (${targetSkill.pluginName})`);
        console.log('\nSyncing workspace...\n');
      }

      const syncResult = isUser ? await syncUserWorkspace() : await syncWorkspace(workspacePath);

      if (isJsonMode()) {
        jsonOutput({
          success: syncResult.success,
          command: 'plugin skills remove',
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

      console.log('Sync complete.');
    } catch (error) {
      if (error instanceof Error) {
        if (isJsonMode()) {
          jsonOutput({ success: false, command: 'plugin skills remove', error: error.message });
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
      error: `Skill '${skill}' not found in plugin '${from}'.\n\nAvailable skills: ${availableSkills.join(', ') || 'none'}\n\nTip: run \`allagents skills list\` to see all installed skills.`,
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

  // Sync to apply the allowlist
  if (!isJsonMode()) {
    console.log(`\u2713 Enabled skill: ${skill} (${pluginName})`);
    console.log('\nSyncing workspace...\n');
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
// plugin skills add
// =============================================================================

const addCmd = command({
  name: 'add',
  description: buildDescription(skillsAddMeta),
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
    from: option({
      type: optional(string),
      long: 'from',
      short: 'f',
      description: 'Plugin source to install if the skill is not already available',
    }),
  },
  handler: async ({ skill: skillArg, scope, plugin, from: fromArg }) => {
    try {
      let skill = skillArg;
      let from = fromArg;

      // Auto-detect GitHub URL as skill argument
      const urlResolved = resolveSkillFromUrl(skill);
      if (urlResolved) {
        if (from) {
          const error =
            'Cannot use --from when the skill argument is a GitHub URL. The URL is used as the plugin source automatically.';
          if (isJsonMode()) {
            jsonOutput({ success: false, command: 'plugin skills add', error });
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
              jsonOutput({ success: false, command: 'plugin skills add', error: installFromResult.error });
              process.exit(1);
            }
            console.error(`Error: ${installFromResult.error}`);
            process.exit(1);
          }

          if (isJsonMode()) {
            jsonOutput({
              success: true,
              command: 'plugin skills add',
              data: {
                skill,
                plugin: installFromResult.pluginName,
                syncResult: installFromResult.syncResult,
              },
            });
            return;
          }

          console.log('Sync complete.');
          return;
        }

        const allSkills = await getAllSkillsFromPlugins(workspacePath);
        const skillNames = [...new Set(allSkills.map((s) => s.name))].join(', ');
        const error = `Skill '${skill}' not found in any installed plugin.\n\nAvailable skills: ${skillNames || 'none'}`;
        if (isJsonMode()) {
          jsonOutput({ success: false, command: 'plugin skills add', error });
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
          const error = `'${skill}' exists in multiple plugins:\n${pluginList}\n\nUse --plugin to specify: allagents plugin skills add ${skill} --plugin <name>`;
          if (isJsonMode()) {
            jsonOutput({ success: false, command: 'plugin skills add', error });
            process.exit(1);
          }
          console.error(`Error: ${error}`);
          process.exit(1);
        }
        const filtered = matches.find((m) => m.pluginName === plugin);
        if (!filtered) {
          const error = `Plugin '${plugin}' not found. Installed plugins: ${matches.map((m) => m.pluginName).join(', ')}`;
          if (isJsonMode()) {
            jsonOutput({ success: false, command: 'plugin skills add', error });
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
          jsonOutput({ success: false, command: 'plugin skills add', error: msg });
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
          jsonOutput({ success: false, command: 'plugin skills add', error: result.error ?? 'Unknown error' });
          process.exit(1);
        }
        console.error(`Error: ${result.error}`);
        process.exit(1);
      }

      // Run sync
      if (!isJsonMode()) {
        console.log(`\u2713 Enabled skill: ${skill} (${targetSkill.pluginName})`);
        console.log('\nSyncing workspace...\n');
      }

      const syncResult = isUser ? await syncUserWorkspace() : await syncWorkspace(workspacePath);

      if (isJsonMode()) {
        jsonOutput({
          success: syncResult.success,
          command: 'plugin skills add',
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

      console.log('Sync complete.');
    } catch (error) {
      if (error instanceof Error) {
        if (isJsonMode()) {
          jsonOutput({ success: false, command: 'plugin skills add', error: error.message });
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
// plugin skills subcommands group
// =============================================================================

export const skillsCmd = conciseSubcommands({
  name: 'skills',
  description: 'Manage individual skills from plugins',
  cmds: {
    list: listCmd,
    remove: removeCmd,
    add: addCmd,
  },
});
