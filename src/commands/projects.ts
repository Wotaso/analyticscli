import { print } from '../analytics-utils.js';
import { CLI_WRITE_COMMANDS_ENABLED } from '../constants.js';
import { authorizeCliDevice } from '../device-auth.js';
import { writeEnvValue } from '../env-file.js';
import { persistAuthToken, readConfig } from '../config-store.js';
import { noEventsFoundMessage, noProjectsFoundMessage } from '../dx-messages.js';
import { requestApi } from '../http.js';
import {
  fetchProjectOptions,
  promptProjectSelection,
  setSelectedProjectId,
} from '../project-selection.js';
import type { CliCommandContext } from './context.js';

export const registerProjectCommands = (context: CliCommandContext): void => {
  const { program, withErrorHandling, getRootOptions, includeDebugFlag, resolveProjectId } =
    context;

  const projects = program.command('projects').description('Project operations');

  projects
    .command('list')
    .description('List projects in your token scope')
    .action(async () => {
      await withErrorHandling(async () => {
        const root = getRootOptions();
        if (root.format === 'text') {
          const projectsInScope = await fetchProjectOptions({
            apiUrl: root.apiUrl,
            token: root.accessToken,
          });

          if (projectsInScope.length === 0) {
            print('text', noProjectsFoundMessage());
            return;
          }

          const lines = [
            `Projects in scope: ${projectsInScope.length}`,
            ...projectsInScope.map((project) => `- ${project.label}`),
            '',
            'Next step: set a default project with `analyticscli projects select`.',
          ];
          print('text', lines.join('\n'));
          return;
        }

        const payload = await requestApi('GET', '/v1/projects', undefined, {
          apiUrl: root.apiUrl,
          token: root.accessToken,
        });
        print(root.format, payload);
      });
    });

  projects
    .command('select')
    .argument('[project]', 'Project ID to set directly without interactive picker')
    .description('Select and persist default project (arrow keys in interactive terminal)')
    .option('--project <id>', 'Project ID to set directly without interactive picker')
    .action(async (projectArg: string | undefined, options: { project?: string }) => {
      await withErrorHandling(async () => {
        const root = getRootOptions();
        const providedProject =
          options.project?.trim() || projectArg?.trim() || root.project?.trim();

        if (providedProject) {
          await setSelectedProjectId(providedProject);
          print(root.format, {
            ok: true,
            selectedProjectId: providedProject,
            source: 'direct_option',
          });
          return;
        }

        if (!process.stdin.isTTY || !process.stdout.isTTY) {
          throw Object.assign(
            new Error('Interactive project selection requires a TTY. Pass --project <id> instead.'),
            { exitCode: 2 },
          );
        }

        const projectsInScope = await fetchProjectOptions({
          apiUrl: root.apiUrl,
          token: root.accessToken,
        });
        if (projectsInScope.length === 0) {
          throw Object.assign(new Error(noProjectsFoundMessage()), {
            exitCode: 3,
          });
        }

        const selected =
          projectsInScope.length === 1
            ? projectsInScope[0]!
            : await promptProjectSelection(projectsInScope, 'Select default project');

        await setSelectedProjectId(selected.id);
        print(root.format, {
          ok: true,
          selectedProjectId: selected.id,
          selectedProjectLabel: selected.label,
          source: projectsInScope.length === 1 ? 'single_project_auto' : 'interactive_picker',
        });
      });
    });

  projects
    .command('create')
    .description('Create a project through browser-confirmed CLI authorization')
    .requiredOption('--name <name>', 'Project name')
    .option('--slug <slug>', 'Project slug (derived from the name when omitted)')
    .option('--env-file <path>', 'Write the publishable SDK key to a local env file')
    .option(
      '--env-name <name>',
      'Environment variable name for --env-file',
      'ANALYTICSCLI_PUBLISHABLE_API_KEY',
    )
    .option('--no-open', 'Do not open the browser automatically')
    .option('--no-select', 'Do not select the new project as CLI default')
    .action(
      async (options: {
        name: string;
        slug?: string;
        envFile?: string;
        envName: string;
        open: boolean;
        select: boolean;
      }) => {
        await withErrorHandling(async () => {
          const root = getRootOptions();
          const name = options.name.trim();
          const slug = (options.slug ?? name)
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9_-]+/g, '-')
            .replace(/-+/g, '-')
            .replace(/^-|-$/g, '')
            .slice(0, 100);
          if (name.length < 2 || slug.length < 2) {
            throw Object.assign(
              new Error('Project name and resulting slug must contain at least 2 characters.'),
              {
                exitCode: 2,
              },
            );
          }

          const setupToken = await authorizeCliDevice({
            apiUrl: root.apiUrl,
            openBrowser: options.open,
          });
          const created = (await requestApi(
            'POST',
            '/v1/projects',
            { name, slug },
            { apiUrl: root.apiUrl, token: setupToken },
          )) as {
            project?: { id?: string; name?: string; slug?: string };
            publicApiKey?: string;
            publicApiKeySecret?: string;
          };
          const projectId = created.project?.id;
          const publishableApiKey = created.publicApiKeySecret ?? created.publicApiKey;
          if (!projectId || !publishableApiKey) {
            throw Object.assign(
              new Error('Project was created without the required project ID or publishable key.'),
              {
                exitCode: 4,
              },
            );
          }

          const readonlyPayload = (await requestApi(
            'POST',
            '/v1/me/cli-tokens',
            {},
            { apiUrl: root.apiUrl, token: setupToken },
          )) as { token?: string };
          if (typeof readonlyPayload.token !== 'string') {
            throw Object.assign(
              new Error(
                'Project was created, but the refreshed readonly CLI token was not returned.',
              ),
              {
                exitCode: 4,
              },
            );
          }

          const current = await readConfig();
          const persisted = await persistAuthToken(
            current,
            root.apiUrl ?? current.apiUrl,
            readonlyPayload.token,
          );
          if (options.select) await setSelectedProjectId(projectId);
          const envFile = options.envFile
            ? await writeEnvValue(options.envFile, options.envName, publishableApiKey)
            : undefined;

          const result = {
            ok: true,
            project: created.project,
            selectedAsDefault: options.select,
            publishableApiKey,
            publishableApiKeyEnvName: options.envName,
            publishableApiKeyEnvFile: envFile,
            readonlyTokenStorage: persisted.storage,
          };
          if (root.format === 'text') {
            print(
              'text',
              [
                `Created project: ${created.project?.name} (${projectId})`,
                `Slug: ${created.project?.slug}`,
                `Publishable SDK key: ${publishableApiKey}`,
                envFile
                  ? `Saved ${options.envName} in ${envFile}`
                  : `Set ${options.envName} in your app environment.`,
                `Readonly CLI token stored in ${persisted.storage === 'system_keychain' ? 'the system keychain' : 'the protected CLI config file'}.`,
              ].join('\n'),
            );
            return;
          }
          print(root.format, result);
        });
      },
    );

  if (CLI_WRITE_COMMANDS_ENABLED) {
    const keys = program.command('keys').description('Project public API key helpers');

    keys
      .command('list')
      .description('Show the project public API key metadata')
      .option('--project <id>', 'Project ID (optional when a default project is selected)')
      .action(async (options: { project?: string }) => {
        await withErrorHandling(async () => {
          const root = getRootOptions();
          const projectId = await resolveProjectId(options.project);
          const payload = await requestApi(
            'GET',
            `/v1/projects/${encodeURIComponent(projectId)}/api-keys`,
            undefined,
            {
              apiUrl: root.apiUrl,
              token: root.accessToken,
            },
          );
          print(root.format, payload);
        });
      });
  }

  const schema = program.command('schema').description('Data schema helpers');

  schema
    .command('events')
    .description('List discovered events and known properties')
    .option('--project <id>', 'Project ID (optional when a default project is selected)')
    .option('--limit <n>', 'Result limit', '100')
    .option('--last <duration>', 'Time range like 14d', '14d')
    .action(async (options: { project?: string; limit: string; last: string }) => {
      await withErrorHandling(async () => {
        const root = getRootOptions();
        const projectId = await resolveProjectId(options.project);
        const limit = Number(options.limit);
        const qs = new URLSearchParams({
          projectId,
          limit: String(limit),
          last: options.last,
          includeDebug: String(includeDebugFlag()),
        });

        const payload = await requestApi('GET', `/v1/schema/events?${qs.toString()}`, undefined, {
          apiUrl: root.apiUrl,
          token: root.accessToken,
        });

        if (root.format === 'text') {
          let items: unknown[] = [];
          if (Array.isArray(payload)) {
            items = payload;
          } else if (payload && typeof payload === 'object') {
            const typedPayload = payload as {
              items?: unknown;
              events?: unknown;
              data?: unknown;
            };
            if (Array.isArray(typedPayload.items)) {
              items = typedPayload.items;
            } else if (Array.isArray(typedPayload.events)) {
              items = typedPayload.events;
            } else if (Array.isArray(typedPayload.data)) {
              items = typedPayload.data;
            }
          }

          if (items.length === 0) {
            print(
              'text',
              noEventsFoundMessage({
                projectId,
                last: options.last,
              }),
            );
            return;
          }
        }

        print(root.format, payload);
      });
    });
};
