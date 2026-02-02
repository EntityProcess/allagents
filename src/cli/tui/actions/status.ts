import * as p from '@clack/prompts';
import { getWorkspaceStatus } from '../../../core/status.js';

/**
 * Display workspace and plugin status.
 * Shows plugin availability and configured clients.
 */
export async function runStatus(): Promise<void> {
  try {
    const status = await getWorkspaceStatus();

    if (!status.success) {
      p.note(status.error ?? 'Unknown error', 'Status Error');
      return;
    }

    const lines: string[] = [];

    if (status.plugins.length === 0) {
      lines.push('No plugins configured');
    } else {
      lines.push('Plugins:');
      for (const plugin of status.plugins) {
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
