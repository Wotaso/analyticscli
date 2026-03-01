import { print } from '../analytics-utils.js';
import { mapStatusToExitCode } from '../http.js';
import type { CliCommandContext } from './context.js';

export const registerDevCommands = (context: CliCommandContext): void => {
  const { program, withErrorHandling, getRootOptions } = context;

  const dev = program.command('dev').description('Local development helpers');

  dev
    .command('send-fixture-events')
    .description('Send deterministic fixture events to ingest endpoint')
    .requiredOption('--endpoint <url>', 'Collector base URL, e.g. http://localhost:8787')
    .requiredOption('--api-key <key>', 'Project write API key')
    .requiredOption('--project <id>', 'Project ID')
    .option('--sessions <n>', 'Number of sessions', '20')
    .action(
      async (options: { endpoint: string; apiKey: string; project: string; sessions: string }) => {
        await withErrorHandling(async () => {
          const root = getRootOptions();
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
            const err = new Error('Fixture ingest failed') as Error & {
              exitCode?: number;
              payload?: unknown;
            };
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
      },
    );
};
