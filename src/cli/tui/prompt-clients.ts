import * as p from '@clack/prompts';
import { ClientTypeSchema, type ClientEntry, type ClientType } from '../../models/workspace-config.js';
import { CLIENT_MAPPINGS } from '../../models/client-mapping.js';

const { autocompleteMultiselect } = p;

/**
 * Build a flat options list for searchable client selection.
 * Each option includes the skills path as a hint.
 */
export function buildClientOptions(): { value: ClientType; label: string; hint?: string }[] {
  return ClientTypeSchema.options.map((c) => ({
    value: c,
    label: c,
    hint: CLIENT_MAPPINGS[c].skillsPath,
  }));
}

/**
 * Check if the current environment supports interactive prompts.
 */
export function isInteractive(): boolean {
  if (p.isCI()) return false;
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/**
 * Prompt the user to select AI clients using a searchable multiselect.
 * Returns selected clients, or null if cancelled.
 * In non-interactive mode, returns ['universal'] without prompting.
 * If user deselects everything, falls back to ['universal'].
 */
export async function promptForClients(): Promise<ClientEntry[] | null> {
  if (!isInteractive()) {
    return ['universal'];
  }

  const options = buildClientOptions();

  const selected = await autocompleteMultiselect({
    message: 'Which AI clients do you use?',
    options,
    initialValues: ['universal'] as ClientType[],
    required: false,
  });

  if (p.isCancel(selected)) {
    return null;
  }

  // Fall back to universal if user deselected everything
  if (selected.length === 0) {
    return ['universal'];
  }

  return selected as ClientEntry[];
}
