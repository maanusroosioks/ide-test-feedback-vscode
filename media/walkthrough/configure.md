# Configure the submission service

Moodle Test Submit sends your local test results to your course's submission
service. It needs to know **where** that service lives and **which assignment**
a project belongs to.

Run **Moodle Submit: Configure Assignment** to set:

- **Service URL**: the base URL your instructor gave you
  (e.g. `https://moodle-bridge.example.edu`). It's saved to your user settings,
  so it applies to every project.
- **Assignment key**: saved to the open project's `.moodle-submit.json`. If your
  instructor's starter code already has one, just confirm it.

You can change these any time from the same command. The service URL is under
`moodleSubmit` in your **User** settings; a project's own settings can't change it.
