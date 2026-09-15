export {
  type NativeClient,
  type NativeCommandOptions,
  type NativeCommandResult,
  type NativeEffect,
  type NativeEffectAction,
  type NativeEffectData,
  type NativeEffectPhase,
  type NativeObservationStatus,
  type NativeMutationResult,
  type NativeOperationContext,
  type NativeResource,
  type NativeResourceObservation,
  type NativeResourceKind,
  type NativeScope,
  type NativeSourceResolution,
  type NativeSyncResult,
  executeCommand,
  mergeNativeSyncResults,
  sanitizeNativeError,
  sanitizeNativeProvenance,
  toNativeEffectData,
} from './types.js';
export { ClaudeNativeClient } from './claude.js';
export { CopilotNativeClient } from './copilot.js';
export {
  OmpNativeClient,
  inspectOmpMarketplaceRegistry,
  parseOmpPluginId,
  type OmpMarketplaceCatalog,
  type OmpMarketplaceCatalogPlugin,
  type OmpMarketplaceInspection,
  type OmpMarketplaceRegistryEntry,
  type OmpNativeClientOptions,
} from './omp.js';
export {
  PiNativeClient,
  inspectPiProjectTrust,
  normalizePiPackageSource,
  readPiSettings,
  type PiNativeClientOptions,
  type PiNormalizedSource,
  type PiPackageEntry,
  type PiProjectTrustInspection,
  type PiProjectTrustStatus,
  type PiSettings,
} from './pi.js';
export {
  inspectPiMcpAdapter,
  isPiMcpAdapterSource,
  type PiMcpAdapterClassification,
  type PiMcpAdapterInspection,
} from './pi-mcp.js';
export { getNativeClient } from './registry.js';
