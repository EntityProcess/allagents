import * as p from '@clack/prompts';
import chalk from 'chalk';
import packageJson from '../../../package.json';
import { getTuiContext, type TuiContext } from './context.js';
import { runInit } from './actions/init.js';
import { runSync } from './actions/sync.js';
import { runStatus } from './actions/status.js';
import { runInstallPlugin, runManagePlugins } from './actions/plugins.js';
import { runUpdate } from './actions/update.js';

type MenuAction =
  | 'init'
  | 'sync'
  | 'status'
  | 'install'
  | 'manage'
  | 'marketplace'
  | 'update'
  | 'exit';

/**
 * Build context-aware menu options based on workspace state.
 */
function buildMenuOptions(context: TuiContext) {
  const options: Array<{ label: string; value: MenuAction; hint?: string }> = [];

  if (!context.hasWorkspace) {
    // State 1: No workspace detected
    options.push({ label: 'Initialize workspace', value: 'init' });
    options.push({ label: 'Browse marketplace', value: 'marketplace' });
    options.push({
      label: 'Install plugin (user scope)',
      value: 'install',
    });
  } else if (context.needsSync) {
    // State 2: Workspace exists, needs sync
    const total = context.projectPluginCount + context.userPluginCount;
    options.push({
      label: 'Sync plugins',
      value: 'sync',
      hint: `${total} plugin${total !== 1 ? 's' : ''}`,
    });
    options.push({ label: 'View status', value: 'status' });
    options.push({ label: 'Install plugin', value: 'install' });
    options.push({ label: 'Manage plugins', value: 'manage' });
    options.push({ label: 'Browse marketplace', value: 'marketplace' });
  } else {
    // State 3: Workspace exists, all synced
    options.push({ label: 'View status', value: 'status' });
    options.push({ label: 'Install plugin', value: 'install' });
    options.push({ label: 'Manage plugins', value: 'manage' });
    options.push({ label: 'Browse marketplace', value: 'marketplace' });
    options.push({ label: 'Check for updates', value: 'update' });
  }

  options.push({ label: 'Exit', value: 'exit' });
  return options;
}

/**
 * Build a workspace summary for display in a note.
 */
function buildSummary(context: TuiContext): string {
  const lines: string[] = [];

  if (context.hasWorkspace && context.workspacePath) {
    lines.push(`Workspace: ${context.workspacePath}`);
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

  let context = await getTuiContext();

  // biome-ignore lint/correctness/noConstantCondition: intentional wizard loop
  while (true) {
    p.note(buildSummary(context), 'Workspace');

    const action = await p.select<MenuAction>({
      message: 'What would you like to do?',
      options: buildMenuOptions(context),
    });

    if (p.isCancel(action)) {
      p.cancel('Cancelled');
      return;
    }

    switch (action) {
      case 'init':
        await runInit();
        break;
      case 'sync':
        await runSync(context);
        break;
      case 'status':
        await runStatus();
        break;
      case 'install':
        await runInstallPlugin(context);
        break;
      case 'manage':
        await runManagePlugins(context);
        break;
      case 'marketplace':
        await runInstallPlugin(context);
        break;
      case 'update':
        await runUpdate();
        break;
      case 'exit':
        p.outro('Bye');
        return;
    }

    // Refresh context after each action
    context = await getTuiContext();
  }
}
