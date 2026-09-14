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
export {
  CopilotNativeClient,
  parseCopilotPluginId,
  parseCopilotPluginInventory,
  type CopilotMarketplaceRegistrationInspection,
  type CopilotNativeClientOptions,
} from './copilot.js';
export {
  OmpNativeClient,
  inspectOmpMarketplaceRegistry,
  ompProfileNativeScope,
  parseOmpPluginId,
  resolveOmpMarketplacePluginSource,
  type OmpMarketplaceCatalog,
  type OmpMarketplaceCatalogPlugin,
  type OmpMarketplaceInspection,
  type OmpMarketplaceRegistryEntry,
  type OmpNativeClientOptions,
  type OmpNativeScope,
  type OmpProfileNativeScope,
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
