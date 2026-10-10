/** Each is also declared under `contributes.commands` in package.json. */
export const COMMANDS = {
  runAndSubmit: 'moodleSubmit.runAndSubmit',
  runTestsOnly: 'moodleSubmit.runTestsOnly',
  login: 'moodleSubmit.login',
  logout: 'moodleSubmit.logout',
  configureAssignment: 'moodleSubmit.configureAssignment',
  showOutput: 'moodleSubmit.showOutput',
} as const;
