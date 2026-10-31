/** Hands the browser a file to save. */
export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

/** Hands the browser a text file to save. */
export function downloadText(filename: string, text: string): void {
  downloadBlob(filename, new Blob([text], { type: "text/csv;charset=utf-8" }));
}
