import { print } from '../analytics-utils.js';
import { persistAuthToken, readConfig } from '../config-store.js';
import { requestApi } from '../http.js';
import type { CliCommandContext } from './context.js';

export const registerProjectCommands = (context: CliCommandContext): void => {
  const { program, withErrorHandling, getRootOptions, includeDebugFlag } = context;

  const projects = program.command('projects').description('Project operations');

  projects
    .command('list')
    .description('List projects in your token scope')
    .action(async () => {
      await withErrorHandling(async () => {
        const root = getRootOptions();
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
    .action(async (options: { name: string; slug: string }) => {
      await withErrorHandling(async () => {
        const root = getRootOptions();
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
    .action(async (options: { project: string }) => {
      await withErrorHandling(async () => {
        const root = getRootOptions();
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
    .action(async (options: { project: string; limit: string }) => {
      await withErrorHandling(async () => {
        const root = getRootOptions();
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
};
