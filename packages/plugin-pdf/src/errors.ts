/** A problem with a PDF file, a template or the pdf configuration. `hint` says what to do about it. */
export class PdfError extends Error {
  readonly hint?: string;
  constructor(message: string, hint?: string) {
    super(message);
    this.name = 'PdfError';
    if (hint) this.hint = hint;
  }
}
