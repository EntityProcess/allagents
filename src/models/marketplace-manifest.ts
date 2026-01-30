import { z } from 'zod';

/**
 * URL source object for plugins hosted externally
 * e.g. { source: "url", url: "https://github.com/figma/mcp-server-guide.git" }
 */
export const UrlSourceSchema = z.object({
  source: z.literal('url'),
  url: z.string().url(),
});

export type UrlSource = z.infer<typeof UrlSourceSchema>;

/**
 * Plugin source: either a relative path string or a URL source object
 */
export const PluginSourceRefSchema = z.union([z.string(), UrlSourceSchema]);

export type PluginSourceRef = z.infer<typeof PluginSourceRefSchema>;

/**
 * Author/owner contact info
 */
export const ContactSchema = z.object({
  name: z.string(),
  email: z.string().optional(),
});

export type Contact = z.infer<typeof ContactSchema>;

/**
 * LSP server configuration within a plugin
 */
export const LspServerSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).optional(),
  extensionToLanguage: z.record(z.string()).optional(),
  startupTimeout: z.number().optional(),
});

export type LspServer = z.infer<typeof LspServerSchema>;

/**
 * A plugin entry in marketplace.json
 */
export const MarketplacePluginEntrySchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  source: PluginSourceRefSchema,
  version: z.string().optional(),
  author: ContactSchema.optional(),
  category: z.string().optional(),
  homepage: z.string().optional(),
  strict: z.boolean().optional(),
  tags: z.array(z.string()).optional(),
  lspServers: z.record(LspServerSchema).optional(),
});

export type MarketplacePluginEntry = z.infer<typeof MarketplacePluginEntrySchema>;

/**
 * Top-level marketplace.json schema
 */
export const MarketplaceManifestSchema = z.object({
  $schema: z.string().optional(),
  name: z.string().min(1),
  version: z.string().optional(),
  description: z.string().min(1),
  owner: ContactSchema.optional(),
  plugins: z.array(MarketplacePluginEntrySchema),
});

export type MarketplaceManifest = z.infer<typeof MarketplaceManifestSchema>;
