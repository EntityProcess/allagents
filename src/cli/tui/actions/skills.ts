import * as p from '@clack/prompts';
import { getAllSkillsFromPlugins, type SkillInfo } from '../../../core/skills.js';
import {
  addDisabledSkill,
  removeDisabledSkill,
} from '../../../core/workspace-modify.js';
import {
  addUserDisabledSkill,
  removeUserDisabledSkill,
  isUserConfigPath,
} from '../../../core/user-workspace.js';
import { syncWorkspace, syncUserWorkspace } from '../../../core/sync.js';
import { getHomeDir } from '../../../constants.js';
import type { TuiContext } from '../context.js';
import type { TuiCache } from '../cache.js';

const { multiselect } = p;

interface ScopedSkill extends SkillInfo {
  scope: 'user' | 'project';
  /** Unique key: "scope:pluginName:skillName" */
  key: string;
  /** Config key: "pluginName:skillName" */
  skillKey: string;
}

/**
 * Load skills from both user and project scopes, deduplicating overlaps.
 */
async function loadAllSkills(context: TuiContext): Promise<ScopedSkill[]> {
  const skills: ScopedSkill[] = [];

  // User-scope skills
  const userSkills = await getAllSkillsFromPlugins(getHomeDir());
  const userKeys = new Set<string>();

  for (const s of userSkills) {
    const skillKey = `${s.pluginName}:${s.name}`;
    userKeys.add(skillKey);
    skills.push({
      ...s,
      scope: 'user',
      key: `user:${skillKey}`,
      skillKey,
    });
  }

  // Project-scope skills (only if workspace exists and isn't the user config)
  if (context.workspacePath && !isUserConfigPath(context.workspacePath)) {
    const projectSkills = await getAllSkillsFromPlugins(context.workspacePath);
    for (const s of projectSkills) {
      const skillKey = `${s.pluginName}:${s.name}`;
      // Deduplicate: skip if same skill exists in user scope
      if (userKeys.has(skillKey)) continue;
      skills.push({
        ...s,
        scope: 'project',
        key: `project:${skillKey}`,
        skillKey,
      });
    }
  }

  return skills;
}

/**
 * Manage skills — lets user toggle which skills are enabled/disabled.
 */
export async function runManageSkills(context: TuiContext, cache?: TuiCache): Promise<void> {
  try {
    const skills = await loadAllSkills(context);

    if (skills.length === 0) {
      p.note('No skills found. Install a plugin with skills first.', 'Skills');
      return;
    }

    // Build multiselect options grouped by plugin
    const options = skills.map((s) => ({
      label: `${s.name} (${s.pluginName}) [${s.scope}]`,
      value: s.key,
    }));

    // Pre-select enabled skills (not disabled)
    const initialValues = skills.filter((s) => !s.disabled).map((s) => s.key);

    const selected = await multiselect({
      message: 'Toggle skills (selected = enabled)',
      options,
      initialValues,
      required: false,
    });

    if (p.isCancel(selected)) {
      return;
    }

    const selectedSet = new Set(selected);

    // Compute diff
    const toDisable = skills.filter((s) => !s.disabled && !selectedSet.has(s.key));
    const toEnable = skills.filter((s) => s.disabled && selectedSet.has(s.key));

    if (toDisable.length === 0 && toEnable.length === 0) {
      p.note('No changes made.', 'Skills');
      return;
    }

    const s = p.spinner();
    s.start('Updating skills...');

    let changedProject = false;
    let changedUser = false;

    // Disable newly unchecked skills
    for (const skill of toDisable) {
      if (skill.scope === 'user') {
        await addUserDisabledSkill(skill.skillKey);
        changedUser = true;
      } else if (context.workspacePath) {
        await addDisabledSkill(skill.skillKey, context.workspacePath);
        changedProject = true;
      }
    }

    // Enable newly checked skills
    for (const skill of toEnable) {
      if (skill.scope === 'user') {
        await removeUserDisabledSkill(skill.skillKey);
        changedUser = true;
      } else if (context.workspacePath) {
        await removeDisabledSkill(skill.skillKey, context.workspacePath);
        changedProject = true;
      }
    }

    s.stop('Skills updated');

    // Auto-sync affected scopes
    const syncS = p.spinner();
    syncS.start('Syncing...');
    if (changedProject && context.workspacePath) {
      await syncWorkspace(context.workspacePath);
    }
    if (changedUser) {
      await syncUserWorkspace();
    }
    syncS.stop('Sync complete');
    cache?.invalidate();

    const changes: string[] = [];
    for (const skill of toEnable) {
      changes.push(`✓ Enabled: ${skill.name} (${skill.pluginName}) [${skill.scope}]`);
    }
    for (const skill of toDisable) {
      changes.push(`✗ Disabled: ${skill.name} (${skill.pluginName}) [${skill.scope}]`);
    }
    p.note(changes.join('\n'), 'Updated');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    p.note(message, 'Error');
  }
}
