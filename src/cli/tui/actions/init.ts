import * as p from '@clack/prompts';
import { initWorkspace } from '../../../core/workspace.js';
import { text } from '../prompts.js';

/**
 * Guided workspace initialization action.
 * Prompts user for path and optional template source, then runs initWorkspace.
 */
export async function runInit(): Promise<void> {
  try {
    const targetPath = await text({
      message: 'Where should the workspace be created?',
      placeholder: '.',
      defaultValue: '.',
    });

    if (p.isCancel(targetPath)) {
      return;
    }

    const fromSource = await text({
      message: 'Template source (leave empty for default)',
      placeholder: 'GitHub URL, path, or leave empty',
      defaultValue: '',
    });

    if (p.isCancel(fromSource)) {
      return;
    }

    const s = p.spinner();
    s.start('Initializing workspace...');

    const options = fromSource ? { from: fromSource } : {};
    const result = await initWorkspace(targetPath, options);

    s.stop('Workspace initialized');

    const lines = [`Path: ${result.path}`];
    if (result.syncResult) {
      lines.push(
        `Plugins synced: ${result.syncResult.totalCopied} copied, ${result.syncResult.totalFailed} failed`,
      );
    }
    p.note(lines.join('\n'), 'Workspace Created');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    p.note(message, 'Error');
  }
}
