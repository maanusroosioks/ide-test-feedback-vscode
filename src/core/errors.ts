export class MoodleSubmitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }

  get userMessage(): string {
    return this.message;
  }
}

export class CancelledError extends MoodleSubmitError {
  constructor() {
    super('Run cancelled.');
  }
}

export function describeError(error: unknown): string {
  if (error instanceof MoodleSubmitError) return error.userMessage;
  if (error instanceof Error) return error.message;
  return String(error);
}
