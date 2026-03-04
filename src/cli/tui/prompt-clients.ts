import * as p from '@clack/prompts';
import { ClientTypeSchema, type ClientEntry, type ClientType } from '../../models/workspace-config.js';
import { CLIENT_MAPPINGS } from '../../models/client-mapping.js';

const { groupMultiselect } = p;

interface ClientGroupsResult {
  groups: Record<string, { value: ClientType; label: string; hint?: string }[]>;
  initialValues: ClientType[];
}

/**
 * Build the two-group options structure for client selection.
 * Group 1: "Universal (.agents/skills)" — pre-selected.
 * Group 2: "Client-specific" — all other clients, unselected.
 */
export function buildClientGroups(): ClientGroupsResult {
  const allClients = ClientTypeSchema.options;

  const universalGroup = allClients
    .filter((c) => c === 'universal')
    .map((c) => ({ value: c, label: c, hint: CLIENT_MAPPINGS[c].skillsPath }));

  const clientSpecificGroup = allClients
    .filter((c) => c !== 'universal')
    .map((c) => ({ value: c, label: c, hint: CLIENT_MAPPINGS[c].skillsPath }));

  return {
    groups: {
      'Universal (.agents/skills)': universalGroup,
      'Client-specific': clientSpecificGroup,
    },
    initialValues: ['universal'],
  };
}

/**
 * Check if the current environment supports interactive prompts.
 */
export function isInteractive(): boolean {
  if (p.isCI()) return false;
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/**
 * Prompt the user to select AI clients using a grouped multiselect.
 * Returns selected clients, or null if cancelled.
 * In non-interactive mode, returns ['universal'] without prompting.
 * If user deselects everything, falls back to ['universal'].
 */
export async function promptForClients(): Promise<ClientEntry[] | null> {
  if (!isInteractive()) {
    return ['universal'];
  }

  const { groups, initialValues } = buildClientGroups();

  const selected = await groupMultiselect({
    message: 'Which AI clients do you use?',
    options: groups,
    initialValues,
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
