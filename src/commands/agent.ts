import {
  compileAgentBrief,
  selectAgentBriefIdentityEvents,
  type AgentBriefFocus,
  type GenericQuerySnapshot,
  type SchemaEventSummary,
} from '../agent-brief.js';
import { print } from '../analytics-utils.js';
import { requestApi } from '../http.js';
import type { CliCommandContext } from './context.js';

const FOCUS_VALUES = new Set<AgentBriefFocus>(['auto', 'mobile', 'web', 'all']);

const parseFocus = (value: string): AgentBriefFocus => {
  if (FOCUS_VALUES.has(value as AgentBriefFocus)) {
    return value as AgentBriefFocus;
  }
  throw Object.assign(new Error('--focus must be auto, mobile, web, or all'), { exitCode: 2 });
};

const parseInteger = (value: string, name: string, min: number, max: number): number => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw Object.assign(new Error(`${name} must be an integer between ${min} and ${max}`), {
      exitCode: 2,
    });
  }
  return parsed;
};

const parseEventList = (value: string | undefined): string[] | undefined => {
  if (!value) return undefined;
  const events = value.split(',').map((event) => event.trim()).filter(Boolean);
  if (events.length < 2 || events.length > 10) {
    throw Object.assign(new Error('--funnel must contain 2 to 10 comma-separated events'), {
      exitCode: 2,
    });
  }
  return events;
};

const parseRetentionDays = (value: string): number[] => {
  const days = Array.from(new Set(
    value.split(',').map((entry) => Number(entry.trim())),
  )).sort((left, right) => left - right);
  if (
    days.length === 0 ||
    days.length > 30 ||
    days.some((day) => !Number.isInteger(day) || day < 1 || day > 365)
  ) {
    throw Object.assign(new Error('--retention-days must contain 1 to 30 day offsets (1-365)'), {
      exitCode: 2,
    });
  }
  return days;
};

const renderTextBrief = (brief: ReturnType<typeof compileAgentBrief>): string => {
  const trend = brief.activity.changePercent === null
    ? 'n/a'
    : `${brief.activity.changePercent >= 0 ? '+' : ''}${brief.activity.changePercent}%`;
  const lines = [
    `Agent brief — ${brief.projectId}`,
    `mode: ${brief.dataMode} | focus: ${brief.focus} | range: ${brief.requestedRange}`,
    `freshness: ${brief.freshness.status}${brief.freshness.ageHours === null ? '' : ` (${brief.freshness.ageHours}h)`}`,
    `activity: ${brief.activity.eventCount} events / ${brief.activity.uniqueUsers} non-aggregate unique-user keys / half-window trend ${trend}`,
    `capabilities: ${brief.instrumentation.detectedCapabilities.join(', ') || 'none detected'}`,
    '',
    'Findings:',
    ...brief.findings.map(
      (finding) =>
        `- [${finding.severity}] ${finding.title}: ${finding.evidence} ${finding.recommendation}`,
    ),
    '',
    'Recommended bounded queries:',
    ...brief.recommendedQueries.map((query) => `- ${query}`),
  ];
  return lines.join('\n');
};

export const registerAgentCommands = (context: CliCommandContext): void => {
  const {
    program,
    withErrorHandling,
    getRootOptions,
    includeDebugFlag,
    resolveProjectId,
  } = context;
  const agent = program
    .command('agent')
    .description('Bounded, evidence-first context for coding agents');

  agent
    .command('brief')
    .description('Compile a model-ready product, instrumentation, and data-quality brief')
    .option('--project <id>', 'Project ID (optional when a default project is selected)')
    .option('--last <duration>', 'Bounded lookback (schema discovery supports up to 31d)', '14d')
    .option('--focus <focus>', 'auto|mobile|web|all', 'auto')
    .option('--limit <n>', 'Maximum top events and dimension rows', '25')
    .option('--funnel <events>', 'Optional explicit activation funnel, comma-separated')
    .option('--retention-anchor <event>', 'Optional explicit retention cohort anchor')
    .option('--retention-active <event>', 'Optional active event for retention')
    .option('--retention-days <days>', 'Retention offsets when an anchor is provided', '1,7,30')
    .action(
      async (options: {
        project?: string;
        last: string;
        focus: string;
        limit: string;
        funnel?: string;
        retentionAnchor?: string;
        retentionActive?: string;
        retentionDays: string;
      }) => {
        await withErrorHandling(async () => {
          const root = getRootOptions();
          const projectId = await resolveProjectId(options.project);
          const includeDebug = includeDebugFlag();
          const focus = parseFocus(options.focus);
          const limit = parseInteger(options.limit, '--limit', 1, 100);
          const funnelEvents = parseEventList(options.funnel);
          const retentionDays = parseRetentionDays(options.retentionDays);
          const apiOptions = {
            apiUrl: root.apiUrl,
            token: root.accessToken,
          };
          const genericBody = (
            metric: 'event_count' | 'unique_users',
            groupBy: string[],
            eventNames?: string[],
          ) => ({
            projectId,
            metric,
            groupBy,
            limit,
            orderBy: groupBy.includes('day') ? 'dimension_asc' : 'value_desc',
            last: options.last,
            includeDebug,
            ...(eventNames && eventNames.length > 0
              ? { filters: { eventNames } }
              : {}),
          });

          const schemaQuery = new URLSearchParams({
            projectId,
            limit: String(limit),
            last: options.last,
            includeDebug: String(includeDebug),
            orderBy: 'event_count_desc',
          });

          const schemaPayload = await requestApi(
            'GET',
            `/v1/schema/events?${schemaQuery.toString()}`,
            undefined,
            apiOptions,
          );
          const schemaEvents =
            (schemaPayload as { items?: SchemaEventSummary[] }).items ?? [];
          const identitySelection = selectAgentBriefIdentityEvents(schemaEvents);

          const [
            eventCounts,
            uniqueUsers,
            platforms,
            surfaces,
            dailyActivity,
            activationFunnel,
            retention,
          ] = await Promise.all([
            requestApi('POST', '/v1/query/generic', genericBody('event_count', []), apiOptions),
            identitySelection.eventNames.length > 0
              ? requestApi(
                  'POST',
                  '/v1/query/generic',
                  genericBody('unique_users', [], identitySelection.eventNames),
                  apiOptions,
                )
              : Promise.resolve(undefined),
            requestApi('POST', '/v1/query/generic', genericBody('event_count', ['platform']), apiOptions),
            requestApi('POST', '/v1/query/generic', genericBody('event_count', ['projectSurface']), apiOptions),
            requestApi('POST', '/v1/query/generic', genericBody('event_count', ['day']), apiOptions),
            funnelEvents
              ? requestApi(
                  'POST',
                  '/v1/query/funnel',
                  {
                    projectId,
                    steps: funnelEvents,
                    within: 'user',
                    last: options.last,
                    includeDebug,
                  },
                  apiOptions,
                )
              : Promise.resolve(undefined),
            options.retentionAnchor
              ? requestApi(
                  'POST',
                  '/v1/query/retention',
                  {
                    projectId,
                    anchorEvent: options.retentionAnchor,
                    activeEvent: options.retentionActive,
                    days: retentionDays,
                    maxAgeDays: Math.max(...retentionDays),
                    identityQuality: 'stable',
                    last: options.last,
                    includeDebug,
                  },
                  apiOptions,
                )
              : Promise.resolve(undefined),
          ]);
          const eventCountSnapshot = eventCounts as GenericQuerySnapshot;
          const uniqueUserSnapshot = uniqueUsers === undefined
            ? {
                ...eventCountSnapshot,
                metric: 'unique_users',
                groupBy: [],
                rows: [{ dimensions: {}, value: 0 }],
              }
            : uniqueUsers as GenericQuerySnapshot;

          const brief = compileAgentBrief({
            projectId,
            requestedRange: options.last,
            requestedFocus: focus,
            includeDebug,
            schemaEvents,
            eventCounts: eventCountSnapshot,
            uniqueUsers: uniqueUserSnapshot,
            identitySelection,
            platforms: platforms as GenericQuerySnapshot,
            surfaces: surfaces as GenericQuerySnapshot,
            dailyActivity: dailyActivity as GenericQuerySnapshot,
            activationFunnel,
            retention,
          });

          print(root.format, root.format === 'text' ? renderTextBrief(brief) : brief);
        });
      },
    );
};
