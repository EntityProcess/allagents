import { isAbsolute, join, resolve, sep } from 'node:path';
import type { CopilotNativeClient } from '../native/index.js';
import {
  inspectOmpMarketplaceRegistry,
  parseCopilotPluginId,
  parseOmpPluginId,
} from '../native/index.js';
import { parseMarketplaceManifest } from '../../utils/marketplace-manifest-parser.js';
import { isGitHubUrl, parseGitHubUrl } from '../../utils/plugin-path.js';
import { resolveProfileFileSource } from './source.js';
import type {
  ProfileClientContext,
  ProfileNativeMetadataOptions,
  ProfileResolvedPlugin,
} from './types.js';

const COPILOT_BUILTIN_MARKETPLACES: Readonly<Record<string, true>> = {
  'copilot-plugins': true,
  'awesome-copilot': true,
};

function normalizedMarketplaceSource(source: string): string {
  if (isAbsolute(source)) return `directory:${resolve(source)}`;
  const parsed = isGitHubUrl(source) ? parseGitHubUrl(source) : null;
  if (parsed) {
    return [
      'github',
      `${parsed.owner}/${parsed.repo}`.toLowerCase(),
      parsed.branch ?? '',
      parsed.subpath ?? '',
    ].join(':');
  }
  return `git:${source.replace(/\.git$/i, '').toLowerCase()}`;
}

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

export async function resolveCopilotProfileMetadata(
  plugin: ProfileResolvedPlugin,
  context: ProfileClientContext,
  options: ProfileNativeMetadataOptions,
  nativeClient: CopilotNativeClient,
): Promise<ProfileResolvedPlugin> {
  const exact = parseCopilotPluginId(plugin.source);
  if (exact) {
    if (plugin.requestedRef || plugin.resolvedRef) {
      throw new Error(
        `Copilot plugin identity '${plugin.source}' cannot enforce a marketplace ref`,
      );
    }
    const registration = await nativeClient.inspectMarketplaceRegistration(
      exact.marketplace,
      context.operationContext,
    );
    if (!registration.success) {
      throw new Error(
        registration.error ??
          'Could not inspect the selected Copilot profile marketplace registry',
      );
    }
    if (!registration.present) {
      throw new Error(
        `Copilot plugin '${plugin.source}' references an unregistered marketplace`,
      );
    }
    const catalog = await nativeClient.inspectMarketplacePlugin(
      exact.marketplace,
      exact.plugin,
      context.operationContext,
    );
    if (!catalog.success || !catalog.present) {
      throw new Error(
        catalog.error ??
          `Copilot plugin '${plugin.source}' is not an authoritative catalog identity`,
      );
    }
    let marketplaceSource: string | undefined;
    if (!COPILOT_BUILTIN_MARKETPLACES[exact.marketplace]) {
      if (!registration.source) {
        throw new Error(
          `Copilot marketplace '${exact.marketplace}' did not report its registration source`,
        );
      }
      marketplaceSource = registration.source;
    }
    return Object.freeze({
      ...plugin,
      marketplace: exact.marketplace,
      pluginName: exact.plugin,
      ...(marketplaceSource && { marketplaceSource }),
    });
  }
  if (plugin.requestedRef || plugin.resolvedRef) {
    throw new Error(
      `Copilot native marketplace installation cannot enforce ref '${plugin.requestedRef ?? plugin.resolvedRef}'`,
    );
  }

  const source = await resolveProfileFileSource(
    { ...plugin, install: 'file' },
    options,
  );
  if (source.resolvedRef) {
    await source.cleanup?.();
    throw new Error(
      `Copilot native marketplace installation cannot enforce ref '${source.resolvedRef}'`,
    );
  }
  try {
    const catalog = await parseMarketplaceManifest(source.path);
    if (!catalog.success) throw new Error(catalog.error);
    if (catalog.data.plugins.length !== 1 || !catalog.data.plugins[0]) {
      throw new Error(
        `Copilot marketplace source '${plugin.source}' must expose exactly one catalog plugin`,
      );
    }
    const registration = await nativeClient.inspectMarketplaceRegistration(
      catalog.data.name,
      context.operationContext,
    );
    if (!registration.success) {
      throw new Error(
        registration.error ??
          'Could not inspect the selected Copilot profile marketplace registry',
      );
    }
    const registrationSource = isGitHubUrl(source.source)
      ? source.source
      : resolve(source.path);
    if (registration.present) {
      if (
        registration.source &&
        normalizedMarketplaceSource(registration.source) !==
          normalizedMarketplaceSource(registrationSource)
      ) {
        throw new Error(
          `Copilot marketplace '${catalog.data.name}' is already registered from a different source`,
        );
      }
      const liveCatalog = await nativeClient.inspectMarketplacePlugin(
        catalog.data.name,
        catalog.data.plugins[0].name,
        context.operationContext,
      );
      if (!liveCatalog.success || !liveCatalog.present) {
        throw new Error(
          liveCatalog.error ??
            `Copilot marketplace '${catalog.data.name}' does not expose plugin '${catalog.data.plugins[0].name}'`,
        );
      }
    }
    return Object.freeze({
      ...plugin,
      marketplace: catalog.data.name,
      pluginName: catalog.data.plugins[0].name,
      path: source.path,
      marketplaceSource: registration.source ?? registrationSource,
      marketplaceRegistrationManaged: !registration.present,
      ...(source.resolvedRef && { resolvedRef: source.resolvedRef }),
      ...(source.resolvedSha && { resolvedSha: source.resolvedSha }),
    });
  } finally {
    await source.cleanup?.();
  }
}
