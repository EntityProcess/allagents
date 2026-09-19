import {
  CORE_SCHEMA,
  binaryTag,
  load,
  mergeTag,
  omapTag,
  pairsTag,
  setTag,
  timestampTag,
} from 'js-yaml';

const workspaceSchema = CORE_SCHEMA.withTags(
  timestampTag,
  mergeTag,
  binaryTag,
  omapTag,
  pairsTag,
  setTag,
);

export function loadYaml(input: string): unknown {
  return load(input, { schema: workspaceSchema });
}
