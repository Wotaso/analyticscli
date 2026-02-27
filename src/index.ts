#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Command } from 'commander';
import { readCliEnv } from '@prodinfos/config';
import {
  renderHorizontalBars,
  renderTable,
  renderTimeseriesSvg,
  writeSvgToFile,
  type TimeseriesPoint,
} from './render.js';

type CliConfig = {
  apiUrl: string;
  token?: string;
  tokenStorage?: 'config_file' | 'system_keychain';
  skillAutoUpdate?: boolean;
  lastSkillSyncAt?: string;
  setupCompletedAt?: string;
  updatedAt: string;
};

type OutputFormat = 'json' | 'text';

type ClientOptions = {
  apiUrl?: string;
  token?: string;
};

type CollectClientOptions = {
  endpoint: string;
  apiKey: string;
};

type SetupAgent = 'codex' | 'claude' | 'openclaw';
type SkillInstallTarget = 'codex_claude' | 'openclaw';

type SkillInstallResult = {
  target: SkillInstallTarget;
  ok: boolean;
  skipped: boolean;
  detail: string;
};

type SetupLoginResult = {
  ok: boolean;
  skipped?: boolean;
  mode?: 'direct_token' | 'clerk_exchange' | 'existing_token';
  tokenStorage?: 'config_file' | 'system_keychain';
  tenantId?: unknown;
  projectIds?: unknown;
};

type SetupExecutionOptions = {
  token?: string;
  clerkJwt?: string;
  skipLogin?: boolean;
  skipSkills?: boolean;
  agents: SetupAgent[];
  autoSkillUpdate?: boolean;
};

type SetupExecutionResult = {
  ok: true;
  apiUrl: string;
  configPath: string;
  login: SetupLoginResult;
  skillSetup: SkillInstallResult[];
  autoSkillUpdate: boolean;
  setupCompletedAt?: string;
};

type PromptClient = {
  question: (query: string) => Promise<string>;
};

type CommandRunResult = {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

const env = readCliEnv();
const CLI_VERSION = '0.1.0';
const SKILL_ID = 'prodinfos';
const SKILL_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
const SKILL_SYNC_TIMEOUT_MS = 4000;
const OPENCLAW_SKILL_PAGE_URL = 'https://clawhub.ai/skills/prodinfos';
const KEYCHAIN_SERVICE = 'com.prodinfos.cli.token';
const KEYCHAIN_ACCOUNT = process.env.USER ?? process.env.USERNAME ?? 'default';
const SELF_TRACKING_ENDPOINT = env.PRODINFOS_SELF_TRACKING_ENDPOINT?.replace(/\/$/, '');
const SELF_TRACKING_ENABLED = Boolean(
  env.PRODINFOS_SELF_TRACKING_ENABLED &&
    SELF_TRACKING_ENDPOINT &&
    env.PRODINFOS_SELF_TRACKING_PROJECT_ID &&
    env.PRODINFOS_SELF_TRACKING_API_KEY,
);
const CLI_RUN_ID = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
const CLI_ANON_ID = `cli-${CLI_RUN_ID}`;
const CLI_SESSION_ID = `cli-session-${CLI_RUN_ID}`;

let activeCommandPath = 'unknown';
let activeCommandStartMs = Date.now();

const resolveConfigPath = (): string => {
  if (env.PRODINFOS_CONFIG_DIR) {
    return join(env.PRODINFOS_CONFIG_DIR, 'config.json');
  }

  return join(homedir(), '.config', 'prodinfos', 'config.json');
};

const configPath = resolveConfigPath();

const readConfig = async (): Promise<CliConfig> => {
  try {
    const raw = await readFile(configPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<CliConfig>;
    return {
      apiUrl: typeof parsed.apiUrl === 'string' ? parsed.apiUrl : env.PRODINFOS_API_URL,
      token: typeof parsed.token === 'string' ? parsed.token : undefined,
      tokenStorage:
        parsed.tokenStorage === 'system_keychain' || parsed.tokenStorage === 'config_file'
          ? parsed.tokenStorage
          : undefined,
      skillAutoUpdate: typeof parsed.skillAutoUpdate === 'boolean' ? parsed.skillAutoUpdate : false,
      lastSkillSyncAt: typeof parsed.lastSkillSyncAt === 'string' ? parsed.lastSkillSyncAt : undefined,
      setupCompletedAt: typeof parsed.setupCompletedAt === 'string' ? parsed.setupCompletedAt : undefined,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
    };
  } catch {
    return {
      apiUrl: env.PRODINFOS_API_URL,
      skillAutoUpdate: false,
      updatedAt: new Date().toISOString(),
    };
  }
};

const writeConfigValue = async (value: CliConfig): Promise<void> => {
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(value, null, 2), 'utf8');
  await chmod(configPath, 0o600).catch(() => {
    // Best effort: some platforms may not support chmod for this path.
  });
};

const runCommand = (
  command: string,
  args: string[],
  options?: { input?: string; timeoutMs?: number },
): CommandRunResult => {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    input: options?.input,
    timeout: options?.timeoutMs,
  });

  const timedOut = (result.error as { code?: string } | undefined)?.code === 'ETIMEDOUT';

  return {
    ok: !result.error && result.status === 0,
    code: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    timedOut,
  };
};

const isCommandAvailable = (command: string): boolean => {
  const result = spawnSync(command, ['--help'], {
    stdio: 'ignore',
    timeout: 2000,
  });
  return !result.error;
};

const readTokenFromSystemStore = (): string | undefined => {
  if (process.platform === 'darwin') {
    const result = runCommand('security', [
      'find-generic-password',
      '-a',
      KEYCHAIN_ACCOUNT,
      '-s',
      KEYCHAIN_SERVICE,
      '-w',
    ]);
    if (!result.ok) {
      return undefined;
    }

    const token = result.stdout.trim();
    return token || undefined;
  }

  if (process.platform === 'linux') {
    const result = runCommand('secret-tool', [
      'lookup',
      'service',
      KEYCHAIN_SERVICE,
      'account',
      KEYCHAIN_ACCOUNT,
    ]);
    if (!result.ok) {
      return undefined;
    }

    const token = result.stdout.trim();
    return token || undefined;
  }

  return undefined;
};

const writeTokenToSystemStore = (token: string): boolean => {
  if (process.platform === 'darwin') {
    const result = runCommand(
      'security',
      ['add-generic-password', '-a', KEYCHAIN_ACCOUNT, '-s', KEYCHAIN_SERVICE, '-w', token, '-U'],
      { timeoutMs: 5000 },
    );
    return result.ok;
  }

  if (process.platform === 'linux') {
    const result = runCommand(
      'secret-tool',
      ['store', '--label', 'Prodinfos CLI token', 'service', KEYCHAIN_SERVICE, 'account', KEYCHAIN_ACCOUNT],
      { input: token, timeoutMs: 5000 },
    );
    return result.ok;
  }

  return false;
};

const resolveAuthToken = (config: CliConfig, overrideToken?: string): string | undefined => {
  if (overrideToken) {
    return overrideToken;
  }

  if (config.tokenStorage === 'system_keychain') {
    const tokenFromStore = readTokenFromSystemStore();
    if (tokenFromStore) {
      return tokenFromStore;
    }
  }

  return config.token;
};

const persistAuthToken = async (
  baseConfig: CliConfig,
  apiUrl: string,
  token: string,
): Promise<{ config: CliConfig; storage: 'config_file' | 'system_keychain' }> => {
  const useSystemStore = writeTokenToSystemStore(token);
  const storage: 'config_file' | 'system_keychain' = useSystemStore ? 'system_keychain' : 'config_file';
  const nextConfig: CliConfig = {
    ...baseConfig,
    apiUrl,
    token: storage === 'config_file' ? token : undefined,
    tokenStorage: storage,
    updatedAt: new Date().toISOString(),
  };
  await writeConfigValue(nextConfig);
  return { config: nextConfig, storage };
};

const parseSetupAgents = (value: string): SetupAgent[] => {
  const normalized = value
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);

  const wantsAll = normalized.length === 0 || normalized.includes('all');
  const selected = wantsAll ? ['codex', 'claude', 'openclaw'] : normalized;
  const allowed = new Set<SetupAgent>(['codex', 'claude', 'openclaw']);
  const result: SetupAgent[] = [];

  for (const agent of selected) {
    if (!allowed.has(agent as SetupAgent)) {
      throw Object.assign(
        new Error('Invalid --agents value. Use all|codex|claude|openclaw (comma-separated).'),
        { exitCode: 2 },
      );
    }

    const typedAgent = agent as SetupAgent;
    if (!result.includes(typedAgent)) {
      result.push(typedAgent);
    }
  }

  return result;
};

const installAgentSkills = (agents: SetupAgent[]): SkillInstallResult[] => {
  const results: SkillInstallResult[] = [];

  if (agents.includes('codex') || agents.includes('claude')) {
    if (!isCommandAvailable('npx')) {
      results.push({
        target: 'codex_claude',
        ok: false,
        skipped: true,
        detail: '`npx` not available on this machine.',
      });
    } else {
      const install = runCommand('npx', ['-y', 'skills', 'add', SKILL_ID], { timeoutMs: 120_000 });
      results.push({
        target: 'codex_claude',
        ok: install.ok,
        skipped: false,
        detail: install.ok
          ? 'Skill installed/updated with `npx skills add prodinfos`.'
          : install.timedOut
            ? 'Skill install timed out.'
            : install.stderr.trim() || `Exit code ${install.code ?? 'unknown'}.`,
      });
    }
  }

  if (agents.includes('openclaw')) {
    if (!isCommandAvailable('openclaw')) {
      results.push({
        target: 'openclaw',
        ok: false,
        skipped: true,
        detail: `\`openclaw\` not found. Install OpenClaw first or use ${OPENCLAW_SKILL_PAGE_URL}.`,
      });
    } else {
      const install = runCommand('openclaw', ['skill', 'add', SKILL_ID], { timeoutMs: 120_000 });
      results.push({
        target: 'openclaw',
        ok: install.ok,
        skipped: false,
        detail: install.ok
          ? 'Skill installed/updated with `openclaw skill add prodinfos`.'
          : install.timedOut
            ? 'Skill install timed out.'
            : install.stderr.trim() || `Exit code ${install.code ?? 'unknown'}.`,
      });
    }
  }

  return results;
};

const renderSetupTextSummary = (label: string, result: SetupExecutionResult): string => {
  const lines = [
    label,
    `- Login: ${String(result.login.mode ?? 'skipped')}`,
    `- Auto skill update: ${result.autoSkillUpdate ? 'enabled' : 'disabled'}`,
    `- Config: ${result.configPath}`,
  ];

  for (const entry of result.skillSetup) {
    lines.push(`- Skills (${entry.target}): ${entry.ok ? 'ok' : entry.skipped ? 'skipped' : 'failed'}`);
  }

  return lines.join('\n');
};

const runSetupFlow = async (
  root: { apiUrl?: string; token?: string },
  options: SetupExecutionOptions,
): Promise<SetupExecutionResult> => {
  const initialConfig = await readConfig();
  const apiUrl = (root.apiUrl ?? initialConfig.apiUrl).replace(/\/$/, '');
  const skillResults = options.skipSkills ? [] : installAgentSkills(options.agents);

  let activeConfig = initialConfig;
  let loginResult: SetupLoginResult = {
    ok: true,
    skipped: true,
  };

  if (!options.skipLogin) {
    if (options.token) {
      const persisted = await persistAuthToken(activeConfig, apiUrl, options.token);
      activeConfig = persisted.config;
      loginResult = {
        ok: true,
        mode: 'direct_token',
        tokenStorage: persisted.storage,
      };
    } else if (options.clerkJwt) {
      const exchanged = await exchangeClerkJwtForReadonlyToken(apiUrl, options.clerkJwt);
      const persisted = await persistAuthToken(activeConfig, apiUrl, exchanged.token);
      activeConfig = persisted.config;
      loginResult = {
        ok: true,
        mode: 'clerk_exchange',
        tokenStorage: persisted.storage,
        tenantId: exchanged.tenantId,
        projectIds: exchanged.projectIds,
      };
    } else if (resolveAuthToken(activeConfig, root.token)) {
      loginResult = {
        ok: true,
        mode: 'existing_token',
        tokenStorage: activeConfig.tokenStorage ?? 'config_file',
      };
    } else {
      throw Object.assign(
        new Error(
          'Provide --token or --clerk-jwt for setup login, or pass --skip-login if you want skills only.',
        ),
        { exitCode: 2 },
      );
    }
  }

  const now = new Date().toISOString();
  const autoSkillUpdateEnabled = options.autoSkillUpdate !== false;
  const finalConfig: CliConfig = {
    ...activeConfig,
    apiUrl,
    skillAutoUpdate: autoSkillUpdateEnabled,
    setupCompletedAt: activeConfig.setupCompletedAt ?? now,
    lastSkillSyncAt: options.skipSkills ? activeConfig.lastSkillSyncAt : now,
    updatedAt: now,
  };
  await writeConfigValue(finalConfig);

  return {
    ok: true,
    apiUrl,
    configPath,
    login: loginResult,
    skillSetup: skillResults,
    autoSkillUpdate: finalConfig.skillAutoUpdate ?? false,
    setupCompletedAt: finalConfig.setupCompletedAt,
  };
};

const promptYesNo = async (rl: PromptClient, question: string, defaultValue: boolean): Promise<boolean> => {
  const suffix = defaultValue ? '[Y/n]' : '[y/N]';
  while (true) {
    const answer = (await rl.question(`${question} ${suffix} `)).trim().toLowerCase();
    if (!answer) {
      return defaultValue;
    }
    if (answer === 'y' || answer === 'yes') {
      return true;
    }
    if (answer === 'n' || answer === 'no') {
      return false;
    }

    process.stdout.write('Please answer with y or n.\n');
  }
};

const promptRequiredValue = async (rl: PromptClient, question: string): Promise<string> => {
  while (true) {
    const answer = (await rl.question(`${question} `)).trim();
    if (answer) {
      return answer;
    }
    process.stdout.write('Value is required.\n');
  }
};

const promptLoginMode = async (
  rl: PromptClient,
  hasExistingToken: boolean,
): Promise<'token' | 'clerk' | 'existing' | 'skip'> => {
  while (true) {
    process.stdout.write('\nLogin method:\n');
    process.stdout.write('  1) Readonly token\n');
    process.stdout.write('  2) Clerk JWT\n');
    if (hasExistingToken) {
      process.stdout.write('  3) Use existing token\n');
      process.stdout.write('  4) Skip for now\n');
    } else {
      process.stdout.write('  3) Skip for now\n');
    }

    const maxChoice = hasExistingToken ? 4 : 3;
    const defaultChoice = hasExistingToken ? '3' : '1';
    const answer = (await rl.question(`Select [1-${maxChoice}] (default ${defaultChoice}): `)).trim();
    const choice = answer || defaultChoice;

    if (choice === '1') {
      return 'token';
    }
    if (choice === '2') {
      return 'clerk';
    }
    if (choice === '3' && hasExistingToken) {
      return 'existing';
    }
    if (choice === '3' || choice === '4') {
      return 'skip';
    }

    process.stdout.write('Invalid selection.\n');
  }
};

const openExternalUrl = (url: string): CommandRunResult | null => {
  if (process.platform === 'darwin') {
    return runCommand('open', [url], { timeoutMs: 5000 });
  }

  if (process.platform === 'linux') {
    return runCommand('xdg-open', [url], { timeoutMs: 5000 });
  }

  if (process.platform === 'win32') {
    return runCommand('cmd', ['/c', 'start', '', url], { timeoutMs: 5000 });
  }

  return null;
};

const maybeAutoRefreshSkills = async (commandPath: string): Promise<void> => {
  if (commandPath === 'setup' || commandPath === 'onboard') {
    return;
  }

  const config = await readConfig();
  if (!config.skillAutoUpdate) {
    return;
  }

  const lastSyncAtMs = config.lastSkillSyncAt ? Date.parse(config.lastSkillSyncAt) : 0;
  if (Number.isFinite(lastSyncAtMs) && Date.now() - lastSyncAtMs < SKILL_SYNC_INTERVAL_MS) {
    return;
  }

  if (isCommandAvailable('npx')) {
    runCommand('npx', ['-y', 'skills', 'add', SKILL_ID], {
      timeoutMs: SKILL_SYNC_TIMEOUT_MS,
    });
  }

  if (isCommandAvailable('openclaw')) {
    runCommand('openclaw', ['skill', 'add', SKILL_ID], {
      timeoutMs: SKILL_SYNC_TIMEOUT_MS,
    });
  }

  await writeConfigValue({
    ...config,
    lastSkillSyncAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
};

const formatOutput = (format: OutputFormat, payload: unknown): string => {
  if (format === 'json') {
    return JSON.stringify(payload, null, 2);
  }

  if (typeof payload === 'string') {
    return payload;
  }

  return JSON.stringify(payload, null, 2);
};

const asTimeseriesPoints = (payload: unknown): TimeseriesPoint[] => {
  if (!payload || typeof payload !== 'object' || !('points' in payload)) {
    return [];
  }

  const points = (payload as { points?: unknown }).points;
  if (!Array.isArray(points)) {
    return [];
  }

  return points
    .map((point) => {
      if (!point || typeof point !== 'object') {
        return null;
      }

      const ts = (point as { ts?: unknown }).ts;
      const value = (point as { value?: unknown }).value;
      if (typeof ts !== 'string' || typeof value !== 'number') {
        return null;
      }

      return { ts, value };
    })
    .filter((point): point is TimeseriesPoint => point !== null);
};

const print = (format: OutputFormat, payload: unknown): void => {
  process.stdout.write(`${formatOutput(format, payload)}\n`);
};

const mapStatusToExitCode = (status: number): number => {
  if (status === 401 || status === 403) {
    return 3;
  }

  if (status >= 400 && status < 500) {
    return 2;
  }

  return 4;
};

const parseJsonObjectOption = (value: string | undefined, optionName: string): Record<string, unknown> => {
  if (!value) {
    return {};
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error();
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw Object.assign(new Error(`${optionName} must be a valid JSON object`), { exitCode: 2 });
  }
};

const requestApi = async (
  method: 'GET' | 'POST',
  path: string,
  body: unknown,
  options: ClientOptions,
): Promise<unknown> => {
  const config = await readConfig();
  const apiUrl = (options.apiUrl ?? config.apiUrl).replace(/\/$/, '');
  const token = resolveAuthToken(config, options.token);

  const response = await fetch(`${apiUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
  });

  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;

  if (!response.ok) {
    const message =
      typeof data?.error === 'object' && data.error && 'message' in data.error
        ? String((data.error as { message: unknown }).message)
        : `Request failed with status ${response.status}`;

    const error = new Error(message) as Error & { exitCode?: number; payload?: unknown };
    error.exitCode = mapStatusToExitCode(response.status);
    error.payload = data;
    throw error;
  }

  return data;
};

const requestCsvExport = async (
  path: string,
  options: ClientOptions,
): Promise<{ csv: string; filename: string }> => {
  const config = await readConfig();
  const apiUrl = (options.apiUrl ?? config.apiUrl).replace(/\/$/, '');
  const token = resolveAuthToken(config, options.token);

  const response = await fetch(`${apiUrl}${path}`, {
    method: 'GET',
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });

  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    const message =
      typeof data?.error === 'object' && data.error && 'message' in data.error
        ? String((data.error as { message: unknown }).message)
        : `Request failed with status ${response.status}`;

    const error = new Error(message) as Error & { exitCode?: number; payload?: unknown };
    error.exitCode = mapStatusToExitCode(response.status);
    error.payload = data;
    throw error;
  }

  const csv = await response.text();
  const contentDisposition = response.headers.get('content-disposition') ?? '';
  const filenameMatch = contentDisposition.match(/filename=\"?([^\";]+)\"?/i);
  const filename = filenameMatch?.[1] ?? 'prodinfos-events-export.csv';
  return { csv, filename };
};

const requestCollect = async (
  path: string,
  body: unknown,
  options: CollectClientOptions,
): Promise<unknown> => {
  const endpoint = options.endpoint.replace(/\/$/, '');
  const response = await fetch(`${endpoint}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': options.apiKey,
    },
    body: JSON.stringify(body ?? {}),
  });

  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const message =
      typeof data?.error === 'object' && data.error && 'message' in data.error
        ? String((data.error as { message: unknown }).message)
        : `Request failed with status ${response.status}`;

    const error = new Error(message) as Error & { exitCode?: number; payload?: unknown };
    error.exitCode = mapStatusToExitCode(response.status);
    error.payload = data;
    throw error;
  }

  return data;
};

const exchangeClerkJwtForReadonlyToken = async (
  apiUrl: string,
  clerkJwt: string,
): Promise<{ token: string; tenantId?: unknown; projectIds?: unknown }> => {
  const response = await fetch(`${apiUrl}/v1/auth/exchange-clerk`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${clerkJwt}`,
    },
    body: JSON.stringify({}),
  });

  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok || typeof payload.token !== 'string') {
    const err = new Error('Failed to exchange Clerk token') as Error & {
      exitCode?: number;
      payload?: unknown;
    };
    err.exitCode = mapStatusToExitCode(response.status);
    err.payload = payload;
    throw err;
  }

  return {
    token: payload.token,
    tenantId: payload.tenantId,
    projectIds: payload.projectIds,
  };
};

const withErrorHandling = async (fn: () => Promise<void>): Promise<void> => {
  try {
    await fn();
  } catch (error) {
    const typed = error as Error & { exitCode?: number; payload?: unknown };
    await emitSelfTrackingEvent('cli:command_failed', {
      command: activeCommandPath,
      durationMs: Date.now() - activeCommandStartMs,
      exitCode: typed.exitCode ?? 4,
    });
    const payload = typed.payload ?? {
      error: {
        message: typed.message,
      },
    };

    process.stderr.write(`${JSON.stringify(payload)}\n`);
    process.exitCode = typed.exitCode ?? 4;
  }
};

const resolveCommandPath = (command: Command): string => {
  const names: string[] = [];
  let cursor: Command | null = command;

  while (cursor) {
    const name = cursor.name();
    if (name && name !== 'prodinfos') {
      names.unshift(name);
    }
    cursor = cursor.parent ?? null;
  }

  return names.join(' ') || 'unknown';
};

const emitSelfTrackingEvent = async (
  eventName: string,
  properties: Record<string, unknown>,
): Promise<void> => {
  if (!SELF_TRACKING_ENABLED) {
    return;
  }

  try {
    await fetch(`${SELF_TRACKING_ENDPOINT}/v1/collect`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': String(env.PRODINFOS_SELF_TRACKING_API_KEY),
      },
      body: JSON.stringify({
        projectId: String(env.PRODINFOS_SELF_TRACKING_PROJECT_ID),
        sentAt: new Date().toISOString(),
        events: [
          {
            eventId: `${eventName}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
            eventName,
            ts: new Date().toISOString(),
            sessionId: CLI_SESSION_ID,
            anonId: CLI_ANON_ID,
            properties: {
              ...properties,
              platform: env.PRODINFOS_SELF_TRACKING_PLATFORM,
              nodeVersion: process.version,
              cliVersion: CLI_VERSION,
            },
            platform: env.PRODINFOS_SELF_TRACKING_PLATFORM,
            appVersion: CLI_VERSION,
            type: 'track',
          },
        ],
      }),
    });
  } catch {
    // Self-tracking must never break CLI behavior.
  }
};

const resolveProjectOption = (project: string | undefined): { projectId?: string } => {
  if (!project) {
    return {};
  }

  return { projectId: project };
};

const includeDebugFlag = (): boolean => {
  const root = program.opts<{ includeDebug?: boolean }>();
  return Boolean(root.includeDebug);
};

const program = new Command();
program
  .name('prodinfos')
  .description('Agent-friendly Prodinfos CLI')
  .option('--api-url <url>', 'API base URL')
  .option('--token <token>', 'Override auth token for this call')
  .option('--format <format>', 'Output format json|text', 'json')
  .option('--include-debug', 'Include development/debug events in query/export commands', false)
  .option('--quiet', 'Reduce text output noise', false);

program.hook('preAction', async (_thisCommand, actionCommand) => {
  activeCommandPath = resolveCommandPath(actionCommand);
  activeCommandStartMs = Date.now();
  await maybeAutoRefreshSkills(activeCommandPath).catch(() => {
    // Auto-refresh is best effort.
  });
  await emitSelfTrackingEvent('cli:command_started', {
    command: activeCommandPath,
  });
});

program.hook('postAction', async (_thisCommand, actionCommand) => {
  await emitSelfTrackingEvent('cli:command_succeeded', {
    command: resolveCommandPath(actionCommand),
    durationMs: Date.now() - activeCommandStartMs,
  });
});

program
  .command('login')
  .description('Store CLI token or exchange Clerk JWT for a readonly token')
  .option('--token <token>', 'Direct readonly token')
  .option('--clerk-jwt <jwt>', 'Clerk JWT to exchange')
  .action(async (options: { token?: string; clerkJwt?: string }) => {
    await withErrorHandling(async () => {
      const root = program.opts<{
        apiUrl?: string;
        format: OutputFormat;
      }>();

      const config = await readConfig();
      const apiUrl = (root.apiUrl ?? config.apiUrl).replace(/\/$/, '');

      if (!options.token && !options.clerkJwt) {
        throw Object.assign(new Error('Provide --token or --clerk-jwt'), { exitCode: 2 });
      }

      const now = new Date().toISOString();

      if (options.token) {
        const persisted = await persistAuthToken(config, apiUrl, options.token);

        print(root.format, {
          ok: true,
          mode: 'direct_token',
          tokenStorage: persisted.storage,
          configPath,
          updatedAt: now,
        });
        return;
      }

      const exchanged = await exchangeClerkJwtForReadonlyToken(apiUrl, String(options.clerkJwt));
      const persisted = await persistAuthToken(config, apiUrl, exchanged.token);

      print(root.format, {
        ok: true,
        mode: 'clerk_exchange',
        tokenStorage: persisted.storage,
        configPath,
        tenantId: exchanged.tenantId,
        projectIds: exchanged.projectIds,
        updatedAt: now,
      });
    });
  });

program
  .command('setup')
  .description('One-time setup: install skills, login, and enable optional auto skill refresh')
  .option('--token <token>', 'Readonly token for login')
  .option('--clerk-jwt <jwt>', 'Clerk JWT to exchange for a readonly token')
  .option('--skip-login', 'Skip login step', false)
  .option('--skip-skills', 'Skip skill installation step', false)
  .option('--agents <targets>', 'all|codex|claude|openclaw (comma-separated)', 'all')
  .option('--no-auto-skill-update', 'Disable daily skill refresh on CLI execution')
  .action(
    async (options: {
      token?: string;
      clerkJwt?: string;
      skipLogin?: boolean;
      skipSkills?: boolean;
      agents?: string;
      autoSkillUpdate?: boolean;
    }) => {
      await withErrorHandling(async () => {
        const root = program.opts<{ apiUrl?: string; token?: string; format: OutputFormat }>();
        const agents = parseSetupAgents(String(options.agents ?? 'all'));
        const result = await runSetupFlow(root, {
          token: options.token,
          clerkJwt: options.clerkJwt,
          skipLogin: options.skipLogin,
          skipSkills: options.skipSkills,
          agents,
          autoSkillUpdate: options.autoSkillUpdate,
        });

        if (root.format === 'text') {
          print('text', renderSetupTextSummary('Setup complete.', result));
          return;
        }

        print(root.format, result);
      });
    },
  );

program
  .command('onboard')
  .description('Interactive onboarding: choose skill install targets and login method')
  .option('--token <token>', 'Readonly token for login')
  .option('--clerk-jwt <jwt>', 'Clerk JWT to exchange for a readonly token')
  .option('--no-auto-skill-update', 'Disable daily skill refresh on CLI execution')
  .action(
    async (options: {
      token?: string;
      clerkJwt?: string;
      autoSkillUpdate?: boolean;
    }) => {
      await withErrorHandling(async () => {
        const root = program.opts<{ apiUrl?: string; token?: string; format: OutputFormat }>();

        if (!process.stdin.isTTY || !process.stdout.isTTY) {
          throw Object.assign(
            new Error('`onboard` requires an interactive terminal. Use `prodinfos setup` for non-interactive flows.'),
            { exitCode: 2 },
          );
        }

        const selectedAgents: SetupAgent[] = [];
        let token = options.token;
        let clerkJwt = options.clerkJwt;
        let skipLogin = false;
        let autoSkillUpdate = options.autoSkillUpdate;
        const rl = createInterface({
          input: process.stdin,
          output: process.stdout,
        });

        try {
          process.stdout.write('Prodinfos onboarding\n');
          process.stdout.write('This flow installs skills and configures login.\n\n');

          const installCodexClaude = await promptYesNo(
            rl,
            'Install skill for Codex/Claude Code via `npx -y skills add prodinfos`?',
            true,
          );
          if (installCodexClaude) {
            selectedAgents.push('codex', 'claude');
          }

          const installOpenclaw = await promptYesNo(
            rl,
            'Install skill for OpenClaw via `openclaw skill add prodinfos`?',
            false,
          );
          if (installOpenclaw) {
            selectedAgents.push('openclaw');
            if (!isCommandAvailable('openclaw')) {
              process.stdout.write('\n`openclaw` is not installed on this machine.\n');
              const openSkillPage = await promptYesNo(
                rl,
                `Open OpenClaw skill page now (${OPENCLAW_SKILL_PAGE_URL})?`,
                true,
              );
              if (openSkillPage) {
                const openResult = openExternalUrl(OPENCLAW_SKILL_PAGE_URL);
                if (!openResult) {
                  process.stdout.write(`Could not auto-open browser. Open this URL manually: ${OPENCLAW_SKILL_PAGE_URL}\n`);
                } else if (!openResult.ok) {
                  process.stdout.write(
                    `Failed to open browser automatically. Open this URL manually: ${OPENCLAW_SKILL_PAGE_URL}\n`,
                  );
                }
              }
            }
          }

          if (!token && !clerkJwt) {
            const config = await readConfig();
            const hasExistingToken = Boolean(resolveAuthToken(config, root.token));
            const loginMode = await promptLoginMode(rl, hasExistingToken);

            if (loginMode === 'token') {
              token = await promptRequiredValue(rl, 'Enter readonly token:');
            } else if (loginMode === 'clerk') {
              clerkJwt = await promptRequiredValue(rl, 'Enter Clerk JWT:');
            } else if (loginMode === 'skip') {
              skipLogin = true;
            }
          }

          if (autoSkillUpdate !== false) {
            autoSkillUpdate = await promptYesNo(rl, 'Enable daily automatic skill refresh?', true);
          }
        } finally {
          rl.close();
        }

        const shouldSkipSkills = selectedAgents.length === 0;
        const result = await runSetupFlow(root, {
          token,
          clerkJwt,
          skipLogin,
          skipSkills: shouldSkipSkills,
          agents: shouldSkipSkills ? ['codex'] : selectedAgents,
          autoSkillUpdate,
        });

        if (root.format === 'text') {
          print('text', renderSetupTextSummary('Onboarding complete.', result));
          return;
        }

        print(root.format, result);
      });
    },
  );

const projects = program.command('projects').description('Project operations');

projects
  .command('list')
  .description('List projects in your token scope')
  .action(async () => {
    await withErrorHandling(async () => {
      const root = program.opts<{ apiUrl?: string; token?: string; format: OutputFormat }>();
      const payload = await requestApi('GET', '/v1/projects', undefined, {
        apiUrl: root.apiUrl,
        token: root.token,
      });
      print(root.format, payload);
    });
  });

projects
  .command('create')
  .description('Create a new project in your tenant')
  .requiredOption('--name <name>', 'Project name')
  .requiredOption('--slug <slug>', 'Project slug')
  .action(async (options) => {
    await withErrorHandling(async () => {
      const root = program.opts<{ apiUrl?: string; token?: string; format: OutputFormat }>();
      const payload = await requestApi(
        'POST',
        '/v1/projects',
        {
          name: options.name,
          slug: options.slug,
        },
        {
          apiUrl: root.apiUrl,
          token: root.token,
        },
      );

      const token = (payload as { token?: unknown }).token;
      if (typeof token === 'string') {
        const current = await readConfig();
        await persistAuthToken(current, (root.apiUrl ?? current.apiUrl).replace(/\/$/, ''), token);
      }

      print(root.format, payload);
    });
  });

const keys = program.command('keys').description('Project public API key helpers');

keys
  .command('list')
  .description('Show the project public API key metadata')
  .requiredOption('--project <id>', 'Project ID')
  .action(async (options) => {
    await withErrorHandling(async () => {
      const root = program.opts<{ apiUrl?: string; token?: string; format: OutputFormat }>();
      const payload = await requestApi(
        'GET',
        `/v1/projects/${encodeURIComponent(options.project)}/api-keys`,
        undefined,
        {
          apiUrl: root.apiUrl,
          token: root.token,
        },
      );
      print(root.format, payload);
    });
  });

const schema = program.command('schema').description('Data schema helpers');

schema
  .command('events')
  .description('List discovered events and known properties')
  .requiredOption('--project <id>', 'Project ID')
  .option('--limit <n>', 'Result limit', '100')
  .action(async (options) => {
    await withErrorHandling(async () => {
      const root = program.opts<{ apiUrl?: string; token?: string; format: OutputFormat }>();
      const limit = Number(options.limit);
      const qs = new URLSearchParams({
        projectId: options.project,
        limit: String(limit),
        includeDebug: String(includeDebugFlag()),
      });

      const payload = await requestApi('GET', `/v1/schema/events?${qs.toString()}`, undefined, {
        apiUrl: root.apiUrl,
        token: root.token,
      });
      print(root.format, payload);
    });
  });

program
  .command('funnel')
  .requiredOption('--project <id>', 'Project ID')
  .requiredOption('--steps <steps>', 'Comma-separated event steps')
  .option('--within <scope>', 'session|user', 'session')
  .option('--last <duration>', 'Time range like 7d', '7d')
  .action(async (options) => {
    await withErrorHandling(async () => {
      const root = program.opts<{ apiUrl?: string; token?: string; format: OutputFormat }>();
      const steps = String(options.steps)
        .split(',')
        .map((step) => step.trim())
        .filter(Boolean);

      const payload = await requestApi(
        'POST',
        '/v1/query/funnel',
        {
          ...resolveProjectOption(options.project),
          steps,
          within: options.within,
          last: options.last,
          includeDebug: includeDebugFlag(),
        },
        {
          apiUrl: root.apiUrl,
          token: root.token,
        },
      );
      print(root.format, payload);
    });
  });

program
  .command('conversion-after')
  .requiredOption('--project <id>', 'Project ID')
  .requiredOption('--from <event>', 'From event name')
  .requiredOption('--to <event>', 'To event name')
  .option('--within <scope>', 'session|user', 'session')
  .option('--last <duration>', 'Time range like 7d', '7d')
  .action(async (options) => {
    await withErrorHandling(async () => {
      const root = program.opts<{ apiUrl?: string; token?: string; format: OutputFormat }>();
      const payload = await requestApi(
        'POST',
        '/v1/query/conversion_after',
        {
          ...resolveProjectOption(options.project),
          from: options.from,
          to: options.to,
          within: options.within,
          last: options.last,
          includeDebug: includeDebugFlag(),
        },
        {
          apiUrl: root.apiUrl,
          token: root.token,
        },
      );
      print(root.format, payload);
    });
  });

program
  .command('goal-completion')
  .description(
    'Convenience query for completion style questions, e.g. onboarding start -> onboarding complete',
  )
  .requiredOption('--project <id>', 'Project ID')
  .requiredOption('--start <event>', 'Start event (e.g. onboarding:start)')
  .requiredOption('--complete <event>', 'Completion event (e.g. onboarding:complete)')
  .option('--within <scope>', 'session|user', 'session')
  .option('--last <duration>', 'Time range like 30d', '30d')
  .action(async (options) => {
    await withErrorHandling(async () => {
      const root = program.opts<{ apiUrl?: string; token?: string; format: OutputFormat }>();
      const payload = (await requestApi(
        'POST',
        '/v1/query/conversion_after',
        {
          ...resolveProjectOption(options.project),
          from: options.start,
          to: options.complete,
          within: options.within,
          last: options.last,
          includeDebug: includeDebugFlag(),
        },
        {
          apiUrl: root.apiUrl,
          token: root.token,
        },
      )) as {
        from: string;
        to: string;
        totalFrom: number;
        totalConverted: number;
        conversionRate: number;
        timeRange?: { since?: string; until?: string };
      };

      if (root.format === 'text') {
        print(
          'text',
          `Completion ${payload.from} -> ${payload.to}: ${payload.totalConverted}/${payload.totalFrom} (${(
            payload.conversionRate * 100
          ).toFixed(2)}%)`,
        );
        return;
      }

      print(root.format, payload);
    });
  });

program
  .command('paths-after')
  .requiredOption('--project <id>', 'Project ID')
  .requiredOption('--from <event>', 'Anchor event')
  .option('--top <n>', 'Top N next events', '20')
  .option('--within <scope>', 'session|user', 'session')
  .option('--last <duration>', 'Time range like 7d', '7d')
  .action(async (options) => {
    await withErrorHandling(async () => {
      const root = program.opts<{ apiUrl?: string; token?: string; format: OutputFormat }>();
      const payload = await requestApi(
        'POST',
        '/v1/query/paths_after',
        {
          ...resolveProjectOption(options.project),
          from: options.from,
          top: Number(options.top),
          within: options.within,
          last: options.last,
          includeDebug: includeDebugFlag(),
        },
        {
          apiUrl: root.apiUrl,
          token: root.token,
        },
      );
      print(root.format, payload);
    });
  });

program
  .command('timeseries')
  .requiredOption('--project <id>', 'Project ID')
  .requiredOption('--metric <metric>', 'event_count|unique_sessions|unique_users')
  .option('--event <name>', 'Optional event filter')
  .option('--interval <value>', '1h|1d', '1h')
  .option('--last <duration>', 'Time range like 7d', '7d')
  .option('--viz <mode>', 'none|table|chart|svg', 'none')
  .option('--out <path>', 'Output file path for svg mode', './timeseries.svg')
  .action(async (options) => {
    await withErrorHandling(async () => {
      const root = program.opts<{ apiUrl?: string; token?: string; format: OutputFormat }>();
      const payload = (await requestApi(
        'POST',
        '/v1/query/timeseries',
        {
          ...resolveProjectOption(options.project),
          metric: options.metric,
          event: options.event,
          interval: options.interval,
          last: options.last,
          includeDebug: includeDebugFlag(),
        },
        {
          apiUrl: root.apiUrl,
          token: root.token,
        },
      )) as {
        metric: string;
        interval: string;
        points: TimeseriesPoint[];
      };

      const vizMode = String(options.viz ?? 'none');
      if (vizMode === 'none') {
        print(root.format, payload);
        return;
      }

      const points = asTimeseriesPoints(payload);
      if (vizMode === 'table') {
        const table = renderTable(
          ['timestamp', 'value'],
          points.map((point) => [point.ts, point.value]),
        );
        print('text', table);
        return;
      }

      if (vizMode === 'chart') {
        const chart = renderHorizontalBars(
          points.map((point) => ({
            label: point.ts,
            value: point.value,
          })),
        );
        print('text', chart);
        return;
      }

      if (vizMode === 'svg') {
        const svg = renderTimeseriesSvg({
          title: `${payload.metric} (${payload.interval})`,
          points,
        });
        await writeSvgToFile(String(options.out), svg);
        print(root.format, {
          ok: true,
          file: String(options.out),
          points: points.length,
        });
        return;
      }

      throw Object.assign(new Error('Invalid --viz mode. Use none|table|chart|svg'), { exitCode: 2 });
    });
  });

program
  .command('breakdown')
  .requiredOption('--project <id>', 'Project ID')
  .requiredOption('--by <prop>', 'Property name')
  .requiredOption('--type <type>', 'event_count|conversion_after')
  .option('--event <name>', 'Required for event_count')
  .option('--from <event>', 'Required for conversion_after')
  .option('--to <event>', 'Required for conversion_after')
  .option('--within <scope>', 'session|user', 'session')
  .option('--top <n>', 'Top buckets', '10')
  .option('--last <duration>', 'Time range like 7d', '7d')
  .action(async (options) => {
    await withErrorHandling(async () => {
      const root = program.opts<{ apiUrl?: string; token?: string; format: OutputFormat }>();

      const query =
        options.type === 'event_count'
          ? {
              type: 'event_count',
              eventName: options.event,
            }
          : {
              type: 'conversion_after',
              from: options.from,
              to: options.to,
              within: options.within,
            };

      const payload = await requestApi(
        'POST',
        '/v1/query/breakdown',
        {
          ...resolveProjectOption(options.project),
          by: options.by,
          top: Number(options.top),
          last: options.last,
          includeDebug: includeDebugFlag(),
          query,
        },
        {
          apiUrl: root.apiUrl,
          token: root.token,
        },
      );
      print(root.format, payload);
    });
  });

const feedback = program.command('feedback').description('Feedback data helpers');

feedback
  .command('submit')
  .description('Submit product feedback for Prodinfos via ingest')
  .requiredOption('--message <text>', 'Feedback message')
  .option('--rating <n>', 'Optional rating 1-5')
  .option('--category <type>', 'bug|feature|ux|performance|other', 'other')
  .option('--context <text>', 'Optional context, e.g. what failed')
  .option('--meta <json>', 'Optional JSON object with additional fields')
  .option('--endpoint <url>', 'Collector endpoint (defaults to PRODINFOS_SELF_TRACKING_ENDPOINT)')
  .option('--project <id>', 'Project ID for feedback events (defaults to PRODINFOS_SELF_TRACKING_PROJECT_ID)')
  .option('--api-key <key>', 'Write key for feedback events (defaults to PRODINFOS_SELF_TRACKING_API_KEY)')
  .action(async (options) => {
    await withErrorHandling(async () => {
      const root = program.opts<{ format: OutputFormat }>();
      const endpoint = String(options.endpoint ?? env.PRODINFOS_SELF_TRACKING_ENDPOINT ?? '').replace(
        /\/$/,
        '',
      );
      const projectId = String(options.project ?? env.PRODINFOS_SELF_TRACKING_PROJECT_ID ?? '');
      const apiKey = String(options.apiKey ?? env.PRODINFOS_SELF_TRACKING_API_KEY ?? '');

      if (!endpoint || !projectId || !apiKey) {
        throw Object.assign(
          new Error(
            'Missing feedback target config. Provide --endpoint/--project/--api-key or set PRODINFOS_SELF_TRACKING_ENDPOINT, PRODINFOS_SELF_TRACKING_PROJECT_ID, PRODINFOS_SELF_TRACKING_API_KEY.',
          ),
          { exitCode: 2 },
        );
      }

      const category = String(options.category ?? 'other').toLowerCase();
      if (!['bug', 'feature', 'ux', 'performance', 'other'].includes(category)) {
        throw Object.assign(
          new Error('Invalid --category. Use bug|feature|ux|performance|other'),
          { exitCode: 2 },
        );
      }

      let rating: number | undefined;
      if (options.rating !== undefined) {
        const parsedRating = Number(options.rating);
        if (!Number.isInteger(parsedRating) || parsedRating < 1 || parsedRating > 5) {
          throw Object.assign(new Error('Invalid --rating. Use an integer 1-5.'), { exitCode: 2 });
        }
        rating = parsedRating;
      }

      const meta = parseJsonObjectOption(
        options.meta as string | undefined,
        '--meta',
      );
      const now = new Date().toISOString();

      const payload = {
        projectId,
        sentAt: now,
        events: [
          {
            eventName: 'feedback_submitted',
            ts: now,
            sessionId: CLI_SESSION_ID,
            anonId: CLI_ANON_ID,
            properties: {
              message: String(options.message),
              ...(rating !== undefined ? { rating } : {}),
              category,
              context: options.context ? String(options.context) : null,
              source: 'cli',
              command: activeCommandPath,
              meta,
            },
            platform: env.PRODINFOS_SELF_TRACKING_PLATFORM,
            appVersion: CLI_VERSION,
            type: 'feedback',
          },
        ],
      };

      const response = await requestCollect('/v1/collect', payload, {
        endpoint,
        apiKey,
      });

      if (root.format === 'text') {
        print('text', 'Feedback gesendet.');
        return;
      }

      print(root.format, {
        ok: true,
        endpoint,
        projectId,
        category,
        ...(rating !== undefined ? { rating } : {}),
        response,
      });
    });
  });

feedback
  .command('export')
  .requiredOption('--project <id>', 'Project ID')
  .option('--last <duration>', 'Time range like 30d', '30d')
  .option('--limit <n>', 'Page size', '100')
  .option('--cursor <cursor>', 'Pagination cursor')
  .action(async (options) => {
    await withErrorHandling(async () => {
      const root = program.opts<{ apiUrl?: string; token?: string; format: OutputFormat }>();
      const qs = new URLSearchParams({
        projectId: options.project,
        last: options.last,
        limit: String(Number(options.limit)),
        includeDebug: String(includeDebugFlag()),
      });
      if (options.cursor) {
        qs.set('cursor', options.cursor);
      }

      const payload = await requestApi('GET', `/v1/feedback/export?${qs.toString()}`, undefined, {
        apiUrl: root.apiUrl,
        token: root.token,
      });
      print(root.format, payload);
    });
  });

const events = program.command('events').description('Event export helpers');

events
  .command('months')
  .description('List months with available events for a given year')
  .requiredOption('--project <id>', 'Project ID')
  .requiredOption('--year <year>', 'UTC year, e.g. 2026')
  .action(async (options) => {
    await withErrorHandling(async () => {
      const root = program.opts<{ apiUrl?: string; token?: string; format: OutputFormat }>();
      const qs = new URLSearchParams({
        projectId: options.project,
        year: String(Number(options.year)),
        includeDebug: String(includeDebugFlag()),
      });

      const payload = await requestApi('GET', `/v1/export/events/months?${qs.toString()}`, undefined, {
        apiUrl: root.apiUrl,
        token: root.token,
      });
      print(root.format, payload);
    });
  });

events
  .command('export')
  .description('Download monthly events export as CSV')
  .requiredOption('--project <id>', 'Project ID')
  .requiredOption('--year <year>', 'UTC year, e.g. 2026')
  .requiredOption('--month <month>', 'UTC month number 1-12')
  .option('--out <path>', 'Output file path')
  .action(async (options) => {
    await withErrorHandling(async () => {
      const root = program.opts<{ apiUrl?: string; token?: string; format: OutputFormat }>();
      const year = Number(options.year);
      const month = Number(options.month);
      const qs = new URLSearchParams({
        projectId: options.project,
        year: String(year),
        month: String(month),
        format: 'csv',
        includeDebug: String(includeDebugFlag()),
      });

      const { csv, filename } = await requestCsvExport(`/v1/export/events/download?${qs.toString()}`, {
        apiUrl: root.apiUrl,
        token: root.token,
      });

      const outPath = options.out ? String(options.out) : `./${filename}`;
      await mkdir(dirname(outPath), { recursive: true });
      await writeFile(outPath, csv, 'utf8');

      if (root.format === 'text') {
        print('text', `Export gespeichert: ${outPath}`);
        return;
      }

      print(root.format, {
        ok: true,
        file: outPath,
        year,
        month,
        format: 'csv',
      });
    });
  });

const dev = program.command('dev').description('Local development helpers');

dev
  .command('send-fixture-events')
  .description('Send deterministic fixture events to ingest endpoint')
  .requiredOption('--endpoint <url>', 'Collector base URL, e.g. http://localhost:8787')
  .requiredOption('--api-key <key>', 'Project write API key')
  .requiredOption('--project <id>', 'Project ID')
  .option('--sessions <n>', 'Number of sessions', '20')
  .action(async (options) => {
    await withErrorHandling(async () => {
      const root = program.opts<{ format: OutputFormat }>();
      const sessions = Number(options.sessions);
      const events: Array<Record<string, unknown>> = [];

      for (let i = 0; i < sessions; i += 1) {
        const sessionId = `fixture-session-${i}`;
        const anonId = `fixture-anon-${i}`;
        const now = Date.now() - i * 1000;

        events.push(
          {
            eventId: `fixture-${i}-1`,
            eventName: 'screen:home',
            ts: new Date(now).toISOString(),
            sessionId,
            anonId,
            properties: { appVersion: i % 2 === 0 ? '1.0.0' : '1.1.0' },
          },
          {
            eventId: `fixture-${i}-2`,
            eventName: i % 3 === 0 ? 'click:cta_upgrade' : 'scroll:pricing',
            ts: new Date(now + 1000).toISOString(),
            sessionId,
            anonId,
            properties: { appVersion: i % 2 === 0 ? '1.0.0' : '1.1.0' },
          },
        );

        if (i % 4 === 0) {
          events.push({
            eventId: `fixture-${i}-3`,
            eventName: 'feedback_submitted',
            ts: new Date(now + 2000).toISOString(),
            sessionId,
            anonId,
            properties: {
              message: `Feedback message ${i}`,
              rating: (i % 5) + 1,
            },
          });
        }
      }

      const response = await fetch(`${options.endpoint.replace(/\/$/, '')}/v1/collect`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': options.apiKey,
        },
        body: JSON.stringify({
          projectId: options.project,
          sentAt: new Date().toISOString(),
          events,
        }),
      });

      const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (!response.ok) {
        const err = new Error('Fixture ingest failed') as Error & { exitCode?: number; payload?: unknown };
        err.exitCode = mapStatusToExitCode(response.status);
        err.payload = payload;
        throw err;
      }

      print(root.format, {
        ok: true,
        sessions,
        events: events.length,
        response: payload,
      });
    });
  });

program.parseAsync(process.argv).catch((error) => {
  const typed = error as Error;
  process.stderr.write(`${JSON.stringify({ error: { message: typed.message } })}\n`);
  process.exitCode = 4;
});
