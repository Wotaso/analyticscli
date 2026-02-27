#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
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

const env = readCliEnv();
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
    return JSON.parse(raw) as CliConfig;
  } catch {
    return {
      apiUrl: env.PRODINFOS_API_URL,
      updatedAt: new Date().toISOString(),
    };
  }
};

const writeConfigValue = async (value: CliConfig): Promise<void> => {
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(value, null, 2), 'utf8');
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
  const token = options.token ?? config.token;

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
  const token = options.token ?? config.token;

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
              cliVersion: '0.1.0',
            },
            platform: env.PRODINFOS_SELF_TRACKING_PLATFORM,
            appVersion: '0.1.0',
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

program.hook('preAction', (_thisCommand, actionCommand) => {
  activeCommandPath = resolveCommandPath(actionCommand);
  activeCommandStartMs = Date.now();
  void emitSelfTrackingEvent('cli:command_started', {
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
  .action(async (options) => {
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

      if (options.token) {
        await writeConfigValue({
          apiUrl,
          token: options.token,
          updatedAt: new Date().toISOString(),
        });

        print(root.format, {
          ok: true,
          mode: 'direct_token',
          configPath,
        });
        return;
      }

      const response = await fetch(`${apiUrl}/v1/auth/exchange-clerk`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${options.clerkJwt}`,
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

      await writeConfigValue({
        apiUrl,
        token: payload.token,
        updatedAt: new Date().toISOString(),
      });

      print(root.format, {
        ok: true,
        mode: 'clerk_exchange',
        configPath,
        tenantId: payload.tenantId,
        projectIds: payload.projectIds,
      });
    });
  });

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
        await writeConfigValue({
          ...current,
          apiUrl: (root.apiUrl ?? current.apiUrl).replace(/\/$/, ''),
          token,
          updatedAt: new Date().toISOString(),
        });
      }

      print(root.format, payload);
    });
  });

const keys = program.command('keys').description('Project write key management');

keys
  .command('list')
  .description('List write keys for a project')
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

keys
  .command('create')
  .description('Create a new write key for a project')
  .requiredOption('--project <id>', 'Project ID')
  .option('--name <name>', 'Key display name', 'SDK Write Key')
  .action(async (options) => {
    await withErrorHandling(async () => {
      const root = program.opts<{ apiUrl?: string; token?: string; format: OutputFormat }>();
      const payload = await requestApi(
        'POST',
        `/v1/projects/${encodeURIComponent(options.project)}/api-keys`,
        {
          name: options.name,
        },
        {
          apiUrl: root.apiUrl,
          token: root.token,
        },
      );
      print(root.format, payload);
    });
  });

keys
  .command('revoke')
  .description('Revoke an existing write key')
  .requiredOption('--project <id>', 'Project ID')
  .requiredOption('--key <id>', 'Key ID')
  .action(async (options) => {
    await withErrorHandling(async () => {
      const root = program.opts<{ apiUrl?: string; token?: string; format: OutputFormat }>();
      const payload = await requestApi(
        'POST',
        `/v1/projects/${encodeURIComponent(options.project)}/api-keys/${encodeURIComponent(options.key)}/revoke`,
        {},
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
            appVersion: '0.1.0',
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
