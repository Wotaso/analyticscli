import type { CliCommandContext } from '../context.js';
import { registerCoreQueryCommands } from './core.js';
import { registerOnboardingJourneyCommand } from './onboarding-journey.js';

export const registerQueryCommands = (context: CliCommandContext): void => {
  const getCommand = context.program.command('get').description('Curated analytics snapshots');

  registerOnboardingJourneyCommand(getCommand, context);
  registerCoreQueryCommands(context.program, context);
};
