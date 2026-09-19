import * as p from '@clack/prompts';
import type {
  InstallTargetEnvironment,
  InstallTargetPromptPort,
  InstallTargetSummary,
} from '../install-target.js';
import { buildClientOptions } from './prompt-clients.js';

const dispositionLabels = {
  initialize: 'initializes scope defaults',
  inherit: 'inherits scope defaults',
  override: 'plugin override',
} as const;

export function getInstallTargetEnvironment(json: boolean): InstallTargetEnvironment {
  return {
    json,
    ci: p.isCI(),
    stdinIsTTY: Boolean(process.stdin.isTTY),
    stdoutIsTTY: Boolean(process.stdout.isTTY),
  };
}

export function isInteractiveInstallEnvironment(
  environment: InstallTargetEnvironment,
): boolean {
  return (
    !environment.json &&
    !environment.ci &&
    environment.stdinIsTTY &&
    environment.stdoutIsTTY
  );
}

export function formatInstallTargetSummary(summary: InstallTargetSummary): string {
  const methods = new Map(
    summary.effectiveMethods.map(({ client, method }) => [client, method]),
  );
  const clients = summary.clients
    .map((client) => `${client} (${methods.get(client) ?? 'file'})`)
    .join(', ');
  const scope = summary.scope === 'project' ? 'Project' : 'User';

  return [
    `${summary.action}: ${summary.payload}`,
    `Scope: ${scope} — ${summary.configPath}`,
    `Clients: ${clients}`,
    `Targeting: ${dispositionLabels[summary.disposition]}`,
  ].join('\n');
}

export function createClackInstallTargetPromptPort(): InstallTargetPromptPort {
  return {
    async selectScope(request) {
      if (request.aliasNotice) {
        p.note(request.aliasNotice, 'Install scope');
      }
      const selected = await p.select({
        message: 'Install scope',
        options: request.options.map((option) => ({
          label: `${option.scope === 'project' ? 'Project' : 'User'} — ${option.description}`,
          value: option.scope,
          hint: option.configPath,
        })),
        initialValue: request.initialValue,
      });
      return p.isCancel(selected) ? null : selected;
    },

    async selectClients(request) {
      const selected = await p.autocompleteMultiselect<string>({
        message: `Clients for ${request.scope} scope`,
        options: buildClientOptions(request.scope, request.configuredClients),
        initialValues: [...request.initialValues],
        required: true,
      });
      return p.isCancel(selected) ? null : selected;
    },

    showSummary(summary) {
      p.note(formatInstallTargetSummary(summary), 'Install summary');
    },

    async confirm(request) {
      const confirmed = await p.confirm({
        message: 'Install with this target?',
        initialValue: request.initialValue,
      });
      return p.isCancel(confirmed) ? null : confirmed;
    },
  };
}
