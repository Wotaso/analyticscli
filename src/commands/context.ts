import type { Command } from 'commander';
import type { OutputFormat } from '../types.js';

export type RootCliOptions = {
  apiUrl?: string;
  token?: string;
  format: OutputFormat;
  includeDebug?: boolean;
  quiet?: boolean;
};

export type CliCommandContext = {
  program: Command;
  withErrorHandling: (fn: () => Promise<void>) => Promise<void>;
  getRootOptions: () => RootCliOptions;
  includeDebugFlag: () => boolean;
};
