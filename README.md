# Moodle Test Submit

A VS Code extension that runs your project's unit tests and submits the results to
Moodle. It detects the test framework, runs the suite, and posts a structured run to
your course's submission service — authenticated with your Microsoft (Entra ID)
account.

## Features

- **Zero-config test detection** for Maven, Gradle, pytest, and .NET.
- **Results in VS Code's Test Explorer**, with per-test pass/fail state, durations,
  failure messages, and gutter markers on the failing line.
- **Run-only mode** to check tests locally without submitting.
- **Microsoft / Entra ID sign-in** via VS Code's built-in authentication — the
  extension stores no passwords or tokens.
- **Per-project assignment keys** in a `.moodle-submit.json` that can ship with the starter code.
- **The source of each test is submitted with its result**, so your instructor sees the
  code behind every pass and fail.
- Guided first-run setup, status-bar progress, and a dedicated output log.

## Setup

1. Install the extension.
2. Run **Moodle Submit: Configure Assignment** and enter the submission service URL
   your course provides (e.g. `https://moodle-bridge.example.edu`).
3. Enter the project's assignment key when asked. It's saved to the project's
   `.moodle-submit.json`; if your instructor's starter code already has one, just
   confirm it.
4. Sign in with Microsoft when prompted.
5. Open a project with tests and run **Run Tests & Submit to Moodle**.

### `.moodle-submit.json`

Placed at the root of a workspace folder, and meant to be committed — an instructor can ship
it with the starter code so students never type the key. It identifies the assignment and
nothing else. Only `assignmentKey` is required; `projectName` defaults to the folder name.
VS Code validates the file as you edit it.

```json
{
  "assignmentKey": "cs101-assignment-3",
  "projectName": "linked-list"
}
```

The commit and repository URL are always read from git, never from this file. Submitting from
a project without a key asks for one before the tests run.

## Test Explorer

Runs also appear in VS Code's **Testing** view under a **Moodle Tests** controller.
The normal run button runs the suite and submits nothing. To submit, use either:

- the **cloud-upload button** in the Testing view toolbar, or
- **right-click** any folder, suite, or test → *Run Tests & Submit to Moodle*

Both run the project's tests and then submit, exactly like the palette command.
Submitting is deliberately a button rather than a second run profile, so there is no
hidden mode to keep track of and no way to submit by accident. Runs that submitted are
labelled *Run & Submit to Moodle* in the Test Results history.

Test command output streams into the run's terminal, and the tree stays populated
across window reloads.

Current limitations:

- Tests appear only **after the first run** — Maven and Gradle offer no reliable way
  to enumerate tests without executing them, so there's no up-front discovery.
- Running a single test or suite from the gutter still runs the whole project; the
  per-framework test filters aren't wired up yet.
- Failing tests get a file **and** a line; passing tests get only the file, since a
  location is derived from the stack trace.
- If you also have the Java or Python test extensions installed, their controllers
  appear alongside this one. Only **Moodle Tests** submits.

## Commands

| Command | What it does |
| --- | --- |
| Moodle Submit: Run Tests & Submit to Moodle | Detect, run, parse, and submit. |
| Moodle Submit: Run Tests (No Submit) | Detect, run, and parse only. |
| Moodle Submit: Sign In with Microsoft | Start a Microsoft auth session. |
| Moodle Submit: Sign Out | Explains how to remove the account from the Accounts menu. |
| Moodle Submit: Configure Assignment | Set the service URL and the project's assignment key. |
| Moodle Submit: Show Log | Reveal the output channel. |

## What gets submitted

Each run posts the results **and the test files that produced them**. Per test:

- `testSuite`, `testName`, `status`, `durationMs`, and the failure `message`
- `source` — where the test lives: its file path relative to the workspace folder, and the
  line range of its declaration. When a test can't be matched to a declaration only
  `path` is sent; when the file can't be found at all, `source` is omitted and only the
  framework's own report is sent.

Alongside the results, `testFiles` carries **each test file once** — its workspace-relative
path and its contents. A test's code is read by slicing its line range out of its file, so no
test body is sent twice, and imports, fixtures and setup methods come along with it. With
capture off, or once the size budget is spent, a file is listed without its `content`.

Deliberately **not** submitted: raw stack traces, absolute file paths (a path outside the
workspace folder is reduced to its filename), and anything about your machine or account
beyond the identity in your sign-in token.

One flag is sent alongside the results, and only when it applies:

- `captureDisabled` — you switched source capture off. Without it, a submission with no
  code would be indistinguishable from one where the extension couldn't find your sources.

### The pre-submit check is local

The extension checks your tests for empty bodies, missing assertions and skip markers such
as `@Disabled` or `@pytest.mark.skip`, and warns you before submitting if a run looks
degraded. The findings stay on your machine — **nothing about the check is submitted**,
including whether the warning was shown. It's there to catch a test you accidentally
emptied or left disabled.

It never blocks a submission, and it can be switched off with
`moodleSubmit.warnOnSuspiciousTests` — which silences the dialog but does not change what
is sent.

What your instructor reads is the test code itself, which is the thing worth reading.

### For the gateway and Moodle plugin

`testFiles[].content` carries code verbatim, including `<` and `>` (`List<String>`,
`Assert.Throws<T>`). It **must** be declared `PARAM_RAW` on the Moodle side — running it
through `PARAM_TEXT` would strip those via `strip_tags`. The extension does sanitize
`testSuite`, `testName` and `message` for `PARAM_TEXT`, since those are display fields.

Join a result to its file with `source.path` == `testFiles[].path`, then slice
`startLine`..`endLine` (1-based, inclusive) out of `content`. Content is LF-normalized, and a
`truncated` file is cut at a character boundary, so line numbers still hold for what remains.

The extension keeps to the gateway's validation limits before sending: an `assignmentKey`
of at most 100 characters from `[A-Za-z0-9_-]`, at most 5000 results and 200 test files,
and the `@Size` limits on each text field. Past 200 files, the files are kept in path order
and the results whose file was left out are sent with no `source`, so every `source.path`
always has a matching `testFiles` entry.

## Settings

Settings cover your machine and preferences; what the assignment *is* lives in
`.moodle-submit.json`.

**Connection** — user settings only. A project's `.vscode/settings.json` cannot set these, so a
cloned repository can't redirect where your sign-in token is sent.

| Setting | Default | Description |
| --- | --- | --- |
| `moodleSubmit.serviceUrl` | `""` | Base URL of the submission service. |
| `moodleSubmit.authScopes` | `["User.Read"]` | OAuth scopes requested from the Microsoft provider. Change only for a different deployment. |
| `moodleSubmit.requestTimeoutMs` | `15000` | Timeout for requests to the service (1 000–120 000). |

**Running tests** — can differ per folder.

| Setting | Default | Description |
| --- | --- | --- |
| `moodleSubmit.preferredAdapter` | – | Force `maven-junit`, `gradle-junit`, `pytest`, or `dotnet-test` instead of auto-detecting. |
| `moodleSubmit.testCommandOverrides` | `{}` | Per-adapter command overrides, e.g. `{ "maven-junit": "mvn -Pci test" }`. |

**Source capture** — can differ per folder.

| Setting | Default | Description |
| --- | --- | --- |
| `moodleSubmit.submitTestSource` | `true` | Submit the source of each test. Turning this off still submits where each test was found. |
| `moodleSubmit.maxTotalSourceChars` | `500000` | Cap on the source captured per submission (at most 1 000 000). |
| `moodleSubmit.warnOnSuspiciousTests` | `true` | Warn before submitting when tests look emptied or disabled. Never blocks. |

### Workspace trust

Running tests executes the project's own build and test code, so the extension is disabled in
Restricted Mode. Trust the folder to use it.

## Supported test frameworks

| Adapter | Detected by | Default command |
| --- | --- | --- |
| Maven (JUnit) | `pom.xml` | `mvnw -B test -Dmaven.test.failure.ignore=true` (or `mvn …`) |
| Gradle (JUnit) | `build.gradle(.kts)` / `settings.gradle(.kts)` | `gradlew cleanTest test --continue` (or `gradle …`) |
| pytest | `pytest.ini`, `pyproject.toml`, `setup.cfg`, `conftest.py`, or `test_*.py` / `*_test.py` files | `python -m pytest --junit-xml=…` |
| .NET | `*.csproj` / `*.sln` / `*.slnx`, or a `*Tests.csproj` one folder down | `dotnet test --logger trx …` |

The project's own Maven or Gradle wrapper is used when it has one; otherwise `mvn` or
`gradle` must be on your `PATH`. pytest runs with the Python in the project's `.venv`,
`venv` or `env` folder if there is one, and otherwise with `python3` (`py -3` or `python`
on Windows). `dotnet` must be on your `PATH`. A run that produces zero results is
reported as an error, since it almost always means the command itself failed to start.

## Development

```bash
npm install
npm run watch      # esbuild bundle in watch mode
npm run typecheck  # tsc --noEmit
npm run lint
npm test           # vitest
```

Press <kbd>F5</kbd> to launch the Extension Development Host. `npm run package`
produces the production bundle; `npx vsce package` builds a `.vsix`.
