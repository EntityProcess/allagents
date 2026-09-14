import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import Ajv from 'ajv';
import { load } from 'js-yaml';
import { generateWorkspaceSchemas } from '../../../scripts/generate-workspace-schemas.js';
import {
  ProjectWorkspaceConfigSchema,
  UserWorkspaceConfigSchema,
} from '../../../src/models/workspace-config.js';

function parsedYaml(source: string): unknown {
  return load(source);
}
describe('published workspace JSON Schemas', () => {
  test('validates real user and project workspace YAML by scope', async () => {
    const schemaEntries = generateWorkspaceSchemas();
    const generated = new Map(
      await Promise.all(
        schemaEntries.map(async (schema) => [
          schema.fileName,
          JSON.parse(await readFile(schema.path, 'utf8')),
        ] as const),
      ),
    );
    for (const schema of schemaEntries) {
      expect(generated.get(schema.fileName).$id).toBe(schema.url);
    }
    const ajv = new Ajv({ allErrors: true, strict: false });
    const validateUser = ajv.compile(
      generated.get('user-workspace.schema.json'),
    );
    const validateProject = ajv.compile(
      generated.get('project-workspace.schema.json'),
    );

    const userWorkspace = parsedYaml(`
profiles:
  review:
    clients:
      - name: claude
        launcher: claude-review
        settings:
          model: sonnet
          effortLevel: xhigh
      - name: codex
        install: native
        settings:
          approval_policy: on-request
    plugins:
      - source: owner/review-tools
        ref: stable
        skills:
          exclude: [legacy]
    mcpServers:
      review:
        command: review-mcp
        env:
          REVIEW_TOKEN: \${REVIEW_TOKEN}
`);
    const projectWorkspace = parsedYaml(`
repositories: []
plugins:
  - source: owner/project-tools
    ref: main
clients:
  - name: claude
    install: native
`);
    const projectWithProfiles = parsedYaml(`
repositories: []
plugins: []
clients: []
profiles:
  review:
    clients:
      - name: claude
`);
    const userWithUnknownSettings = parsedYaml(`
profiles:
  review:
    clients:
      - name: claude
        settings:
          unknownSetting: true
`);
    const userWithInvalidClientShorthand = parsedYaml(`
clients:
  - claude:bogus
`);
    const userWithInvalidProfileName = parsedYaml(`
profiles:
  ../escape:
    clients:
      - name: claude
`);

    expect(validateUser(userWorkspace)).toBe(true);
    expect(UserWorkspaceConfigSchema.safeParse(userWorkspace).success).toBe(
      true,
    );
    expect(validateProject(projectWorkspace)).toBe(true);
    expect(
      ProjectWorkspaceConfigSchema.safeParse(projectWorkspace).success,
    ).toBe(true);
    expect(validateProject(projectWithProfiles)).toBe(false);
    expect(
      ProjectWorkspaceConfigSchema.safeParse(projectWithProfiles).success,
    ).toBe(false);
    expect(validateUser(userWithUnknownSettings)).toBe(false);
    expect(
      UserWorkspaceConfigSchema.safeParse(userWithUnknownSettings).success,
    ).toBe(false);
    expect(validateUser(userWithInvalidClientShorthand)).toBe(false);
    expect(
      UserWorkspaceConfigSchema.safeParse(userWithInvalidClientShorthand)
        .success,
    ).toBe(false);
    expect(validateUser(userWithInvalidProfileName)).toBe(false);
    expect(
      UserWorkspaceConfigSchema.safeParse(userWithInvalidProfileName).success,
    ).toBe(false);
  });
});
