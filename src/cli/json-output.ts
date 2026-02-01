let jsonMode = false;

export function isJsonMode(): boolean {
  return jsonMode;
}

export function setJsonMode(value: boolean): void {
  jsonMode = value;
}

export interface JsonEnvelope {
  success: boolean;
  command: string;
  data?: unknown;
  error?: string;
}

export function jsonOutput(envelope: JsonEnvelope): void {
  console.log(JSON.stringify(envelope, null, 2));
}

/**
 * Strip --json from args so cmd-ts doesn't see it.
 */
export function extractJsonFlag(args: string[]): { args: string[]; json: boolean } {
  const idx = args.indexOf('--json');
  if (idx === -1) return { args, json: false };
  return { args: [...args.slice(0, idx), ...args.slice(idx + 1)], json: true };
}
