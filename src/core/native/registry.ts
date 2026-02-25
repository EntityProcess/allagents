import type { ClientType } from '../../models/workspace-config.js';
import type { NativeClient } from './types.js';
import { ClaudeNativeClient } from './claude.js';
import { CopilotNativeClient } from './copilot.js';

export function getNativeClient(client: ClientType): NativeClient | null {
  switch (client) {
    case 'claude':
      return new ClaudeNativeClient();
    case 'copilot':
      return new CopilotNativeClient();
    default:
      return null;
  }
}
