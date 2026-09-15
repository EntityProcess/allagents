import { join, resolve, sep } from 'node:path';
import {
  inspectOmpMarketplaceRegistry,
  parseOmpPluginId,
} from '../native/index.js';
import { parseMarketplaceManifest } from '../../utils/marketplace-manifest-parser.js';
import { resolveProfileFileSource } from './source.js';
import type {
  ProfileClientContext,
  ProfileNativeMetadataOptions,
  ProfileResolvedPlugin,
} from './types.js';

export async function resolveOmpProfileMetadata(
  plugin: ProfileResolvedPlugin,
  context: ProfileClientContext,
  options: ProfileNativeMetadataOptions,
): Promise<ProfileResolvedPlugin> {
  const exact = parseOmpPluginId(plugin.source);
  if (exact) {
    const registry = await inspectOmpMarketplaceRegistry(
      context.operationContext,
      { allowMissing: true },
    );
    if (!registry.success) {
      throw new Error(
        registry.error ??
          'Could not inspect the selected OMP profile marketplace registry',
      );
    }
    const marketplace = registry.marketplaces.find(
      (candidate) => candidate.name === exact.marketplace,
    );
    const catalogMatches =
      marketplace?.catalog.plugins.filter(
        (candidate) => candidate.name === exact.name,
      ) ?? [];
    if (!marketplace || catalogMatches.length !== 1) {
      throw new Error(
        `OMP plugin '${plugin.source}' is not an authoritative single catalog identity in the selected profile`,
      );
    }
    return Object.freeze({
      ...plugin,
      marketplace: marketplace.name,
      pluginName: exact.name,
      path: marketplace.catalogPath,
      marketplaceSource: marketplace.sourceUri,
    });
  }

  const source = await resolveProfileFileSource(
    { ...plugin, install: 'file' },
    options,
  );
  try {
    const catalog = await parseMarketplaceManifest(source.path);
    if (!catalog.success) throw new Error(catalog.error);
    if (catalog.data.plugins.length !== 1 || !catalog.data.plugins[0]) {
      throw new Error(
        `OMP marketplace source '${plugin.source}' must expose exactly one catalog plugin`,
      );
    }
    const registry = await inspectOmpMarketplaceRegistry(
      context.operationContext,
      { allowMissing: true },
    );
    if (!registry.success) {
      throw new Error(
        registry.error ??
          'Could not inspect the selected OMP profile marketplace registry',
      );
    }
    const candidate = resolve(source.path);
    const marketplaceCacheRoot = resolve(
      join(options.homeDir, '.allagents', 'plugins', 'marketplaces'),
    );
    const registrationSource =
      candidate === marketplaceCacheRoot ||
      candidate.startsWith(`${marketplaceCacheRoot}${sep}`)
        ? candidate
        : source.source;
    return Object.freeze({
      ...plugin,
      marketplace: catalog.data.name,
      pluginName: catalog.data.plugins[0].name,
      path: source.path,
      marketplaceSource: registrationSource,
      marketplaceRegistrationManaged: !registry.marketplaces.some(
        ({ name }) => name === catalog.data.name,
      ),
      ...(source.resolvedRef && { resolvedRef: source.resolvedRef }),
      ...(source.resolvedSha && { resolvedSha: source.resolvedSha }),
    });
  } finally {
    await source.cleanup?.();
  }
}
