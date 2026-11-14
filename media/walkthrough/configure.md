# Configure the submission service

IDE Test Feedback sends your local test results to your course's submission
service. It needs to know **where** that service lives and **which assignment**
a project belongs to.

Run **IDE Test Feedback: Configure Assignment** to set:

- **Service URL**: pre-filled with the default service. Change it only if your
  instructor gave you a different one. It's saved to your user settings,
  so it applies to every project.
- **Assignment key**: saved to the open project's `.ide-test-feedback.json`. If your
  instructor's starter code already has one, just confirm it.

You can change these any time from the same command. The service URL is under
`ideTestFeedback` in your **User** settings; a project's own settings can't change it.
