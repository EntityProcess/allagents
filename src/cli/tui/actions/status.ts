import * as p from '@clack/prompts';
import { getWorkspaceStatus } from '../../../core/status.js';
import { runInit } from './init.js';
import type { TuiContext } from '../context.js';
import type { TuiCache } from '../cache.js';

const { select } = p;

/**
 * Display workspace and plugin status.
 * Shows plugin availability and configured clients.
 * When no workspace exists, offers to initialize one.
 */
export async function runStatus(context: TuiContext, cache?: TuiCache): Promise<void> {
  try {
    let status = cache?.getStatus();
    if (!status) {
      status = await getWorkspaceStatus(context.workspacePath ?? undefined);
      cache?.setStatus(status);
    }

    if (!status.success) {
      p.note(status.error ?? 'Unknown error', 'Status Error');
      return;
    }

    const lines: string[] = [];

    if (context.hasWorkspace) {
      lines.push(`Workspace: ${context.workspacePath}`);
    } else {
      lines.push('No workspace detected');
    }

    lines.push('');

    const userPlugins = status.userPlugins ?? [];
    const hasProjectPlugins = status.plugins.length > 0;
    const hasUserPlugins = userPlugins.length > 0;

    if (!hasProjectPlugins && !hasUserPlugins) {
      lines.push('No plugins configured');
    }

    if (hasProjectPlugins) {
      lines.push('Project plugins:');
      for (const plugin of status.plugins) {
        const icon = plugin.available ? '\u2713' : '\u2717';
        lines.push(`  ${icon} ${plugin.source} (${plugin.type})`);
      }
    }

    if (hasUserPlugins) {
      if (hasProjectPlugins) lines.push('');
      lines.push('User plugins:');
      for (const plugin of userPlugins) {
        const icon = plugin.available ? '\u2713' : '\u2717';
        lines.push(`  ${icon} ${plugin.source} (${plugin.type})`);
      }
    }

    lines.push('');
    lines.push(`Clients: ${status.clients.length > 0 ? status.clients.join(', ') : 'none'}`);

    p.note(lines.join('\n'), 'Status');

    if (!context.hasWorkspace) {
      const action = await select({
        message: 'Options',
        options: [
          { label: 'Add workspace', value: 'init' as const },
          { label: 'Back', value: 'back' as const },
        ],
      });

      if (!p.isCancel(action) && action === 'init') {
        await runInit();
        cache?.invalidate();
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    p.note(message, 'Error');
  }
}
