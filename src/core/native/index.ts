export { type NativeClient, type NativeCommandResult, type NativeSyncResult, executeCommand, mergeNativeSyncResults } from './types.js';
export { ClaudeNativeClient } from './claude.js';
export { CopilotNativeClient } from './copilot.js';
export { getNativeClient } from './registry.js';
