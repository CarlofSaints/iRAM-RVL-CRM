import { authFetch } from './useAuth';

/**
 * Open a PDF from an API that needs the auth header (a plain link can't send
 * it) in a new tab, falling back to a download if pop-ups are blocked.
 * Returns the API's error message, or '' on success.
 */
export async function openAuthedPdf(url: string, fileName: string): Promise<string> {
  const res = await authFetch(url);
  if (!res.ok) return (await res.json().catch(() => ({}))).error || 'Could not open the PDF';
  const blobUrl = URL.createObjectURL(await res.blob());
  if (!window.open(blobUrl, '_blank')) {
    const a = document.createElement('a');
    a.href = blobUrl; a.download = fileName;
    document.body.appendChild(a); a.click(); a.remove();
  }
  // The new tab has loaded it by then; frees the PDF held for this page.
  setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
  return '';
}
