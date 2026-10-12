/** Each is also declared under `contributes.commands` in package.json. */
export const COMMANDS = {
  runAndSubmit: 'ideTestFeedback.runAndSubmit',
  runTestsOnly: 'ideTestFeedback.runTestsOnly',
  login: 'ideTestFeedback.login',
  logout: 'ideTestFeedback.logout',
  configureAssignment: 'ideTestFeedback.configureAssignment',
  showOutput: 'ideTestFeedback.showOutput',
} as const;
