import * as vscode from 'vscode';
import { AdapterRegistry } from './runner/registry';
import { ALL_ADAPTERS } from './ecosystems';
import { AuthService } from './auth/authService';
import { MoodleApiClient } from './services/moodleApiClient';
import { getAuthScopes, getRequestTimeoutMs, getServiceUrl } from './config/settings';
import { registerRunCommand } from './commands/run';
import { registerLoginCommand } from './commands/login';
import { registerLogoutCommand } from './commands/logout';
import { registerConfigureAssignmentCommand } from './commands/configureAssignment';
import { registerShowOutputCommand } from './commands/showOutput';
import { createOutputChannelLogger, getOutputChannel } from './ui/outputChannel';
import { createStatusReporter } from './ui/statusBar';
import { registerTestController } from './ui/testController';
import { maybePromptOnboarding, refreshConfiguredContext } from './ui/onboarding';

export function activate(context: vscode.ExtensionContext): void {
  const registry = new AdapterRegistry();
  for (const adapter of ALL_ADAPTERS) {
    registry.register(adapter);
  }

  const authService = new AuthService(getAuthScopes);
  const apiClient = new MoodleApiClient({
    getBaseUrl: getServiceUrl,
    getTimeoutMs: getRequestTimeoutMs,
    getAccessToken: (opts) => authService.getAccessToken(opts),
  });

  const logger = createOutputChannelLogger();
  const status = createStatusReporter();
  context.subscriptions.push(getOutputChannel(), status);

  const testControl = registerTestController(context, {
    registry,
    authService,
    apiClient,
    logger,
    status,
  });

  registerRunCommand(context, 'moodleSubmit.runAndSubmit', true, testControl, logger, status);
  registerRunCommand(context, 'moodleSubmit.runTestsOnly', false, testControl, logger, status);
  registerLoginCommand(context, authService);
  registerLogoutCommand(context, authService);
  registerConfigureAssignmentCommand(context, authService);
  registerShowOutputCommand(context);

  refreshConfiguredContext();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('moodleSubmit.serviceUrl')) {
        refreshConfiguredContext();
      }
    }),
  );
  void maybePromptOnboarding(context);
}

export function deactivate(): void {}
