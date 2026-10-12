# Run tests & submit

Open a project that has tests (Maven, Gradle, pytest, or `dotnet test`) and run
**IDE Test Feedback: Run Tests & Submit to Moodle**.

The extension auto-detects your test framework, runs it, and uploads the
results. Use **IDE Test Feedback: Run Tests (No Submit)** if you just want a local
run.

Each project's assignment key lives in a `.ide-test-feedback.json` file at the
project root. If it's missing, you'll be asked for the key before the tests run:

```json
{
  "assignmentKey": "your-assignment-key"
}
```
