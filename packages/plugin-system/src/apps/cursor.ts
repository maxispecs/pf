import { editorAdapter } from './editor.js';

export const cursorApp = editorAdapter({
  id: 'cursor',
  label: 'Cursor',
  configDir: 'Cursor',
  cli: 'cursor',
  macCli: '/Applications/Cursor.app/Contents/Resources/app/bin/cursor',
});
