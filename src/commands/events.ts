import { mkdir, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { print } from '../analytics-utils.js';
import { requestApi, requestCsvExport, requestFileDownload } from '../http.js';
import type { CliCommandContext } from './context.js';

type EventExportJob = {
  id: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  filename: string;
  since: string;
  until: string;
  format: 'csv';
  includeDebug: boolean;
  processedEvents: number;
  estimatedEvents: number | null;
  partCount: number;
  errorMessage: string | null;
  downloadPath: string | null;
};

type CreateEventExportJobResponse = {
  ok: true;
  created: boolean;
  job: EventExportJob;
};

type GetEventExportJobResponse = {
  job: EventExportJob;
};

const JOB_POLL_INTERVAL_MS = 2_000;

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const enqueueHistoricalExport = async (input: {
  apiUrl?: string;
  token?: string;
  projectId: string;
  since?: string;
  until?: string;
  last?: string;
  includeDebug: boolean;
}): Promise<CreateEventExportJobResponse> => {
  const payload = (await requestApi(
    'POST',
    '/v1/export/jobs/events',
    {
      projectId: input.projectId,
      since: input.since,
      until: input.until,
      last: input.last,
      includeDebug: input.includeDebug,
    },
    {
      apiUrl: input.apiUrl,
      token: input.token,
    },
  )) as CreateEventExportJobResponse;

  return payload;
};

const fetchHistoricalExportJob = async (input: {
  apiUrl?: string;
  token?: string;
  jobId: string;
}): Promise<EventExportJob> => {
  const payload = (await requestApi('GET', `/v1/export/jobs/events/${input.jobId}`, undefined, {
    apiUrl: input.apiUrl,
    token: input.token,
  })) as GetEventExportJobResponse;

  return payload.job;
};

const waitForHistoricalExportJob = async (input: {
  apiUrl?: string;
  token?: string;
  job: EventExportJob;
  format: 'json' | 'text';
  quiet?: boolean;
}): Promise<EventExportJob> => {
  let job = input.job;
  let lastStatus = '';
  let pollCount = 0;

  while (job.status === 'pending' || job.status === 'running') {
    if (input.format === 'text' && !input.quiet) {
      const shouldPrint = lastStatus !== job.status || pollCount % 5 === 0;
      if (shouldPrint) {
        const estimate =
          typeof job.estimatedEvents === 'number' ? `/${job.estimatedEvents} events` : '';
        print(
          'text',
          `Export job ${job.id}: ${job.status} (${job.processedEvents}${estimate}, ${job.partCount} parts)`,
        );
      }
    }

    lastStatus = job.status;
    pollCount += 1;
    await sleep(JOB_POLL_INTERVAL_MS);
    job = await fetchHistoricalExportJob({
      apiUrl: input.apiUrl,
      token: input.token,
      jobId: job.id,
    });
  }

  if (job.status === 'failed') {
    const error = new Error(job.errorMessage ?? 'Export job failed') as Error & {
      exitCode?: number;
      payload?: unknown;
    };
    error.exitCode = 4;
    error.payload = {
      error: {
        message: job.errorMessage ?? 'Export job failed',
        details: {
          jobId: job.id,
        },
      },
    };
    throw error;
  }

  return job;
};

const downloadHistoricalExportToFile = async (input: {
  apiUrl?: string;
  token?: string;
  job: EventExportJob;
  outPath?: string;
}): Promise<string> => {
  if (!input.job.downloadPath) {
    throw Object.assign(new Error('Export job does not have a download path'), { exitCode: 4 });
  }

  const download = await requestFileDownload(input.job.downloadPath, {
    apiUrl: input.apiUrl,
    token: input.token,
  });
  const outPath = input.outPath ? String(input.outPath) : `./${download.filename}`;
  await mkdir(dirname(outPath), { recursive: true });
  await pipeline(Readable.fromWeb(download.body as any), createWriteStream(outPath));
  return outPath;
};

const maybeAsyncExportHint = (error: unknown): { since: string; until: string } | null => {
  const typed = error as {
    payload?: {
      error?: {
        details?: {
          asyncSupported?: unknown;
          since?: unknown;
          until?: unknown;
        };
      };
    };
  };

  const details = typed.payload?.error?.details;
  if (
    details?.asyncSupported === true &&
    typeof details.since === 'string' &&
    typeof details.until === 'string'
  ) {
    return {
      since: details.since,
      until: details.until,
    };
  }

  return null;
};

const runHistoricalExport = async (input: {
  apiUrl?: string;
  token?: string;
  format: 'json' | 'text';
  quiet?: boolean;
  projectId: string;
  since?: string;
  until?: string;
  last?: string;
  includeDebug: boolean;
  outPath?: string;
}): Promise<void> => {
  const created = await enqueueHistoricalExport({
    apiUrl: input.apiUrl,
    token: input.token,
    projectId: input.projectId,
    since: input.since,
    until: input.until,
    last: input.last,
    includeDebug: input.includeDebug,
  });

  if (input.format === 'text' && !input.quiet) {
    const action = created.created ? 'queued' : 'reused';
    print('text', `Export job ${created.job.id} ${action} for ${created.job.since} -> ${created.job.until}`);
  }

  const finishedJob = await waitForHistoricalExportJob({
    apiUrl: input.apiUrl,
    token: input.token,
    job: created.job,
    format: input.format,
    quiet: input.quiet,
  });
  const outPath = await downloadHistoricalExportToFile({
    apiUrl: input.apiUrl,
    token: input.token,
    job: finishedJob,
    outPath: input.outPath,
  });

  if (input.format === 'text') {
    print('text', `Export gespeichert: ${outPath}`);
    return;
  }

  print('json', {
    ok: true,
    file: outPath,
    jobId: finishedJob.id,
    since: finishedJob.since,
    until: finishedJob.until,
    format: finishedJob.format,
  });
};

const validateRangeOptions = (options: {
  since?: string;
  until?: string;
  last?: string;
}): void => {
  const hasLast = typeof options.last === 'string' && options.last.trim().length > 0;
  const hasSince = typeof options.since === 'string' && options.since.trim().length > 0;
  const hasUntil = typeof options.until === 'string' && options.until.trim().length > 0;

  if (!hasLast && !hasSince && !hasUntil) {
    throw Object.assign(new Error('Use --last or the pair --since and --until'), {
      exitCode: 2,
    });
  }

  if (hasLast && (hasSince || hasUntil)) {
    throw Object.assign(new Error('Use either --last or --since/--until, not both'), {
      exitCode: 2,
    });
  }

  if (!hasLast && hasSince !== hasUntil) {
    throw Object.assign(new Error('--since and --until must be provided together'), {
      exitCode: 2,
    });
  }
};

export const registerEventCommands = (context: CliCommandContext): void => {
  const { program, withErrorHandling, getRootOptions, includeDebugFlag } = context;

  const events = program.command('events').description('Event export helpers');

  events
    .command('months')
    .description('List months with available events for a given year')
    .requiredOption('--project <id>', 'Project ID')
    .requiredOption('--year <year>', 'UTC year, e.g. 2026')
    .action(async (options: { project: string; year: string }) => {
      await withErrorHandling(async () => {
        const root = getRootOptions();
        const qs = new URLSearchParams({
          projectId: options.project,
          year: String(Number(options.year)),
          includeDebug: String(includeDebugFlag()),
        });

        const payload = await requestApi('GET', `/v1/export/events/months?${qs.toString()}`, undefined, {
          apiUrl: root.apiUrl,
          token: root.token,
        });
        print(root.format, payload);
      });
    });

  events
    .command('export')
    .description('Download monthly events export as CSV')
    .requiredOption('--project <id>', 'Project ID')
    .requiredOption('--year <year>', 'UTC year, e.g. 2026')
    .requiredOption('--month <month>', 'UTC month number 1-12')
    .option('--out <path>', 'Output file path')
    .action(async (options: { project: string; year: string; month: string; out?: string }) => {
      await withErrorHandling(async () => {
        const root = getRootOptions();
        const year = Number(options.year);
        const month = Number(options.month);
        const qs = new URLSearchParams({
          projectId: options.project,
          year: String(year),
          month: String(month),
          format: 'csv',
          includeDebug: String(includeDebugFlag()),
        });

        try {
          const { csv, filename } = await requestCsvExport(`/v1/export/events/download?${qs.toString()}`, {
            apiUrl: root.apiUrl,
            token: root.token,
          });

          const outPath = options.out ? String(options.out) : `./${filename}`;
          await mkdir(dirname(outPath), { recursive: true });
          await writeFile(outPath, csv, 'utf8');

          if (root.format === 'text') {
            print('text', `Export gespeichert: ${outPath}`);
            return;
          }

          print(root.format, {
            ok: true,
            file: outPath,
            year,
            month,
            format: 'csv',
          });
        } catch (error) {
          const asyncRange = maybeAsyncExportHint(error);
          if (!asyncRange) {
            throw error;
          }

          await runHistoricalExport({
            apiUrl: root.apiUrl,
            token: root.token,
            format: root.format,
            quiet: root.quiet,
            projectId: options.project,
            since: asyncRange.since,
            until: asyncRange.until,
            includeDebug: includeDebugFlag(),
            outPath: options.out,
          });
        }
      });
    });

  events
    .command('export-range')
    .description('Queue and download a historical events export for an arbitrary range')
    .requiredOption('--project <id>', 'Project ID')
    .option('--since <iso>', 'UTC start timestamp, e.g. 2025-01-01T00:00:00.000Z')
    .option('--until <iso>', 'UTC end timestamp, e.g. 2025-02-01T00:00:00.000Z')
    .option('--last <duration>', 'Relative range like 90d')
    .option('--out <path>', 'Output file path')
    .action(
      async (options: {
        project: string;
        since?: string;
        until?: string;
        last?: string;
        out?: string;
      }) => {
        await withErrorHandling(async () => {
          validateRangeOptions(options);

          const root = getRootOptions();
          await runHistoricalExport({
            apiUrl: root.apiUrl,
            token: root.token,
            format: root.format,
            quiet: root.quiet,
            projectId: options.project,
            since: options.since,
            until: options.until,
            last: options.last,
            includeDebug: includeDebugFlag(),
            outPath: options.out,
          });
        });
      },
    );
};
