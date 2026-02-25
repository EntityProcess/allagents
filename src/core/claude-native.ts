/**
 * Re-export shim for backward compatibility.
 * The implementation has moved to src/core/native/claude.ts.
 */
import { ClaudeNativeClient } from './native/claude.js';
export type { NativeSyncResult, NativeCommandResult } from './native/types.js';

const _client = new ClaudeNativeClient();

export const toClaudePluginSpec = (source: string) => _client.toPluginSpec(source);
export const extractMarketplaceSource = (spec: string) => _client.extractMarketplaceSource(spec);
export const isClaudeCliAvailable = () => _client.isAvailable();
export const addMarketplace = (source: string, options?: { cwd?: string }) => _client.addMarketplace(source, options);
export const installPlugin = (spec: string, scope: 'user' | 'project' = 'project', options?: { cwd?: string }) => _client.installPlugin(spec, scope, options);
export const uninstallPlugin = (spec: string, scope: 'user' | 'project' = 'project', options?: { cwd?: string }) => _client.uninstallPlugin(spec, scope, options);
export const syncNativePlugins = (plugins: string[], scope: 'user' | 'project' = 'project', options?: { cwd?: string; dryRun?: boolean }) => _client.syncPlugins(plugins, scope, options);

export type { ClaudeNativeClient };
