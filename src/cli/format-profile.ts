import type {
  ProfileApplyResult,
  ProfileApplyStep,
  ProfilePlan,
  ProfilePlanCommand,
  ProfilePlanStep,
  ProfileStatusResult,
} from '../core/profile/index.js';
import { terminalSafe } from './terminal-output.js';

export type ProfileResult = ProfileApplyResult | ProfileStatusResult;

const planStatus: Record<
  ProfilePlanStep['action'],
  ProfileApplyStep['status']
> = {
  create: 'created',
  update: 'updated',
  remove: 'removed',
  unchanged: 'unchanged',
  reference: 'referenced',
  retain: 'retained',
};

const statusMarker: Record<ProfileApplyStep['status'], string> = {
  created: '+',
  updated: '~',
  removed: '-',
  unchanged: '=',
  referenced: '>',
  retained: '!',
  failed: 'x',
};

function formatStepIdentity(step: {
  readonly client: string;
  readonly kind: string;
  readonly identity: string;
}): string {
  return `${terminalSafe(step.client)} ${terminalSafe(step.kind)} ${terminalSafe(step.identity)}`;
}

function formatPlanCommand(command: ProfilePlanCommand): string {
  return JSON.stringify([
    terminalSafe(command.command),
    ...command.args.map((argument) => terminalSafe(argument)),
  ]);
}

function formatPlanStep(step: ProfilePlanStep): string[] {
  const status = planStatus[step.action];
  const refs = [
    step.requestedRef
      ? `requested=${terminalSafe(step.requestedRef)}`
      : undefined,
    step.resolvedRef ? `resolved=${terminalSafe(step.resolvedRef)}` : undefined,
  ].filter((value): value is string => value !== undefined);
  const lines = [
    `  ${statusMarker[status]} ${status.padEnd(10)} ${formatStepIdentity(step)}${refs.length > 0 ? ` (${refs.join(', ')})` : ''}`,
  ];
  if (!step.detail) return lines;
  if (step.detail.source) {
    lines.push(`      source: ${terminalSafe(step.detail.source)}`);
  }
  if (step.detail.skills && step.detail.skills.length > 0) {
    lines.push(
      `      skills: ${step.detail.skills.map((skill) => terminalSafe(skill)).join(', ')}`,
    );
  }
  for (const command of step.detail.commands ?? []) {
    lines.push(`      command argv: ${formatPlanCommand(command)}`);
  }
  for (const server of step.detail.mcpServers ?? []) {
    lines.push(
      `      MCP ${terminalSafe(server.name)} (${terminalSafe(server.transport)})${server.endpoint ? ` endpoint=${terminalSafe(server.endpoint)}` : ''}`,
    );
    if (server.command) {
      lines.push(`        command argv: ${formatPlanCommand(server.command)}`);
    }
    lines.push(
      `        requested secrets: ${server.requestedSecrets.length > 0 ? server.requestedSecrets.map((name) => terminalSafe(name)).join(', ') : 'none'}`,
    );
  }
  return lines;
}

function formatApplyStep(step: ProfileApplyStep): string {
  return `  ${statusMarker[step.status]} ${step.status.padEnd(10)} ${formatStepIdentity(step)}${step.error ? `: ${terminalSafe(step.error)}` : ''}`;
}

function appendWarnings(lines: string[], warnings: readonly string[]): void {
  if (warnings.length === 0) return;
  lines.push('Warnings:');
  for (const warning of warnings) {
    lines.push(`  ! ${terminalSafe(warning)}`);
  }
}
function formatPlanClients(plan: ProfilePlan): string[] {
  if (plan.clients.length === 0) return [];
  const lines = ['Clients:'];
  for (const client of plan.clients) {
    lines.push(
      `  ${terminalSafe(client.client)}: ${terminalSafe(client.mechanism)}`,
    );
    lines.push(`    config root: ${terminalSafe(client.root)}`);
    lines.push(`    agent root: ${terminalSafe(client.agentRoot)}`);
    if (client.launcher) {
      lines.push(`    launcher: ${terminalSafe(client.launcher.name)}`);
      lines.push(
        `      command argv: ${formatPlanCommand(client.launcher.command)}`,
      );
      for (const destination of client.launcher.destinations) {
        lines.push(`      destination: ${terminalSafe(destination)}`);
      }
    }
  }
  return lines;
}


/** Build the stable JSON payload for a dry-run plan. */
export function buildProfilePlanData(plan: ProfilePlan): Record<string, unknown> {
  return {
    profile: plan.profile,
    operation: plan.operation,
    status: 'planned',
    declarationDigest: plan.declarationDigest,
    clients: plan.clients,
    steps: plan.steps.map((step) => ({
      client: step.client,
      kind: step.kind,
      identity: step.identity,
      status: planStatus[step.action],
      ...(step.requestedRef ? { requestedRef: step.requestedRef } : {}),
      ...(step.resolvedRef ? { resolvedRef: step.resolvedRef } : {}),
      ...(step.detail ? { detail: step.detail } : {}),
    })),
    warnings: plan.warnings,
  };
}

/**
 * Build the stable JSON payload shared by profile commands and workspace update.
 * Only fields explicitly returned by the profile core are copied; runtime options
 * and environment values never enter the output envelope.
 */
export function buildProfileData(result: ProfileResult): Record<string, unknown> {
  const data: Record<string, unknown> = {
    profile: result.profile,
    operation: result.operation,
    status: result.status,
    steps: result.steps,
    warnings: result.warnings,
  };

  if ('declared' in result) {
    data.declared = result.declared;
    data.installed = result.installed;
    data.clients = result.clients;
    data.launchers = result.launchers;
    if (result.declarationDigest) {
      data.declarationDigest = result.declarationDigest;
    }
    if (result.stateDigest) data.stateDigest = result.stateDigest;
  }
  if (result.error) data.error = result.error;

  return data;
}

/** Format a deterministic, display-safe plan without inspecting runtime secrets. */
export function formatProfilePlan(plan: ProfilePlan): string[] {
  const lines = [
    `Profile ${terminalSafe(plan.profile)} ${terminalSafe(plan.operation)} plan`,
    `Declaration: ${terminalSafe(plan.declarationDigest)}`,
  ];
  lines.push(...formatPlanClients(plan));
  if (plan.steps.length === 0) {
    lines.push('  = unchanged  No resource changes');
  } else {
    for (const step of plan.steps) lines.push(...formatPlanStep(step));
  }
  appendWarnings(lines, plan.warnings);
  return lines;
}

/** Format apply or read-only status results for the human CLI surface. */
export function formatProfileResult(result: ProfileResult): string[] {
  const lines = [
    `Profile ${terminalSafe(result.profile)}: ${terminalSafe(result.status)}`,
  ];

  if ('declared' in result) {
    lines.push(`  Declared: ${result.declared ? 'yes' : 'no'}`);
    lines.push(`  Installed: ${result.installed ? 'yes' : 'no'}`);
  }

  for (const step of result.steps) lines.push(formatApplyStep(step));

  if ('launchers' in result && result.launchers.length > 0) {
    lines.push('Launcher PATH:');
    for (const launcher of result.launchers) {
      lines.push(
        `  ${launcher.onPath ? '+' : '!'} ${terminalSafe(launcher.name)} (${terminalSafe(launcher.client)}): ${terminalSafe(launcher.path)} ${launcher.onPath ? 'is on PATH' : 'is not on PATH'}`,
      );
    }
  }

  appendWarnings(lines, result.warnings);
  if (result.error) lines.push(`Error: ${terminalSafe(result.error)}`);
  return lines;
}
