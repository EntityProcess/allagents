/**
 * Command metadata type and help text builder for enriched --help output.
 */
export interface CommandMeta {
  description: string;
  whenToUse: string;
  examples: string[];
  expectedOutput: string;
}

/**
 * Build an enriched description string from structured command metadata.
 * The result is used as the `description` field in cmd-ts command definitions,
 * so that --help output includes examples, when-to-use, and expected output.
 */
export function buildDescription(meta: CommandMeta): string {
  let desc = meta.description;
  desc += `\n\nWhen to use: ${meta.whenToUse}`;
  desc += '\n\nExamples:';
  for (const ex of meta.examples) {
    desc += `\n  $ ${ex}`;
  }
  desc += `\n\nOutput: ${meta.expectedOutput}`;
  return desc;
}
