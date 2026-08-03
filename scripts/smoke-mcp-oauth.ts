#!/usr/bin/env bun
import { connectToMcpProxy } from '../tests/helpers/mcp-proxy-client.ts';

interface ParsedArgs {
  serverUrl: string;
  question: string;
  tool?: string;
}

const USAGE =
  'Usage: bun run smoke:mcp-oauth <server-url> [question] [--tool <name>]';

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  let tool: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--tool') {
      tool = argv[++i];
    } else {
      positionals.push(arg ?? '');
    }
  }

  const serverUrl = positionals[0];
  if (!serverUrl) {
    console.error(USAGE);
    console.error(
      'Provide the URL of any OAuth-protected remote MCP server you want to smoke-test — none is hardcoded here on purpose.',
    );
    process.exit(1);
  }

  return {
    serverUrl,
    question: positionals[1] ?? 'how to rename a company branch',
    tool,
  };
}

const QUESTION_KEYS = ['question', 'query', 'q', 'prompt', 'text'];

interface JsonSchemaProperty {
  type?: string;
  minLength?: number;
  items?: { enum?: unknown[] };
}

function defaultValueForProperty(
  propSchema: JsonSchemaProperty | undefined,
  question: string,
): unknown {
  switch (propSchema?.type) {
    case 'array': {
      const enumValues = propSchema.items?.enum;
      return Array.isArray(enumValues) && enumValues.length > 0
        ? [enumValues[0]]
        : [];
    }
    case 'boolean':
      return false;
    case 'number':
    case 'integer':
      return 1;
    case 'object':
      return {};
    default:
      return (propSchema?.minLength ?? 0) > 0
        ? `Automated smoke test — answering: ${question}`
        : '';
  }
}

/**
 * Fills every required property, not just a guessed "question" field — real tools
 * (e.g. this server's search-knowledge-digested) require auxiliary fields like
 * "explanation" or "sources" alongside the query itself, some with minLength/minItems
 * constraints that plain empty defaults would fail.
 */
function buildToolArguments(
  inputSchema: unknown,
  question: string,
): Record<string, unknown> {
  const schema =
    inputSchema && typeof inputSchema === 'object' ? inputSchema : undefined;
  const properties =
    schema && 'properties' in schema && schema.properties && typeof schema.properties === 'object'
      ? (schema.properties as Record<string, JsonSchemaProperty>)
      : undefined;
  const required =
    schema && 'required' in schema && Array.isArray((schema as { required: unknown }).required)
      ? ((schema as { required: string[] }).required as string[])
      : [];

  if (!properties) return { question };

  const args: Record<string, unknown> = {};
  const questionKey =
    QUESTION_KEYS.find((key) => key in properties) ?? required[0];
  if (questionKey) args[questionKey] = question;

  for (const key of required) {
    if (key in args) continue;
    args[key] = defaultValueForProperty(properties[key], question);
  }

  return args;
}

function pickTool(
  tools: Array<{ name: string; description?: string; inputSchema?: unknown }>,
  requested: string | undefined,
): (typeof tools)[number] {
  if (requested) {
    const match = tools.find((t) => t.name === requested);
    if (!match) {
      throw new Error(
        `Tool '${requested}' not found. Available: ${tools.map((t) => t.name).join(', ')}`,
      );
    }
    return match;
  }

  if (tools.length === 1) {
    return tools[0] as (typeof tools)[number];
  }

  const byPreference = [/digest/i, /ask/i, /search|query|question|knowledge/i];
  for (const pattern of byPreference) {
    const match = tools.find((t) => pattern.test(t.name));
    if (match) return match;
  }

  throw new Error(
    `Multiple tools available and none matched a search/ask heuristic. Pass --tool <name>. Available: ${tools
      .map((t) => t.name)
      .join(', ')}`,
  );
}

async function main() {
  const { serverUrl, question, tool } = parseArgs(process.argv.slice(2));

  console.log(`Connecting to ${serverUrl} via 'allagents mcp proxy'...`);
  console.log(
    'If this server requires OAuth, a browser window will open — complete the login there, then return here.',
  );

  const connection = await connectToMcpProxy({
    serverUrl,
    onAuthorizationUrl: (url) => {
      console.log(`Authorization URL (in case the browser didn't open): ${url}`);
    },
  });

  try {
    console.log('Connected. Listing tools...');
    const { tools } = await connection.client.listTools();
    console.log(
      `Available tools: ${tools.map((t) => t.name).join(', ') || '(none)'}`,
    );

    const selected = pickTool(tools, tool);
    console.log(
      `Selected tool '${selected.name}'. Input schema: ${JSON.stringify(selected.inputSchema)}`,
    );
    const args = buildToolArguments(selected.inputSchema, question);
    console.log(
      `Calling tool '${selected.name}' with arguments ${JSON.stringify(args)}...`,
    );

    const result = await connection.client.callTool({
      name: selected.name,
      arguments: args,
    });

    console.log('\n--- Response ---');
    console.log(JSON.stringify(result, null, 2));
    console.log('----------------\n');
    console.log(
      'Smoke test complete. Re-run this script again to confirm no second OAuth prompt appears (cached token reused).',
    );
  } finally {
    await connection.close();
  }
}

main().catch((error) => {
  console.error('Smoke test failed:', error instanceof Error ? error.message : error);
  console.error(
    "If this looks like a stale OAuth cache, inspect/clear the relevant directory under '~/.allagents/oauth-proxy/'.",
  );
  process.exit(1);
});
