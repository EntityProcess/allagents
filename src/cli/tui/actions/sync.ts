import * as p from '@clack/prompts';
import { syncUserWorkspace, syncWorkspace } from '../../../core/sync.js';
import { formatVerboseSyncLines } from '../../format-sync.js';
import type { TuiContext } from '../context.js';

/**
 * Sync plugins with progress display.
 * Syncs project-scope plugins (if workspace exists) and user-scope plugins.
 * Uses a single spinner with message updates for both scopes.
 */
export async function runSync(context: TuiContext): Promise<void> {
  try {
    const s = p.spinner();
    let projectLines: string[] | undefined;

    // Sync project-level plugins if workspace exists
    if (context.hasWorkspace && context.workspacePath) {
      s.start('Syncing project plugins...');
      const result = await syncWorkspace(context.workspacePath);

      if (result.error) {
        if (context.userPluginCount > 0) {
          s.message('Syncing user plugins...');
        } else {
          s.stop('Sync failed');
        }
        p.note(result.error, 'Sync Error');
      } else {
        projectLines = formatVerboseSyncLines(result);
        if (context.userPluginCount > 0) {
          s.message('Syncing user plugins...');
        } else {
          s.stop('Sync complete');
          p.note(projectLines.join('\n'), 'Project Sync');
          return;
        }
      }
    }

    // Sync user-level plugins
    if (context.userPluginCount > 0) {
      if (!context.hasWorkspace || !context.workspacePath) {
        s.start('Syncing user plugins...');
      }
      const userResult = await syncUserWorkspace();
      s.stop('Sync complete');

      // Show project results first (deferred from above)
      if (projectLines) {
        p.note(projectLines.join('\n'), 'Project Sync');
      }

      if (userResult.error) {
        p.note(userResult.error, 'User Sync Error');
      } else {
        const lines = formatVerboseSyncLines(userResult);
        p.note(lines.join('\n'), 'User Sync');
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    p.note(message, 'Error');
  }
}
