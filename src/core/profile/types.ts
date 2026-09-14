import type { ClientMapping } from '../../models/client-mapping.js';
import type {
  ClientType,
  InstallMode,
  McpServerConfig,
  PluginSkillsConfig,
} from '../../models/workspace-config.js';
import type {
  NativeClient,
  NativeOperationContext,
  NativeSourceResolution,
} from '../native/types.js';

export interface ProfileAdapterCapabilities {
  readonly nativeInstall: boolean;
  readonly fileInstall: boolean;
  readonly launchers: boolean;
  readonly skillFilters: boolean;
  readonly mcp: boolean;
  readonly settings: boolean;
  readonly status: boolean;
  readonly cleanup: boolean;
}

export interface ProfileLauncherInvocation {
  readonly command: string;
  readonly args: readonly string[];
  /** Undefined explicitly removes an inherited ambient selector. */
  readonly env: Readonly<Record<string, string | undefined>>;
}

export interface ProfileContextOptions {
  readonly homeDir: string;
  /** Relative native sources are resolved from this user-selected workspace. */
  readonly workspaceDirectory: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
}

export interface ProfileClientContext {
  readonly profileName: string;
  readonly client: ClientType;
  readonly mechanism: string;
  /** Absolute agent/config root which bounds all profile file materialization. */
  readonly root: string;
  readonly operationContext: NativeOperationContext;
  /** Paths are relative to root; absolute profile mappings are invalid. */
  readonly fileMapping: Readonly<ClientMapping>;
  readonly launcher: ProfileLauncherInvocation;
}

export interface ProfileResolvedPlugin {
  readonly declarationIndex: number;
  readonly source: string;
  readonly requestedRef?: string;
  readonly resolvedRef?: string;
  readonly resolvedSha?: string;
  readonly path?: string;
  readonly marketplace?: string;
  readonly pluginName?: string;
  readonly install: InstallMode;
  readonly skills?: PluginSkillsConfig;
  readonly clients?: readonly ClientType[];
}

export interface ProfilePlannedFile {
  readonly key: string;
  readonly client: ClientType;
  readonly kind: 'settings' | 'mcp';
  readonly path: string;
  readonly content: string;
  readonly mode: number;
}

export interface ProfileSerializationInput {
  readonly plugins: readonly ProfileResolvedPlugin[];
  readonly settings?: Readonly<Record<string, unknown>>;
  readonly mcpServers?: Readonly<Record<string, McpServerConfig>>;
}

/**
 * Deep profile seam. Runtime-specific roots, selectors, serialization, and
 * native lifecycle remain inside the adapter; orchestration consumes only this
 * immutable context and exact planned bytes.
 */
export interface ProfileAdapter {
  readonly client: ClientType;
  readonly capabilities: ProfileAdapterCapabilities;
  readonly nativeClient: NativeClient;

  resolveContext(
    profileName: string,
    options: ProfileContextOptions,
  ): ProfileClientContext;

  resolveNativeSource(
    plugin: ProfileResolvedPlugin,
    context: ProfileClientContext,
  ): NativeSourceResolution;

  serializeSettings(
    context: ProfileClientContext,
    input: ProfileSerializationInput,
  ): ProfilePlannedFile | null;

  serializeMcp(
    context: ProfileClientContext,
    input: ProfileSerializationInput,
  ): ProfilePlannedFile | null;
}
