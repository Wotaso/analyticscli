import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { print } from '../analytics-utils.js';
import { requestApi, requestCsvExport } from '../http.js';
import type { CliCommandContext } from './context.js';

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
      });
    });
};
