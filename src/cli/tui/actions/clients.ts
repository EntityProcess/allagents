import * as p from '@clack/prompts';
import { ClientTypeSchema, type ClientType } from '../../../models/workspace-config.js';
import { setClients } from '../../../core/workspace-modify.js';
import { syncWorkspace } from '../../../core/sync.js';
import type { TuiContext } from '../context.js';
import type { TuiCache } from '../cache.js';
import { getWorkspaceStatus } from '../../../core/status.js';

const { multiselect } = p;

/**
 * Manage workspace clients - lets user toggle which AI clients are enabled.
 */
export async function runManageClients(context: TuiContext, cache?: TuiCache): Promise<void> {
  try {
    if (!context.workspacePath) {
      p.note('No workspace found. Initialize a workspace first.', 'Error');
      return;
    }

    // Get current clients from workspace status
    let status = cache?.getStatus();
    if (!status) {
      status = await getWorkspaceStatus(context.workspacePath);
      cache?.setStatus(status);
    }

    const currentClients = status.clients ?? [];

    // All supported clients except vscode
    const allClients = ClientTypeSchema.options.filter((c) => c !== 'vscode');

    const selectedClients = await multiselect({
      message: 'Select AI clients for this workspace',
      options: allClients.map((c) => ({
        label: c,
        value: c,
      })),
      initialValues: currentClients.filter((c): c is ClientType => allClients.includes(c as ClientType)),
      required: false,
    });

    if (p.isCancel(selectedClients)) {
      return;
    }

    // Check if anything changed
    const sortedCurrent = [...currentClients].sort();
    const sortedSelected = [...selectedClients].sort();
    if (JSON.stringify(sortedCurrent) === JSON.stringify(sortedSelected)) {
      p.note('No changes made.', 'Clients');
      return;
    }

    const s = p.spinner();
    s.start('Updating clients...');

    const result = await setClients(selectedClients, context.workspacePath);
    if (!result.success) {
      s.stop('Failed to update clients');
      p.note(result.error ?? 'Unknown error', 'Error');
      return;
    }

    // Re-sync after client change
    await syncWorkspace(context.workspacePath);

    s.stop('Clients updated');
    cache?.invalidate();

    p.note(`Clients: ${selectedClients.length > 0 ? selectedClients.join(', ') : 'none'}`, 'Updated');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    p.note(message, 'Error');
  }
}
