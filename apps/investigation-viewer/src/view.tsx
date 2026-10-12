import { h } from './jsx.js';
import { filterFindings, type InvestigationReport } from './report.js';

export function renderReport(report: InvestigationReport, search = ''): HTMLElement {
  const findings = filterFindings(report, search);
  return <main>
    <h1>Investigation evidence</h1>
    <p>{report.target}</p>
    <p>{report.files.length} files · {findings.length} visible findings · {report.skipped.length} skipped</p>
    <section><h2>Findings</h2><ul>{findings.map((item) =>
      <li><strong>{item.kind}</strong> <code>{item.value}</code> <small>{item.evidence.path}:{item.evidence.line}:{item.evidence.column}</small></li>
    )}</ul></section>
    <section><h2>Limits</h2><ul>{report.limitations.map((limit) => <li>{limit}</li>)}</ul></section>
  </main>;
}
