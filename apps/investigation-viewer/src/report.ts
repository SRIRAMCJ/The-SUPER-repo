export interface SourceFile { path: string; bytes: number; sha256: string }
export interface EvidenceLocation { path: string; line: number; column: number; sha256: string }
export interface Finding { kind: string; value: string; evidence: EvidenceLocation }
export interface InvestigationReport {
  schemaVersion: '0.1.0';
  type: 'static-javascript-investigation';
  target: string;
  query: string | null;
  files: SourceFile[];
  findings: Finding[];
  skipped: { path: string; reason: string }[];
  limitations: string[];
}

export function parseReport(value: unknown): InvestigationReport {
  if (!isRecord(value) || value.type !== 'static-javascript-investigation' || value.schemaVersion !== '0.1.0' ||
      typeof value.target !== 'string' || !Array.isArray(value.files) || !Array.isArray(value.findings) ||
      !Array.isArray(value.skipped) || !Array.isArray(value.limitations) ||
      !value.files.every((file: unknown) => isRecord(file) && typeof file.path === 'string' && typeof file.sha256 === 'string') ||
      !value.findings.every((item: unknown) => isRecord(item) && typeof item.kind === 'string' && typeof item.value === 'string' &&
        isRecord(item.evidence) && typeof item.evidence.path === 'string' && Number.isSafeInteger(item.evidence.line) &&
        Number.isSafeInteger(item.evidence.column) && typeof item.evidence.sha256 === 'string')) {
    throw new TypeError('Invalid static investigation report');
  }
  return value as unknown as InvestigationReport;
}

export function filterFindings(report: InvestigationReport, search: string): Finding[] {
  const term = search.trim().toLocaleLowerCase();
  if (!term) return report.findings;
  return report.findings.filter((item) => [item.kind, item.value, item.evidence.path]
    .some((part) => part.toLocaleLowerCase().includes(term)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
