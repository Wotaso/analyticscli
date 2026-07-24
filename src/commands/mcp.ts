import { startAnalyticsMcpServer } from '../mcp-server.js';
import type { CliCommandContext } from './context.js';

export const registerMcpCommand = (context: CliCommandContext): void => {
  const { program, getRootOptions } = context;

  program
    .command('mcp')
    .description('Start the read-only AnalyticsCLI MCP server over stdio')
    .option('--max-tool-calls <n>', 'Bounded tool-call budget for this MCP process', '100')
    .action(async (options: { maxToolCalls: string }) => {
      const parsedBudget = Number(options.maxToolCalls);
      if (!Number.isInteger(parsedBudget) || parsedBudget < 1 || parsedBudget > 10_000) {
        throw Object.assign(
          new Error('--max-tool-calls must be an integer between 1 and 10000'),
          { exitCode: 2 },
        );
      }
      const root = getRootOptions();
      await startAnalyticsMcpServer({
        apiUrl: root.apiUrl,
        token: root.accessToken,
        rootProjectId: root.project,
        maxToolCalls: parsedBudget,
      });
    });
};
