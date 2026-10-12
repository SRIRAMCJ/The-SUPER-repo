import { parseReport } from './report.js';
import { renderReport } from './view.js';

const fileInput = document.querySelector<HTMLInputElement>('#report-file');
const filterInput = document.querySelector<HTMLInputElement>('#filter');
const output = document.querySelector<HTMLElement>('#report');
if (!fileInput || !filterInput || !output) throw new Error('Viewer elements missing');
let report: ReturnType<typeof parseReport> | null = null;
const draw = () => { if (report) output.replaceChildren(renderReport(report, filterInput.value)); };
fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  try { report = parseReport(JSON.parse(await file.text())); draw(); }
  catch (error) { report = null; output.textContent = error instanceof Error ? error.message : 'Invalid report'; }
});
filterInput.addEventListener('input', draw);
