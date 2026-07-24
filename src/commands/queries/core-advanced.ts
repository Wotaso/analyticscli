import type { Command } from 'commander';
import {
  normalizeOptionString,
  parseCsvOption,
  parseIntegerOption,
  parseRetentionDaysOption,
  print,
  resolveFlowSelectorOption,
  resolveProjectOption,
  withMatchedRecords,
} from '../../analytics-utils.js';
import { ONBOARDING_START_EVENT } from '../../constants.js';
import { noEventsFoundMessage } from '../../dx-messages.js';
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
  projectSurface?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmTerm?: string;
  utmContent?: string;
  referrer?: string;
  landingPath?: string;
};

type RootQueryOptions = FlowSelectionOptions & {
  project?: string;
  last: string;
};

const GENERIC_METRICS = ['event_count', 'unique_sessions', 'unique_users'] as const;
const GENERIC_DIMENSIONS = [
  'eventName',
  'platform',
  'projectSurface',
  'appVersion',
  'utmSource',
  'utmMedium',
  'utmCampaign',
  'utmTerm',
  'utmContent',
  'referrer',
  'referrerHost',
  'landingPath',
  'country',
  'region',
  'city',
  'runtimeEnv',
  'day',
  'hour',
] as const;
const GENERIC_ORDER_BY = ['value_desc', 'value_asc', 'dimension_asc', 'dimension_desc'] as const;
const GENERIC_RUNTIME_ENVS = ['production', 'development', 'test', 'staging'] as const;
const ACQUISITION_DIMENSIONS = [
  'utmSource',
  'utmMedium',
  'utmCampaign',
  'utmTerm',
  'utmContent',
  'referrer',
  'referrerHost',
  'landingPath',
] as const;
const DEFAULT_ACQUISITION_EVENTS = [
  'page_view',
  'landing_page_view',
  'auth_page_view',
  'checkout_page_view',
  'continue_page_view',
].join(',');

const parseEnumOption = <T extends readonly string[]>(
  value: unknown,
  optionName: string,
  allowed: T,
): T[number] => {
  const normalized = normalizeOptionString(value);
  if (!normalized || !allowed.includes(normalized as T[number])) {
    throw Object.assign(new Error(`${optionName} must be one of: ${allowed.join(', ')}`), {
      exitCode: 2,
    });
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
    throw Object.assign(new Error(`--group-by contains unsupported dimension "${invalid}"`), {
      exitCode: 2,
    });
  }

  if (dimensions.includes('day') && dimensions.includes('hour')) {
    throw Object.assign(new Error('--group-by cannot contain both day and hour'), {
      exitCode: 2,
    });
  }

  return dimensions as Array<(typeof GENERIC_DIMENSIONS)[number]>;
};

const parseGenericRuntimeEnvsOption = (
  value: unknown,
): Array<(typeof GENERIC_RUNTIME_ENVS)[number]> => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return [];
  }

  const values = parseCsvOption(value, '--runtime-envs', {
    minItems: 1,
    maxItems: 4,
  }).map((entry) => entry.toLowerCase());
  const invalid = values.find(
    (entry) => !(GENERIC_RUNTIME_ENVS as readonly string[]).includes(entry),
  );
  if (invalid) {
    throw Object.assign(new Error(`--runtime-envs contains unsupported value "${invalid}"`), {
      exitCode: 2,
    });
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
  const { withErrorHandling, getRootOptions, includeDebugFlag, resolveProjectId } = context;

  program
    .command('acquisition')
    .description('Website acquisition and UTM/referrer summary')
    .option('--project <id>', 'Project ID (optional when a default project is selected)')
    .option('--metric <metric>', `Metric: ${GENERIC_METRICS.join('|')}`, 'event_count')
    .option('--group-by <dimension>', `Dimension: ${ACQUISITION_DIMENSIONS.join('|')}`, 'utmSource')
    .option(
      '--events <list>',
      'Event-name filters, comma-separated',
      DEFAULT_ACQUISITION_EVENTS,
    )
    .option('--limit <n>', 'Row limit (policy capped at 200)', '50')
    .option('--order-by <mode>', `Ordering: ${GENERIC_ORDER_BY.join('|')}`, 'value_desc')
    .option('--last <duration>', 'Time range like 30d', '30d')
    .option('--since <iso>', 'Optional ISO start timestamp (requires --until)')
    .option('--until <iso>', 'Optional ISO end timestamp (requires --since)')
    .option('--utm-source <value>', 'Flow selector: properties.utm_source')
    .option('--utm-medium <value>', 'Flow selector: properties.utm_medium')
    .option('--utm-campaign <value>', 'Flow selector: properties.utm_campaign')
    .option('--utm-term <value>', 'Flow selector: properties.utm_term')
    .option('--utm-content <value>', 'Flow selector: properties.utm_content')
    .option('--referrer <value>', 'Flow selector: properties.referrer')
    .option('--landing-path <value>', 'Flow selector: properties.landing_path')
    .action(
      async (
        options: RootQueryOptions & {
          metric: string;
          groupBy: string;
          events: string;
          limit: string;
          orderBy: string;
          since?: string;
          until?: string;
        },
      ) => {
        await withErrorHandling(async () => {
          const root = getRootOptions();
          const projectId = await resolveProjectId(options.project);
          const metric = parseEnumOption(options.metric, '--metric', GENERIC_METRICS);
          const groupBy = parseEnumOption(options.groupBy, '--group-by', ACQUISITION_DIMENSIONS);
          const orderBy = parseEnumOption(options.orderBy, '--order-by', GENERIC_ORDER_BY);
          const limit = parseIntegerOption(options.limit, '--limit', 1, 200);
          const eventNames = parseCsvOption(options.events, '--events', {
            minItems: 1,
            maxItems: 50,
          });
          const dataQualityWarnings =
            metric !== 'event_count' && eventNames.includes('landing_page_view')
              ? [
                  'landing_page_view may be privacy-safe aggregate traffic with one unlinkable identity per event; unique session/user counts can equal pageview counts and must not be interpreted as people.',
                ]
              : [];

          const payload = (await requestApi(
            'POST',
            '/v1/query/generic',
            {
              ...resolveProjectOption(projectId),
              metric,
              groupBy: [groupBy],
              limit,
              orderBy,
              includeDebug: includeDebugFlag(),
              ...resolveGenericTimeRange(options),
              filters: {
                eventNames,
              },
              ...resolveFlowSelectorOption(options),
            },
            {
              apiUrl: root.apiUrl,
              token: root.accessToken,
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

          const matchedRecords = payload.rows.reduce((sum, row) => sum + (row.value ?? 0), 0);
          if (root.format === 'text') {
            const summary = [
              `Acquisition (${payload.timeRange.since} -> ${payload.timeRange.until})`,
              `metric: ${payload.metric}`,
              `dimension: ${groupBy}`,
              `events: ${eventNames.join(', ')}`,
              `matched records: ${matchedRecords}`,
              `rows: ${payload.rows.length}/${payload.limit}`,
              ...dataQualityWarnings.map((warning) => `warning: ${warning}`),
            ].join('\n');
            const table = renderTable(
              [groupBy, 'value'],
              payload.rows.map((row) => [row.dimensions[groupBy] ?? '(unknown)', row.value]),
            );
            print('text', `${summary}\n\n${table}`);
            return;
          }

          print(
            root.format,
            withMatchedRecords(
              {
                kind: 'acquisition',
                ...payload,
                dataQualityWarnings,
              },
              matchedRecords,
            ),
          );
        });
      },
    );

  program
    .command('generic')
    .description('Flexible, policy-limited grouped analytics query')
    .option('--project <id>', 'Project ID (optional when a default project is selected)')
    .option('--metric <metric>', `Metric: ${GENERIC_METRICS.join('|')}`, 'event_count')
    .option('--group-by <list>', `Comma-separated dimensions: ${GENERIC_DIMENSIONS.join(',')}`)
    .option('--events <list>', 'Optional event-name filters, comma-separated')
    .option('--platforms <list>', 'Optional platform filters, comma-separated')
    .option('--project-surfaces <list>', 'Optional projectSurface filters, comma-separated')
    .option('--app-versions <list>', 'Optional appVersion filters, comma-separated')
    .option('--utm-sources <list>', 'Optional utm_source filters, comma-separated')
    .option('--utm-mediums <list>', 'Optional utm_medium filters, comma-separated')
    .option('--utm-campaigns <list>', 'Optional utm_campaign filters, comma-separated')
    .option('--utm-terms <list>', 'Optional utm_term filters, comma-separated')
    .option('--utm-contents <list>', 'Optional utm_content filters, comma-separated')
    .option('--referrers <list>', 'Optional referrer filters, comma-separated')
    .option('--landing-paths <list>', 'Optional landing_path filters, comma-separated')
    .option('--countries <list>', 'Optional country filters, comma-separated')
    .option(
      '--runtime-envs <list>',
      `Optional runtimeEnv filters: ${GENERIC_RUNTIME_ENVS.join(',')}`,
    )
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
    .option('--project-surface <name>', 'Flow selector: projectSurface (landing|dashboard|app)')
    .option('--utm-source <value>', 'Flow selector: properties.utm_source')
    .option('--utm-medium <value>', 'Flow selector: properties.utm_medium')
    .option('--utm-campaign <value>', 'Flow selector: properties.utm_campaign')
    .option('--utm-term <value>', 'Flow selector: properties.utm_term')
    .option('--utm-content <value>', 'Flow selector: properties.utm_content')
    .option('--referrer <value>', 'Flow selector: properties.referrer')
    .option('--landing-path <value>', 'Flow selector: properties.landing_path')
    .action(
      async (
        options: RootQueryOptions & {
          metric: string;
          groupBy?: string;
          events?: string;
          platforms?: string;
          projectSurfaces?: string;
          appVersions?: string;
          utmSources?: string;
          utmMediums?: string;
          utmCampaigns?: string;
          utmTerms?: string;
          utmContents?: string;
          referrers?: string;
          landingPaths?: string;
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
          const projectId = await resolveProjectId(options.project);
          const metric = parseEnumOption(options.metric, '--metric', GENERIC_METRICS);
          const orderBy = parseEnumOption(options.orderBy, '--order-by', GENERIC_ORDER_BY);
          const groupBy = parseGenericGroupByOption(options.groupBy);
          const limit = parseIntegerOption(options.limit, '--limit', 1, 200);
          const runtimeEnvs = parseGenericRuntimeEnvsOption(options.runtimeEnvs);

          const eventNames = parseCsvOption(options.events, '--events', { maxItems: 50 });
          const platforms = parseCsvOption(options.platforms, '--platforms', { maxItems: 20 });
          const projectSurfaces = parseCsvOption(options.projectSurfaces, '--project-surfaces', {
            maxItems: 20,
          });
          const appVersions = parseCsvOption(options.appVersions, '--app-versions', {
            maxItems: 20,
          });
          const utmSources = parseCsvOption(options.utmSources, '--utm-sources', { maxItems: 20 });
          const utmMediums = parseCsvOption(options.utmMediums, '--utm-mediums', { maxItems: 20 });
          const utmCampaigns = parseCsvOption(options.utmCampaigns, '--utm-campaigns', {
            maxItems: 20,
          });
          const utmTerms = parseCsvOption(options.utmTerms, '--utm-terms', { maxItems: 20 });
          const utmContents = parseCsvOption(options.utmContents, '--utm-contents', {
            maxItems: 20,
          });
          const referrers = parseCsvOption(options.referrers, '--referrers', { maxItems: 20 });
          const landingPaths = parseCsvOption(options.landingPaths, '--landing-paths', {
            maxItems: 20,
          });
          const countries = parseCsvOption(options.countries, '--countries', { maxItems: 50 });

          const filters: {
            eventNames?: string[];
            platforms?: string[];
            projectSurfaces?: string[];
            appVersions?: string[];
            utmSources?: string[];
            utmMediums?: string[];
            utmCampaigns?: string[];
            utmTerms?: string[];
            utmContents?: string[];
            referrers?: string[];
            landingPaths?: string[];
            countries?: string[];
            runtimeEnvs?: string[];
          } = {};
          if (eventNames.length > 0) filters.eventNames = eventNames;
          if (platforms.length > 0) filters.platforms = platforms;
          if (projectSurfaces.length > 0) filters.projectSurfaces = projectSurfaces;
          if (appVersions.length > 0) filters.appVersions = appVersions;
          if (utmSources.length > 0) filters.utmSources = utmSources;
          if (utmMediums.length > 0) filters.utmMediums = utmMediums;
          if (utmCampaigns.length > 0) filters.utmCampaigns = utmCampaigns;
          if (utmTerms.length > 0) filters.utmTerms = utmTerms;
          if (utmContents.length > 0) filters.utmContents = utmContents;
          if (referrers.length > 0) filters.referrers = referrers;
          if (landingPaths.length > 0) filters.landingPaths = landingPaths;
          if (countries.length > 0) filters.countries = countries;
          if (runtimeEnvs.length > 0) filters.runtimeEnvs = runtimeEnvs;

          const payload = (await requestApi(
            'POST',
            '/v1/query/generic',
            {
              ...resolveProjectOption(projectId),
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
              token: root.accessToken,
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
            const matchedRecords = payload.rows.reduce((sum, row) => sum + (row.value ?? 0), 0);
            const summary = [
              `Generic query (${payload.timeRange.since} -> ${payload.timeRange.until})`,
              `metric: ${payload.metric}`,
              `groupBy: ${payload.groupBy.length > 0 ? payload.groupBy.join(', ') : '(none)'}`,
              `matched records: ${matchedRecords}`,
              `rows: ${payload.rows.length}/${payload.limit} (order=${payload.orderBy})`,
              `plan: ${payload.plan.mode} ${payload.plan.sourceUsed} (requested=${payload.plan.source}, cost=${payload.plan.estimatedCost})`,
              `reason: ${payload.plan.reason}`,
            ].join('\n');

            if (payload.rows.length === 0) {
              print(
                'text',
                [
                  summary,
                  '',
                  'No rows found for the selected range/filters.',
                  '',
                  noEventsFoundMessage({
                    projectId,
                    last: options.last,
                  }),
                ].join('\n'),
              );
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

          const matchedRecords = payload.rows.reduce((sum, row) => sum + (row.value ?? 0), 0);
          print(root.format, withMatchedRecords(payload, matchedRecords));
        });
      },
    );

  program
    .command('retention')
    .description('Cohort retention by day offsets (e.g. D1/D7/D30) with avg active days')
    .option('--project <id>', 'Project ID (optional when a default project is selected)')
    .option('--anchor-event <name>', 'Cohort anchor event', ONBOARDING_START_EVENT)
    .option('--active-event <name>', 'Optional active event filter (default: any event)')
    .option('--days <list>', 'Comma-separated day offsets, e.g. 1,7,30', '1,7,30')
    .option('--max-age-days <n>', 'Observation horizon in days for avg active span', '90')
    .option(
      '--identity-quality <mode>',
      'Cohort identity filter: stable or all (stable excludes ephemeral/unknown SDK identities; default)',
      'stable',
    )
    .option('--last <duration>', 'Cohort time range like 30d', '30d')
    .option('--app-version <version>', 'Filter by appVersion')
    .option('--flow-id <id>', 'Filter by onboardingFlowId')
    .option('--flow-version <version>', 'Filter by onboardingFlowVersion')
    .option('--variant <name>', 'Filter by experimentVariant (A/B variant)')
    .option('--paywall-id <id>', 'Filter by paywallId')
    .option('--source <name>', 'Filter by properties.source')
    .option('--project-surface <name>', 'Filter by projectSurface (landing|dashboard|app)')
    .option('--utm-source <value>', 'Filter by properties.utm_source')
    .option('--utm-medium <value>', 'Filter by properties.utm_medium')
    .option('--utm-campaign <value>', 'Filter by properties.utm_campaign')
    .option('--utm-term <value>', 'Filter by properties.utm_term')
    .option('--utm-content <value>', 'Filter by properties.utm_content')
    .option('--referrer <value>', 'Filter by properties.referrer')
    .option('--landing-path <value>', 'Filter by properties.landing_path')
    .action(
      async (
        options: RootQueryOptions & {
          anchorEvent: string;
          activeEvent?: string;
          days: string;
          maxAgeDays: string;
          identityQuality: string;
        },
      ) => {
        await withErrorHandling(async () => {
          const root = getRootOptions();
          const projectId = await resolveProjectId(options.project);
          const days = parseRetentionDaysOption(options.days);
          const maxAgeDays = parseIntegerOption(options.maxAgeDays, '--max-age-days', 1, 365);
          const identityQuality = options.identityQuality === 'all' ? 'all' : 'stable';

          const payload = (await requestApi(
            'POST',
            '/v1/query/retention',
            {
              ...resolveProjectOption(projectId),
              anchorEvent: options.anchorEvent,
              activeEvent: options.activeEvent,
              days,
              maxAgeDays,
              identityQuality,
              last: options.last,
              includeDebug: includeDebugFlag(),
              ...resolveFlowSelectorOption(options),
            },
            {
              apiUrl: root.apiUrl,
              token: root.accessToken,
            },
          )) as {
            anchorEvent: string;
            activeEvent: string | null;
            cohortSize: number;
            avgActiveDays: number;
            maxAgeDays: number;
            identityQuality?: 'all' | 'stable';
            quality?: {
              reliability: 'high' | 'medium' | 'low' | 'unknown';
              stableIdentityUsers: number;
              identifiedUsers: number;
              persistentAnonymousUsers: number;
              ephemeralIdentityUsers: number;
              unknownIdentityUsers: number;
              multiSessionUsers: number;
              stableIdentityShare: number;
              identifiedShare: number;
              ephemeralIdentityShare: number;
              multiSessionShare: number;
              warnings: string[];
            };
            days: Array<{ day: number; retainedUsers: number; retentionRate: number }>;
          };

          if (root.format === 'text') {
            const matchedRecords = payload.cohortSize;
            const summary = [
              `Retention cohort (${options.last})`,
              `anchor event: ${payload.anchorEvent}`,
              `active event: ${payload.activeEvent ?? 'any event'}`,
              `matched records: ${matchedRecords}`,
              `cohort size: ${payload.cohortSize}`,
              `avg active days: ${payload.avgActiveDays}`,
              `identity filter: ${payload.identityQuality ?? identityQuality}`,
              payload.quality
                ? `retention reliability: ${payload.quality.reliability} (${(
                    payload.quality.stableIdentityShare * 100
                  ).toFixed(1)}% stable identity, ${(
                    payload.quality.multiSessionShare * 100
                  ).toFixed(1)}% multi-session)`
                : null,
            ]
              .filter(Boolean)
              .join('\n');
            const table = renderTable(
              ['day', 'retained_users', 'retention_rate'],
              payload.days.map((row) => [
                `D${row.day}`,
                row.retainedUsers,
                `${(row.retentionRate * 100).toFixed(2)}%`,
              ]),
            );
            const warnings = payload.quality?.warnings?.length
              ? `\n\nWarnings:\n${payload.quality.warnings.map((warning) => `- ${warning}`).join('\n')}`
              : '';
            print('text', `${summary}\n\n${table}${warnings}`);
            return;
          }

          print(root.format, withMatchedRecords(payload, payload.cohortSize));
        });
      },
    );

  program
    .command('survey')
    .description('Aggregate survey responses (anonymized) by question and answer')
    .option('--project <id>', 'Project ID (optional when a default project is selected)')
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
    .option('--project-surface <name>', 'Filter by projectSurface (landing|dashboard|app)')
    .option('--utm-source <value>', 'Filter by properties.utm_source')
    .option('--utm-medium <value>', 'Filter by properties.utm_medium')
    .option('--utm-campaign <value>', 'Filter by properties.utm_campaign')
    .option('--utm-term <value>', 'Filter by properties.utm_term')
    .option('--utm-content <value>', 'Filter by properties.utm_content')
    .option('--referrer <value>', 'Filter by properties.referrer')
    .option('--landing-path <value>', 'Filter by properties.landing_path')
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
          const projectId = await resolveProjectId(options.project);
          const topQuestions = parseIntegerOption(options.topQuestions, '--top-questions', 1, 100);
          const topAnswers = parseIntegerOption(options.topAnswers, '--top-answers', 1, 100);
          const minUsers = parseIntegerOption(options.minUsers, '--min-users', 1, 500);

          const payload = (await requestApi(
            'POST',
            '/v1/query/survey',
            {
              ...resolveProjectOption(projectId),
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
              token: root.accessToken,
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
            const matchedRecords = payload.totals.responses;
            const blocks: string[] = [];
            blocks.push(
              [
                `Survey summary (${options.last})`,
                `event: ${payload.eventName}`,
                `survey: ${payload.surveyKey ?? 'all'}`,
                `question: ${payload.questionKey ?? 'all'}`,
                `matched records: ${matchedRecords}`,
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
              blocks.push(
                [
                  'No survey responses found for the selected window/filters.',
                  '',
                  noEventsFoundMessage({
                    projectId,
                    last: options.last,
                  }),
                ].join('\n'),
              );
            }

            print('text', blocks.join('\n\n'));
            return;
          }

          print(root.format, withMatchedRecords(payload, payload.totals.responses));
        });
      },
    );

  program
    .command('breakdown')
    .option('--project <id>', 'Project ID (optional when a default project is selected)')
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
    .option('--project-surface <name>', 'Filter by projectSurface (landing|dashboard|app)')
    .option('--utm-source <value>', 'Filter by properties.utm_source')
    .option('--utm-medium <value>', 'Filter by properties.utm_medium')
    .option('--utm-campaign <value>', 'Filter by properties.utm_campaign')
    .option('--utm-term <value>', 'Filter by properties.utm_term')
    .option('--utm-content <value>', 'Filter by properties.utm_content')
    .option('--referrer <value>', 'Filter by properties.referrer')
    .option('--landing-path <value>', 'Filter by properties.landing_path')
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
          const projectId = await resolveProjectId(options.project);

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

          const payload = (await requestApi(
            'POST',
            '/v1/query/breakdown',
            {
              ...resolveProjectOption(projectId),
              by: options.by,
              top: Number(options.top),
              last: options.last,
              includeDebug: includeDebugFlag(),
              ...resolveFlowSelectorOption(options),
              query,
            },
            {
              apiUrl: root.apiUrl,
              token: root.accessToken,
            },
          )) as {
            by: string;
            rows: Array<{ key: string; value: number; share: number }>;
            timeRange?: { since?: string; until?: string };
          };
          const matchedRecords = payload.rows.reduce((sum, row) => sum + (row.value ?? 0), 0);

          if (root.format === 'text') {
            const summary = [
              `Breakdown (${options.last})`,
              `by: ${payload.by}`,
              `matched records: ${matchedRecords}`,
              `rows: ${payload.rows.length}`,
            ].join('\n');
            const table = renderTable(
              ['key', 'value', 'share'],
              payload.rows.map((row) => [row.key, row.value, `${(row.share * 100).toFixed(2)}%`]),
            );
            print('text', `${summary}\n\n${table}`);
            return;
          }

          print(root.format, withMatchedRecords(payload, matchedRecords));
        });
      },
    );
};
