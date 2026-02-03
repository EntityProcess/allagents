import * as p from '@clack/prompts';
import { getWorkspaceStatus } from '../../../core/status.js';
import type { TuiContext } from '../context.js';

/**
 * Display workspace and plugin status.
 * Shows plugin availability and configured clients.
 */
export async function runStatus(context: TuiContext): Promise<void> {
  try {
    const status = await getWorkspaceStatus(context.workspacePath ?? undefined);

    if (!status.success) {
      p.note(status.error ?? 'Unknown error', 'Status Error');
      return;
    }

    const lines: string[] = [];

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

    p.note(lines.join('\n'), 'Workspace Status');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    p.note(message, 'Error');
  }
}
