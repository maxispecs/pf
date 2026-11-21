/**
 * The API for pipe packages (`@pulpfixer/pipe-<name>`): `pdfSource` and `pdfSink` declare a PDF file as an
 * input or an output (see `@pulpfixer/plugin-io/api` for `definePipes` and the chain helpers), and
 * `definePdfTemplate` writes a layout in code. `PdfDoc` is the drawing API a template gets.
 */
export { pdfAdapter, pdfSource, pdfSink, selectPages, extractRows, EXTRACT_MODES, PDF_MODES, type ExtractMode, type PdfConfig, type PdfMode, type PdfSinkConfig, type PdfSourceConfig } from './adapter.js';
export { PdfError } from './errors.js';
export { openPdf, parsePageRange, decodeTextString, parsePdfDate, PdfFile, type PdfField, type PdfInfo, type PageSize } from './read/extract.js';
export type { TextItem } from './read/content.js';
export type { Line } from './read/layout.js';
export { PdfDoc, PdfTable, PAGE_SIZES, parseColor, type Color, type DocMeta, type PageSetup, type PageSizeName, type TableColumn, type TableOptions, type TextOptions, type TextStyle } from './write/doc.js';
export { STD_FONTS, parseFont, stringWidth, type StdFont } from './metrics.js';
export { definePdfTemplate, validatePdfTemplate, type PdfTemplate, type TemplateContext } from './templates/types.js';
export { BUILTIN_TEMPLATES, parseColumns } from './templates/builtin.js';
export { validateLayout, layoutTemplate, parseLayoutText, starterLayout, expand, LAYOUT_SCHEMA, type Band, type Block, type Body, type Layout } from './templates/json.js';
export { resolveTemplate, loadLayoutFile, listUserTemplates, userTemplateDir } from './templates/resolve.js';
export { PdfRenderer, renderPdf, type RenderOptions } from './templates/render.js';
