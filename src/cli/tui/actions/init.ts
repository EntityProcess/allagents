import * as p from '@clack/prompts';
import { initWorkspace } from '../../../core/workspace.js';
import { ClientTypeSchema } from '../../../models/workspace-config.js';

const { text, multiselect } = p;

/**
 * Guided workspace initialization action.
 * Prompts user for path, optional template source, and client selection, then runs initWorkspace.
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

    // Client selection - all supported clients except vscode (it's a workspace generator, not an AI client)
    const allClients = ClientTypeSchema.options.filter((c) => c !== 'vscode');
    const defaultClients = ['claude', 'copilot', 'codex', 'opencode'];

    const selectedClients = await multiselect({
      message: 'Which AI clients do you use?',
      options: allClients.map((c) => ({
        label: c,
        value: c,
      })),
      initialValues: defaultClients,
      required: false,
    });

    if (p.isCancel(selectedClients)) {
      return;
    }

    const s = p.spinner();
    s.start('Initializing workspace...');

    const options: Parameters<typeof initWorkspace>[1] = {
      ...(fromSource ? { from: fromSource } : {}),
      ...(selectedClients.length > 0 ? { clients: selectedClients } : {}),
    };
    const result = await initWorkspace(targetPath, options);

    s.stop('Workspace initialized');

    const lines = [`Path: ${result.path}`];
    if (selectedClients.length > 0) {
      lines.push(`Clients: ${selectedClients.join(', ')}`);
    }
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
