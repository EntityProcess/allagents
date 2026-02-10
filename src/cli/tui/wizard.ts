import * as p from '@clack/prompts';
import { settings } from '@clack/core';
import chalk from 'chalk';
import { relative } from 'node:path';
import packageJson from '../../../package.json';
import { TuiCache } from './cache.js';
import { getTuiContext, type TuiContext } from './context.js';

const { select } = p;

// Disable Escape key as cancel trigger to prevent terminal freezes.
// Ctrl+C (\x03) still works for cancellation.
settings.aliases.delete('escape');
import { runSync } from './actions/sync.js';
import { runStatus } from './actions/status.js';
import { runBrowseMarketplaces, runPlugins } from './actions/plugins.js';
import { runManageClients } from './actions/clients.js';
import { runSkills } from './actions/skills.js';
import { getUpdateNotice } from '../update-check.js';

export type MenuAction =
  | 'workspace'
  | 'sync'
  | 'plugins'
  | 'skills'
  | 'clients'
  | 'marketplace'
  | 'exit';

/**
 * Build context-aware menu options based on workspace state.
 * Plugins, Skills, Clients, and Marketplaces are always visible.
 */
export function buildMenuOptions(context: TuiContext) {
  const options: Array<{ label: string; value: MenuAction; hint?: string }> = [];

  if (context.needsSync) {
    options.push({ label: 'Sync plugins', value: 'sync', hint: 'sync needed' });
  }

  options.push({ label: 'Workspace', value: 'workspace' });
  options.push({ label: 'Plugins', value: 'plugins' });
  options.push({ label: 'Skills', value: 'skills' });
  options.push({ label: 'Clients', value: 'clients' });
  options.push({ label: 'Marketplaces', value: 'marketplace' });

  options.push({ label: 'Exit', value: 'exit' });
  return options;
}

/**
 * Build a workspace summary for display in a note.
 */
function buildSummary(context: TuiContext): string {
  const lines: string[] = [];

  if (context.hasWorkspace && context.workspacePath) {
    const relPath = relative(process.cwd(), context.workspacePath) || '.';
    lines.push(`Workspace: ${relPath}`);
    lines.push(`Project plugins: ${context.projectPluginCount}`);
  } else {
    lines.push('No workspace detected');
  }

  lines.push(`User plugins: ${context.userPluginCount}`);
  lines.push(`Marketplaces: ${context.marketplaceCount}`);

  if (context.needsSync) {
    lines.push(`Sync: ${chalk.yellow('needed')}`);
  } else if (context.hasWorkspace) {
    lines.push(`Sync: ${chalk.green('up to date')}`);
  }

  return lines.join('\n');
}

/**
 * Main interactive TUI wizard loop.
 * Detects workspace state, shows a context-aware menu, dispatches actions,
 * and loops until the user exits.
 */
export async function runWizard(): Promise<void> {
  p.intro(`${chalk.cyan('allagents')} v${packageJson.version}`);

  const updateNotice = await getUpdateNotice(packageJson.version);
  if (updateNotice) {
    p.log.info(updateNotice);
  }

  const cache = new TuiCache();
  let context = await getTuiContext(process.cwd(), cache);

  while (true) {
    p.note(buildSummary(context), 'Workspace');

    const action = await select<MenuAction>({
      message: 'What would you like to do?',
      options: buildMenuOptions(context),
    });

    if (p.isCancel(action)) {
      p.cancel('Cancelled');
      return;
    }

    switch (action) {
      case 'sync':
        await runSync(context);
        cache.invalidate();
        break;
      case 'workspace':
        await runStatus(context, cache);
        cache.invalidate();
        break;
      case 'plugins':
        await runPlugins(context, cache);
        break;
      case 'skills':
        await runSkills(context, cache);
        break;
      case 'clients':
        await runManageClients(context, cache);
        break;
      case 'marketplace':
        await runBrowseMarketplaces(context, cache);
        break;
      case 'exit':
        p.outro('Bye');
        return;
    }

    // Refresh context after each action (cache makes this cheap when nothing changed)
    context = await getTuiContext(process.cwd(), cache);
  }
}
