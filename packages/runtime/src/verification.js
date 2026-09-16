export class VerificationEngine {
  constructor({ checks = [] } = {}) {
    this.checks = [...checks];
  }

  async verify({ capability, input, output, context = {} }) {
    const failures = [];
    for (const check of this.checks) {
      const result = await check({ capability, input, output, context });
      if (result === false) failures.push({ code: 'VERIFICATION_FAILED', message: 'Verification check returned false' });
      else if (result && result.ok === false) failures.push({ code: result.code ?? 'VERIFICATION_FAILED', message: result.message ?? 'Verification failed' });
    }
    return { verified: failures.length === 0, checks: this.checks.length, failures };
  }
}
