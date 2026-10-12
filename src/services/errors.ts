import { MoodleSubmitError } from '../core/errors';

export class TimeoutError extends MoodleSubmitError {}

export class MissingServiceUrlError extends MoodleSubmitError {
  constructor() {
    super('No serviceUrl configured. Run "IDE Test Feedback: Configure Assignment" first.');
  }
}

export class InvalidServiceUrlError extends MoodleSubmitError {
  constructor(problem: string) {
    super(`The ideTestFeedback.serviceUrl setting is not usable: ${problem}`);
  }
}

export class NetworkError extends MoodleSubmitError {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
  }
}

const MAX_BODY_IN_MESSAGE = 500;

export class HttpError extends MoodleSubmitError {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`Request failed with status ${status}`);
  }

  /** Capped: a proxy's error page can be a whole HTML document. */
  get userMessage(): string {
    const body = this.body.length > MAX_BODY_IN_MESSAGE ? `${this.body.slice(0, MAX_BODY_IN_MESSAGE)}…` : this.body;
    return `Submission service returned ${this.status}: ${body}`;
  }
}
