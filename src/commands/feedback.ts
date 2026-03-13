import { parseJsonObjectOption, print } from '../analytics-utils.js';
import { CLI_ANON_ID, CLI_SESSION_ID, CLI_VERSION, CLI_WRITE_COMMANDS_ENABLED, env } from '../constants.js';
import { requestApi, requestCollect } from '../http.js';
import type { CliCommandContext } from './context.js';

export const registerFeedbackCommands = (context: CliCommandContext): void => {
  const { program, withErrorHandling, getRootOptions, includeDebugFlag } = context;

  const feedback = program.command('feedback').description('Feedback data helpers');

  if (CLI_WRITE_COMMANDS_ENABLED) {
    feedback
      .command('submit')
      .description('Submit product feedback for AnalyticsCLI')
      .requiredOption('--message <text>', 'Feedback message')
      .option('--rating <n>', 'Optional rating 1-5')
      .option('--category <type>', 'bug|feature|ux|performance|other', 'other')
      .option('--context <text>', 'Optional context, e.g. what failed')
      .option('--meta <json>', 'Optional JSON object with additional fields')
      .option('--endpoint <url>', 'Collector endpoint (defaults to ANALYTICSCLI_SELF_TRACKING_ENDPOINT)')
      .option('--project <id>', 'Project ID for feedback events (defaults to ANALYTICSCLI_SELF_TRACKING_PROJECT_ID)')
      .option('--api-key <key>', 'Write key for feedback events (defaults to ANALYTICSCLI_SELF_TRACKING_API_KEY)')
      .action(
        async (options: {
          message: string;
          rating?: string;
          category?: string;
          context?: string;
          meta?: string;
          endpoint?: string;
          project?: string;
          apiKey?: string;
        }) => {
          await withErrorHandling(async () => {
            const root = getRootOptions();
            const endpoint = String(options.endpoint ?? env.ANALYTICSCLI_SELF_TRACKING_ENDPOINT ?? '').replace(
              /\/$/,
              '',
            );
            const projectId = String(options.project ?? env.ANALYTICSCLI_SELF_TRACKING_PROJECT_ID ?? '').trim();
            const apiKey = String(options.apiKey ?? env.ANALYTICSCLI_SELF_TRACKING_API_KEY ?? '').trim();

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

            const meta = parseJsonObjectOption(options.meta as string | undefined, '--meta');
            const message = String(options.message);
            const contextText = options.context ? String(options.context) : null;

            const apiPayload: Record<string, unknown> = {
              source: 'cli',
              message,
              category,
              context: contextText,
              meta,
              ...(rating !== undefined ? { rating } : {}),
              ...(projectId ? { project_id: projectId } : {}),
            };

            let response: unknown;
            let delivery: 'api' | 'ingest-fallback' = 'api';

            try {
              response = await requestApi('POST', '/v1/feedback', apiPayload, {
                apiUrl: root.apiUrl,
                token: root.token,
              });
            } catch (apiError) {
              if (!endpoint || !projectId || !apiKey) {
                throw apiError;
              }

              const now = new Date().toISOString();
              const ingestPayload = {
                projectId,
                sentAt: now,
                events: [
                  {
                    eventName: 'feedback_submitted',
                    ts: now,
                    sessionId: CLI_SESSION_ID,
                    anonId: CLI_ANON_ID,
                    properties: {
                      message,
                      ...(rating !== undefined ? { rating } : {}),
                      category,
                      context: contextText,
                      source: 'cli',
                      meta,
                    },
                    platform: env.ANALYTICSCLI_SELF_TRACKING_PLATFORM,
                    appVersion: CLI_VERSION,
                    type: 'feedback',
                  },
                ],
              };

              response = await requestCollect('/v1/collect', ingestPayload, {
                endpoint,
                apiKey,
              });
              delivery = 'ingest-fallback';
            }

            if (root.format === 'text') {
              print('text', 'Feedback gesendet.');
              return;
            }

            print(root.format, {
              ok: true,
              delivery,
              ...(projectId ? { projectId } : {}),
              ...(delivery === 'ingest-fallback' ? { endpoint } : {}),
              category,
              ...(rating !== undefined ? { rating } : {}),
              response,
            });
          });
        },
      );
  }

  feedback
    .command('export')
    .requiredOption('--project <id>', 'Project ID')
    .option('--last <duration>', 'Time range like 30d', '30d')
    .option('--limit <n>', 'Page size', '100')
    .option('--cursor <cursor>', 'Pagination cursor')
    .action(async (options: { project: string; last: string; limit: string; cursor?: string }) => {
      await withErrorHandling(async () => {
        const root = getRootOptions();
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
};
