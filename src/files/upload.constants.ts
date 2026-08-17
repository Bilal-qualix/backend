/**
 * Where multer writes uploads and where the analyser reads them back from.
 * Read through a function rather than a module-level constant so tests can point
 * it at a temp directory without depending on import order.
 */
export function uploadDir(): string {
  return process.env.UPLOAD_DIR ?? './uploads';
}

/**
 * Extensions we can read as UTF-8 text. Checked alongside the mime type because
 * multer reports whatever the client sent — browsers routinely label .md files
 * as application/octet-stream.
 */
export const TEXT_EXTENSIONS = ['.txt', '.md', '.markdown', '.csv', '.json'];

export function isAnalysableAsText(mimeType: string, name: string): boolean {
  if (mimeType.startsWith('text/')) return true;
  if (mimeType === 'application/json') return true;
  return TEXT_EXTENSIONS.some((extension) =>
    name.toLowerCase().endsWith(extension),
  );
}
