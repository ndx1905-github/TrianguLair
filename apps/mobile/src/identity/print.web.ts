/**
 * Web print view: the page goes into a hidden frame and the browser's print
 * dialog opens (print or save as PDF). Nothing leaves the browser.
 */
export async function printHtml(html: string): Promise<void> {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
  document.body.appendChild(frame);
  const doc = frame.contentDocument;
  const win = frame.contentWindow;
  if (!doc || !win) {
    frame.remove();
    throw new Error('print view unavailable');
  }
  doc.open();
  doc.write(html);
  doc.close();
  await new Promise((r) => setTimeout(r, 50));
  win.focus();
  win.print();
  // The frame (and the phrase in it) goes away once the dialog is closed.
  setTimeout(() => frame.remove(), 1000);
}
