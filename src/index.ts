#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { Command } from 'commander';
import { readCliEnv } from '@prodinfos/config';

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

const env = readCliEnv();

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

const withErrorHandling = async (fn: () => Promise<void>): Promise<void> => {
  try {
    await fn();
  } catch (error) {
    const typed = error as Error & { exitCode?: number; payload?: unknown };
    const payload = typed.payload ?? {
      error: {
        message: typed.message,
      },
    };

    process.stderr.write(`${JSON.stringify(payload)}\n`);
    process.exitCode = typed.exitCode ?? 4;
  }
};

const resolveProjectOption = (project: string | undefined): { projectId?: string } => {
  if (!project) {
    return {};
  }

  return { projectId: project };
};

const program = new Command();
program
  .name('prodinfos')
  .description('Agent-friendly Prodinfos CLI')
  .option('--api-url <url>', 'API base URL')
  .option('--token <token>', 'Override auth token for this call')
  .option('--format <format>', 'Output format json|text', 'json')
  .option('--quiet', 'Reduce text output noise', false);

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
  .action(async (options) => {
    await withErrorHandling(async () => {
      const root = program.opts<{ apiUrl?: string; token?: string; format: OutputFormat }>();
      const payload = await requestApi(
        'POST',
        '/v1/query/timeseries',
        {
          ...resolveProjectOption(options.project),
          metric: options.metric,
          event: options.event,
          interval: options.interval,
          last: options.last,
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
