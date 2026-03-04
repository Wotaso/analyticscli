import type { Command } from 'commander';
import {
  parseIntegerOption,
  parseRetentionDaysOption,
  print,
  resolveFlowSelectorOption,
  resolveProjectOption,
} from '../../analytics-utils.js';
import { ONBOARDING_START_EVENT } from '../../constants.js';
import { requestApi } from '../../http.js';
import { renderTable } from '../../render.js';
import type { CliCommandContext } from '../context.js';

type FlowSelectionOptions = {
  appVersion?: string;
  flowId?: string;
  flowVersion?: string;
  variant?: string;
  paywallId?: string;
  source?: string;
};

type RootQueryOptions = FlowSelectionOptions & {
  project: string;
  last: string;
};

export const registerAdvancedQueryCommands = (
  program: Command,
  context: CliCommandContext,
): void => {
  const { withErrorHandling, getRootOptions, includeDebugFlag } = context;

  program
    .command('retention')
    .description('Cohort retention by day offsets (e.g. D1/D7/D30) with avg active days')
    .requiredOption('--project <id>', 'Project ID')
    .option('--anchor-event <name>', 'Cohort anchor event', ONBOARDING_START_EVENT)
    .option('--active-event <name>', 'Optional active event filter (default: any event)')
    .option('--days <list>', 'Comma-separated day offsets, e.g. 1,7,30', '1,7,30')
    .option('--max-age-days <n>', 'Observation horizon in days for avg active span', '90')
    .option('--last <duration>', 'Cohort time range like 30d', '30d')
    .option('--app-version <version>', 'Filter by appVersion')
    .option('--flow-id <id>', 'Filter by onboardingFlowId')
    .option('--flow-version <version>', 'Filter by onboardingFlowVersion')
    .option('--variant <name>', 'Filter by experimentVariant (A/B variant)')
    .option('--paywall-id <id>', 'Filter by paywallId')
    .option('--source <name>', 'Filter by properties.source')
    .action(
      async (
        options: RootQueryOptions & {
          anchorEvent: string;
          activeEvent?: string;
          days: string;
          maxAgeDays: string;
        },
      ) => {
        await withErrorHandling(async () => {
          const root = getRootOptions();
          const days = parseRetentionDaysOption(options.days);
          const maxAgeDays = parseIntegerOption(options.maxAgeDays, '--max-age-days', 1, 365);

          const payload = (await requestApi(
            'POST',
            '/v1/query/retention',
            {
              ...resolveProjectOption(options.project),
              anchorEvent: options.anchorEvent,
              activeEvent: options.activeEvent,
              days,
              maxAgeDays,
              last: options.last,
              includeDebug: includeDebugFlag(),
              ...resolveFlowSelectorOption(options),
            },
            {
              apiUrl: root.apiUrl,
              token: root.token,
            },
          )) as {
            anchorEvent: string;
            activeEvent: string | null;
            cohortSize: number;
            avgActiveDays: number;
            maxAgeDays: number;
            days: Array<{ day: number; retainedUsers: number; retentionRate: number }>;
          };

          if (root.format === 'text') {
            const summary = [
              `Retention cohort (${options.last})`,
              `anchor event: ${payload.anchorEvent}`,
              `active event: ${payload.activeEvent ?? 'any event'}`,
              `cohort size: ${payload.cohortSize}`,
              `avg active days: ${payload.avgActiveDays}`,
            ].join('\n');
            const table = renderTable(
              ['day', 'retained_users', 'retention_rate'],
              payload.days.map((row) => [
                `D${row.day}`,
                row.retainedUsers,
                `${(row.retentionRate * 100).toFixed(2)}%`,
              ]),
            );
            print('text', `${summary}\n\n${table}`);
            return;
          }

          print(root.format, payload);
        });
      },
    );

  program
    .command('survey')
    .description('Aggregate survey responses (anonymized) by question and answer')
    .requiredOption('--project <id>', 'Project ID')
    .option('--event <name>', 'Survey response event name', 'onboarding:survey_response')
    .option('--survey-key <key>', 'Optional survey key filter')
    .option('--question-key <key>', 'Optional question key filter')
    .option('--top-questions <n>', 'Top questions', '20')
    .option('--top-answers <n>', 'Top answers per question', '10')
    .option('--min-users <n>', 'Minimum unique users before values are shown', '3')
    .option('--last <duration>', 'Time range like 30d', '30d')
    .option('--app-version <version>', 'Filter by appVersion')
    .option('--flow-id <id>', 'Filter by onboardingFlowId')
    .option('--flow-version <version>', 'Filter by onboardingFlowVersion')
    .option('--variant <name>', 'Filter by experimentVariant (A/B variant)')
    .option('--paywall-id <id>', 'Filter by paywallId')
    .option('--source <name>', 'Filter by properties.source')
    .action(
      async (
        options: RootQueryOptions & {
          event: string;
          surveyKey?: string;
          questionKey?: string;
          topQuestions: string;
          topAnswers: string;
          minUsers: string;
        },
      ) => {
        await withErrorHandling(async () => {
          const root = getRootOptions();
          const topQuestions = parseIntegerOption(options.topQuestions, '--top-questions', 1, 100);
          const topAnswers = parseIntegerOption(options.topAnswers, '--top-answers', 1, 100);
          const minUsers = parseIntegerOption(options.minUsers, '--min-users', 1, 500);

          const payload = (await requestApi(
            'POST',
            '/v1/query/survey',
            {
              ...resolveProjectOption(options.project),
              eventName: options.event,
              surveyKey: options.surveyKey,
              questionKey: options.questionKey,
              topQuestions,
              topAnswers,
              minUsers,
              last: options.last,
              includeDebug: includeDebugFlag(),
              ...resolveFlowSelectorOption(options),
            },
            {
              apiUrl: root.apiUrl,
              token: root.token,
            },
          )) as {
            eventName: string;
            surveyKey: string | null;
            questionKey: string | null;
            minUsers: number;
            questions: Array<{
              questionKey: string;
              responses: number;
              uniqueUsers: number;
              answers: Array<{
                responseKey: string;
                responses: number;
                uniqueUsers: number;
                share: number;
              }>;
            }>;
            totals: { responses: number; uniqueUsers: number };
          };

          if (root.format === 'text') {
            const blocks: string[] = [];
            blocks.push(
              [
                `Survey summary (${options.last})`,
                `event: ${payload.eventName}`,
                `survey: ${payload.surveyKey ?? 'all'}`,
                `question: ${payload.questionKey ?? 'all'}`,
                `totals: ${payload.totals.responses} responses / ${payload.totals.uniqueUsers} users`,
                `anonymization threshold: min ${payload.minUsers} users`,
              ].join('\n'),
            );

            for (const question of payload.questions) {
              const table = renderTable(
                ['response', 'responses', 'users', 'share'],
                question.answers.map((answer) => [
                  answer.responseKey,
                  answer.responses,
                  answer.uniqueUsers,
                  `${(answer.share * 100).toFixed(2)}%`,
                ]),
              );

              blocks.push(
                [
                  `Question: ${question.questionKey}`,
                  `responses: ${question.responses} / users: ${question.uniqueUsers}`,
                  table,
                ].join('\n'),
              );
            }

            if (payload.questions.length === 0) {
              blocks.push('No survey responses found for the selected window/filters.');
            }

            print('text', blocks.join('\n\n'));
            return;
          }

          print(root.format, payload);
        });
      },
    );

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
    .option('--app-version <version>', 'Filter by appVersion')
    .option('--flow-id <id>', 'Filter by onboardingFlowId')
    .option('--flow-version <version>', 'Filter by onboardingFlowVersion')
    .option('--variant <name>', 'Filter by experimentVariant (A/B variant)')
    .option('--paywall-id <id>', 'Filter by paywallId')
    .option('--source <name>', 'Filter by properties.source')
    .action(
      async (
        options: RootQueryOptions & {
          by: string;
          type: 'event_count' | 'conversion_after';
          event?: string;
          from?: string;
          to?: string;
          within: string;
          top: string;
        },
      ) => {
        await withErrorHandling(async () => {
          const root = getRootOptions();

          const query =
            options.type === 'event_count'
              ? {
                  type: 'event_count' as const,
                  eventName: options.event,
                }
              : {
                  type: 'conversion_after' as const,
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
              ...resolveFlowSelectorOption(options),
              query,
            },
            {
              apiUrl: root.apiUrl,
              token: root.token,
            },
          );
          print(root.format, payload);
        });
      },
    );
};
