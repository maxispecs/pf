import type { Plugin } from '@pulpfixer/kit/plugin';
import { pdfAdapter } from './adapter.js';
import { pdfCommand } from './commands/pdf.js';

export * from './api.js';
export { pdfCommand } from './commands/pdf.js';

/**
 * PDF files for pipes: the `pdf` IO adapter (a source that extracts lines, pages, positioned text, metadata and
 * form fields; a sink that lays rows out with a built-in, JSON or code template) and `pf pdf` to look at files and
 * write them. Pipe packages use `pdfSource` / `pdfSink` from `@pulpfixer/plugin-pdf/api`. It has no agent tools:
 * files hold user data.
 */
export const pdfPlugin: Plugin = {
  name: 'pdf',
  api: 3,
  summary: 'Read and write PDF files: the pdf adapter for pipes, pf pdf info / text / show / write / templates',
  commands: [pdfCommand],
  ioAdapters: [pdfAdapter],
  entries: (ctx) => [{ name: 'pdf', summary: 'Work with PDF files: info, text, show, write', group: 'Tools', run: () => pdfCommand.run(ctx, []) }],
};
