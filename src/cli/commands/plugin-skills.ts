import { existsSync } from 'node:fs';
import { join } from 'node:path';
import chalk from 'chalk';
import { command, positional, option, string, optional } from 'cmd-ts';
import { syncWorkspace, syncUserWorkspace } from '../../core/sync.js';
import {
  addDisabledSkill,
  removeDisabledSkill,
} from '../../core/workspace-modify.js';
import {
  addUserDisabledSkill,
  removeUserDisabledSkill,
  isUserConfigPath,
} from '../../core/user-workspace.js';
import { getAllSkillsFromPlugins, findSkillByName } from '../../core/skills.js';
import { isJsonMode, jsonOutput } from '../json-output.js';
import { buildDescription, conciseSubcommands } from '../help.js';
import {
  skillsListMeta,
  skillsRemoveMeta,
  skillsAddMeta,
} from '../metadata/plugin-skills.js';
import { getHomeDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE } from '../../constants.js';

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

      // Add to disabled skills
      const skillKey = `${targetSkill.pluginName}:${skill}`;
      const result = isUser
        ? await addUserDisabledSkill(skillKey)
        : await addDisabledSkill(skillKey, workspacePath);

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

      // Remove from disabled skills
      const skillKey = `${targetSkill.pluginName}:${skill}`;
      const result = isUser
        ? await removeUserDisabledSkill(skillKey)
        : await removeDisabledSkill(skillKey, workspacePath);

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
