/** An error with advice: the message says what failed, the hint says what to run. */
export class DbError extends Error {
  readonly hint: string | undefined;
  constructor(message: string, hint?: string) {
    super(message);
    this.name = 'DbError';
    this.hint = hint;
  }
}
