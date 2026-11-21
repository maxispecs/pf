/** A problem with an IO adapter, a pipe or its configuration. `hint` is a command that may fix it. */
export class IoError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'IoError';
  }
}
