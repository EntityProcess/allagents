import * as p from '@clack/prompts';
import { syncWorkspace, syncUserWorkspace } from '../../../core/sync.js';
import type { TuiContext } from '../context.js';

/**
 * Sync plugins with progress display.
 * Syncs project-scope plugins (if workspace exists) and user-scope plugins.
 */
export async function runSync(context: TuiContext): Promise<void> {
  try {
    const s = p.spinner();

    // Sync project-level plugins if workspace exists
    if (context.hasWorkspace && context.workspacePath) {
      s.start('Syncing project plugins...');
      const result = await syncWorkspace(context.workspacePath);
      s.stop('Project sync complete');

      if (result.error) {
        p.note(result.error, 'Sync Error');
      } else {
        const lines = result.pluginResults.map(
          (pr) => `${pr.success ? '\u2713' : '\u2717'} ${pr.plugin}`,
        );
        lines.push('');
        lines.push(
          `Copied: ${result.totalCopied}  Failed: ${result.totalFailed}  Skipped: ${result.totalSkipped}`,
        );
        p.note(lines.join('\n'), 'Project Sync');
      }
    }

    // Sync user-level plugins
    if (context.userPluginCount > 0) {
      s.start('Syncing user plugins...');
      const userResult = await syncUserWorkspace();
      s.stop('User sync complete');

      if (userResult.error) {
        p.note(userResult.error, 'User Sync Error');
      } else {
        const lines = userResult.pluginResults.map(
          (pr) => `${pr.success ? '\u2713' : '\u2717'} ${pr.plugin}`,
        );
        lines.push('');
        lines.push(
          `Copied: ${userResult.totalCopied}  Failed: ${userResult.totalFailed}  Skipped: ${userResult.totalSkipped}`,
        );
        p.note(lines.join('\n'), 'User Sync');
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    p.note(message, 'Error');
  }
}
