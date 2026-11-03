import * as Print from 'expo-print';

/** Opens the system print dialog (or "save as PDF") for a self-contained HTML page. */
export async function printHtml(html: string): Promise<void> {
  await Print.printAsync({ html });
}
