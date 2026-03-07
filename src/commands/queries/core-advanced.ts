import type { Command } from 'commander';
import {
  normalizeOptionString,
  parseCsvOption,
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

const GENERIC_METRICS = ['event_count', 'unique_sessions', 'unique_users'] as const;
const GENERIC_DIMENSIONS = [
  'eventName',
  'platform',
  'appVersion',
  'country',
  'region',
  'city',
  'runtimeEnv',
  'day',
  'hour',
] as const;
const GENERIC_ORDER_BY = ['value_desc', 'value_asc', 'dimension_asc', 'dimension_desc'] as const;
const GENERIC_RUNTIME_ENVS = ['production', 'development', 'test', 'staging'] as const;

const parseEnumOption = <T extends readonly string[]>(
  value: unknown,
  optionName: string,
  allowed: T,
): T[number] => {
  const normalized = normalizeOptionString(value);
  if (!normalized || !allowed.includes(normalized as T[number])) {
    throw Object.assign(new Error(`${optionName} must be one of: ${allowed.join(', ')}`), { exitCode: 2 });
  }
  return normalized as T[number];
};

const parseGenericGroupByOption = (value: unknown): Array<(typeof GENERIC_DIMENSIONS)[number]> => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return [];
  }

  const dimensions = parseCsvOption(value, '--group-by', {
    minItems: 1,
    maxItems: 3,
  });
  const invalid = dimensions.find(
    (dimension) => !(GENERIC_DIMENSIONS as readonly string[]).includes(dimension),
  );
  if (invalid) {
    throw Object.assign(
      new Error(`--group-by contains unsupported dimension "${invalid}"`),
      { exitCode: 2 },
    );
  }

  if (dimensions.includes('day') && dimensions.includes('hour')) {
    throw Object.assign(new Error('--group-by cannot contain both day and hour'), {
      exitCode: 2,
    });
  }

  return dimensions as Array<(typeof GENERIC_DIMENSIONS)[number]>;
};

const parseGenericRuntimeEnvsOption = (value: unknown): Array<(typeof GENERIC_RUNTIME_ENVS)[number]> => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return [];
  }

  const values = parseCsvOption(value, '--runtime-envs', {
    minItems: 1,
    maxItems: 4,
  }).map((entry) => entry.toLowerCase());
  const invalid = values.find((entry) => !(GENERIC_RUNTIME_ENVS as readonly string[]).includes(entry));
  if (invalid) {
    throw Object.assign(
      new Error(`--runtime-envs contains unsupported value "${invalid}"`),
      { exitCode: 2 },
    );
  }

  return values as Array<(typeof GENERIC_RUNTIME_ENVS)[number]>;
};

const resolveGenericTimeRange = (options: { last: string; since?: string; until?: string }) => {
  const since = normalizeOptionString(options.since);
  const until = normalizeOptionString(options.until);

  if ((since && !until) || (!since && until)) {
    throw Object.assign(new Error('Use --since and --until together, or use --last'), {
      exitCode: 2,
    });
  }

  if (since && until) {
    return { since, until };
  }

  return { last: options.last };
};

export const registerAdvancedQueryCommands = (
  program: Command,
  context: CliCommandContext,
): void => {
  const { withErrorHandling, getRootOptions, includeDebugFlag } = context;

  program
    .command('generic')
    .description('Flexible, policy-limited grouped analytics query')
    .requiredOption('--project <id>', 'Project ID')
    .option('--metric <metric>', `Metric: ${GENERIC_METRICS.join('|')}`, 'event_count')
    .option('--group-by <list>', `Comma-separated dimensions: ${GENERIC_DIMENSIONS.join(',')}`)
    .option('--events <list>', 'Optional event-name filters, comma-separated')
    .option('--platforms <list>', 'Optional platform filters, comma-separated')
    .option('--app-versions <list>', 'Optional appVersion filters, comma-separated')
    .option('--countries <list>', 'Optional country filters, comma-separated')
    .option('--runtime-envs <list>', `Optional runtimeEnv filters: ${GENERIC_RUNTIME_ENVS.join(',')}`)
    .option('--limit <n>', 'Row limit (policy capped at 200)', '100')
    .option('--order-by <mode>', `Ordering: ${GENERIC_ORDER_BY.join('|')}`, 'value_desc')
    .option('--last <duration>', 'Time range like 7d', '7d')
    .option('--since <iso>', 'Optional ISO start timestamp (requires --until)')
    .option('--until <iso>', 'Optional ISO end timestamp (requires --since)')
    .option('--app-version <version>', 'Flow selector: appVersion')
    .option('--flow-id <id>', 'Flow selector: onboardingFlowId')
    .option('--flow-version <version>', 'Flow selector: onboardingFlowVersion')
    .option('--variant <name>', 'Flow selector: experimentVariant')
    .option('--paywall-id <id>', 'Flow selector: paywallId')
    .option('--source <name>', 'Flow selector: properties.source')
    .action(
      async (
        options: RootQueryOptions & {
          metric: string;
          groupBy?: string;
          events?: string;
          platforms?: string;
          appVersions?: string;
          countries?: string;
          runtimeEnvs?: string;
          limit: string;
          orderBy: string;
          since?: string;
          until?: string;
        },
      ) => {
        await withErrorHandling(async () => {
          const root = getRootOptions();
          const metric = parseEnumOption(options.metric, '--metric', GENERIC_METRICS);
          const orderBy = parseEnumOption(options.orderBy, '--order-by', GENERIC_ORDER_BY);
          const groupBy = parseGenericGroupByOption(options.groupBy);
          const limit = parseIntegerOption(options.limit, '--limit', 1, 200);
          const runtimeEnvs = parseGenericRuntimeEnvsOption(options.runtimeEnvs);

          const eventNames = parseCsvOption(options.events, '--events', { maxItems: 50 });
          const platforms = parseCsvOption(options.platforms, '--platforms', { maxItems: 20 });
          const appVersions = parseCsvOption(options.appVersions, '--app-versions', { maxItems: 20 });
          const countries = parseCsvOption(options.countries, '--countries', { maxItems: 50 });

          const filters: {
            eventNames?: string[];
            platforms?: string[];
            appVersions?: string[];
            countries?: string[];
            runtimeEnvs?: string[];
          } = {};
          if (eventNames.length > 0) filters.eventNames = eventNames;
          if (platforms.length > 0) filters.platforms = platforms;
          if (appVersions.length > 0) filters.appVersions = appVersions;
          if (countries.length > 0) filters.countries = countries;
          if (runtimeEnvs.length > 0) filters.runtimeEnvs = runtimeEnvs;

          const payload = (await requestApi(
            'POST',
            '/v1/query/generic',
            {
              ...resolveProjectOption(options.project),
              metric,
              groupBy,
              limit,
              orderBy,
              includeDebug: includeDebugFlag(),
              ...resolveGenericTimeRange(options),
              ...(Object.keys(filters).length > 0 ? { filters } : {}),
              ...resolveFlowSelectorOption(options),
            },
            {
              apiUrl: root.apiUrl,
              token: root.token,
            },
          )) as {
            metric: string;
            groupBy: string[];
            limit: number;
            orderBy: string;
            rows: Array<{ dimensions: Record<string, string>; value: number }>;
            plan: {
              mode: 'raw' | 'aggregate';
              source: string;
              sourceUsed: string;
              estimatedCost: 'low' | 'medium' | 'high';
              reason: string;
            };
            timeRange: { since: string; until: string };
          };

          if (root.format === 'text') {
            const summary = [
              `Generic query (${payload.timeRange.since} -> ${payload.timeRange.until})`,
              `metric: ${payload.metric}`,
              `groupBy: ${payload.groupBy.length > 0 ? payload.groupBy.join(', ') : '(none)'}`,
              `rows: ${payload.rows.length}/${payload.limit} (order=${payload.orderBy})`,
              `plan: ${payload.plan.mode} ${payload.plan.sourceUsed} (requested=${payload.plan.source}, cost=${payload.plan.estimatedCost})`,
              `reason: ${payload.plan.reason}`,
            ].join('\n');

            if (payload.rows.length === 0) {
              print('text', `${summary}\n\nNo rows found for the selected range/filters.`);
              return;
            }

            const dimensionColumns = payload.groupBy;
            const header = [...dimensionColumns, 'value'];
            const tableRows = payload.rows.map((row) => [
              ...dimensionColumns.map((column) => row.dimensions[column] ?? '(unknown)'),
              row.value,
            ]);
            const table = renderTable(header, tableRows);
            print('text', `${summary}\n\n${table}`);
            return;
          }

          print(root.format, payload);
        });
      },
    );

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
