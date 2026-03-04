import type { Command } from 'commander';
import {
  asTimeseriesPoints,
  computeTrendFromTimeseriesPoints,
  formatTrendSummary,
  print,
  resolveFlowSelectorOption,
  resolveProjectOption,
} from '../../analytics-utils.js';
import { requestApi } from '../../http.js';
import {
  renderHorizontalBars,
  renderTable,
  renderTimeseriesSvg,
  writeSvgToFile,
} from '../../render.js';
import type { TimeseriesPoint } from '../../render.js';
import type { CliCommandContext } from '../context.js';
import { registerAdvancedQueryCommands } from './core-advanced.js';

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

export const registerCoreQueryCommands = (
  program: Command,
  context: CliCommandContext,
): void => {
  const { withErrorHandling, getRootOptions, includeDebugFlag } = context;

  program
    .command('funnel')
    .requiredOption('--project <id>', 'Project ID')
    .requiredOption('--steps <steps>', 'Comma-separated event steps')
    .option('--within <scope>', 'session|user', 'session')
    .option('--last <duration>', 'Time range like 7d', '7d')
    .option('--app-version <version>', 'Filter by appVersion')
    .option('--flow-id <id>', 'Filter by onboardingFlowId')
    .option('--flow-version <version>', 'Filter by onboardingFlowVersion')
    .option('--variant <name>', 'Filter by experimentVariant (A/B variant)')
    .option('--paywall-id <id>', 'Filter by paywallId')
    .option('--source <name>', 'Filter by properties.source')
    .action(async (options: RootQueryOptions & { steps: string; within: string }) => {
      await withErrorHandling(async () => {
        const root = getRootOptions();
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
            ...resolveFlowSelectorOption(options),
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
    .option('--app-version <version>', 'Filter by appVersion')
    .option('--flow-id <id>', 'Filter by onboardingFlowId')
    .option('--flow-version <version>', 'Filter by onboardingFlowVersion')
    .option('--variant <name>', 'Filter by experimentVariant (A/B variant)')
    .option('--paywall-id <id>', 'Filter by paywallId')
    .option('--source <name>', 'Filter by properties.source')
    .action(async (options: RootQueryOptions & { from: string; to: string; within: string }) => {
      await withErrorHandling(async () => {
        const root = getRootOptions();
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
            ...resolveFlowSelectorOption(options),
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
    .option('--app-version <version>', 'Filter by appVersion')
    .option('--flow-id <id>', 'Filter by onboardingFlowId')
    .option('--flow-version <version>', 'Filter by onboardingFlowVersion')
    .option('--variant <name>', 'Filter by experimentVariant (A/B variant)')
    .option('--paywall-id <id>', 'Filter by paywallId')
    .option('--source <name>', 'Filter by properties.source')
    .action(async (options: RootQueryOptions & { start: string; complete: string; within: string }) => {
      await withErrorHandling(async () => {
        const root = getRootOptions();
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
            ...resolveFlowSelectorOption(options),
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
    .option('--app-version <version>', 'Filter by appVersion')
    .option('--flow-id <id>', 'Filter by onboardingFlowId')
    .option('--flow-version <version>', 'Filter by onboardingFlowVersion')
    .option('--variant <name>', 'Filter by experimentVariant (A/B variant)')
    .option('--paywall-id <id>', 'Filter by paywallId')
    .option('--source <name>', 'Filter by properties.source')
    .action(async (options: RootQueryOptions & { from: string; top: string; within: string }) => {
      await withErrorHandling(async () => {
        const root = getRootOptions();
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
            ...resolveFlowSelectorOption(options),
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
    .option('--trend', 'Include trend from first to latest bucket', false)
    .option('--out <path>', 'Output file path for svg mode', './timeseries.svg')
    .option('--app-version <version>', 'Filter by appVersion')
    .option('--flow-id <id>', 'Filter by onboardingFlowId')
    .option('--flow-version <version>', 'Filter by onboardingFlowVersion')
    .option('--variant <name>', 'Filter by experimentVariant (A/B variant)')
    .option('--paywall-id <id>', 'Filter by paywallId')
    .option('--source <name>', 'Filter by properties.source')
    .action(
      async (
        options: RootQueryOptions & {
          metric: string;
          event?: string;
          interval: string;
          viz?: string;
          trend?: boolean;
          out?: string;
        },
      ) => {
        await withErrorHandling(async () => {
          const root = getRootOptions();
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
              ...resolveFlowSelectorOption(options),
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
          const points = asTimeseriesPoints(payload);
          const trend = options.trend ? computeTrendFromTimeseriesPoints(points) : null;
          if (vizMode === 'table') {
            const table = renderTable(
              ['timestamp', 'value'],
              points.map((point) => [point.ts, point.value]),
            );
            const text = options.trend ? `${table}\n\ntrend: ${formatTrendSummary(trend)}` : table;
            print('text', text);
            return;
          }

          if (vizMode === 'chart') {
            const chart = renderHorizontalBars(
              points.map((point) => ({
                label: point.ts,
                value: point.value,
              })),
            );
            const text = options.trend ? `${chart}\n\ntrend: ${formatTrendSummary(trend)}` : chart;
            print('text', text);
            return;
          }

          if (vizMode === 'none') {
            const output = options.trend ? { ...payload, trend } : payload;
            print(root.format, output);
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
              ...(options.trend ? { trend } : {}),
            });
            return;
          }

          throw Object.assign(new Error('Invalid --viz mode. Use none|table|chart|svg'), { exitCode: 2 });
        });
      },
    );
  registerAdvancedQueryCommands(program, context);
};
