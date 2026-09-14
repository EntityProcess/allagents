import type { ClientType } from '../../../models/workspace-config.js';
import type { ProfileAdapter } from '../types.js';
import { copilotProfileAdapter } from './copilot.js';
import { codexProfileAdapter } from './codex.js';
import { ompProfileAdapter } from './omp.js';
import { openCodeProfileAdapter } from './opencode.js';
import { piProfileAdapter } from './pi.js';

const PROFILE_ADAPTERS: Readonly<Partial<Record<ClientType, ProfileAdapter>>> =
  Object.freeze({
    copilot: copilotProfileAdapter,
    codex: codexProfileAdapter,
    pi: piProfileAdapter,
    omp: ompProfileAdapter,
    opencode: openCodeProfileAdapter,
  });

export function getProfileAdapter(client: ClientType): ProfileAdapter | null {
  return PROFILE_ADAPTERS[client] ?? null;
}

export {
  CopilotProfileAdapter,
  copilotProfileAdapter,
} from './copilot.js';
export { CodexProfileAdapter, codexProfileAdapter } from './codex.js';
export { OmpProfileAdapter, ompProfileAdapter } from './omp.js';
export {
  OpenCodeProfileAdapter,
  openCodeProfileAdapter,
} from './opencode.js';
export { PiProfileAdapter, piProfileAdapter } from './pi.js';
