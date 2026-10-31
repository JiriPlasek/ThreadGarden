import { describe, expect, it } from 'vitest';
import { LinkError, classifyVerifyFailure } from '../../src/machine/link.js';

describe('classifyVerifyFailure', () => {
  it('takes certificate date errors for a clock problem, not another machine', () => {
    for (const code of ['CERT_NOT_YET_VALID', 'CERT_HAS_EXPIRED']) {
      const err = classifyVerifyFailure(code);
      expect(err).toBeInstanceOf(LinkError);
      expect(err.kind, code).toBe('unreachable');
      // The reason is kept for the log.
      expect(err.message).toContain(code);
    }
  });

  it('takes chain and fingerprint failures for another machine', () => {
    for (const code of [
      'DEPTH_ZERO_SELF_SIGNED_CERT',
      'SELF_SIGNED_CERT_IN_CHAIN',
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      'CERT_SIGNATURE_FAILURE',
      'PIN_MISMATCH',
    ]) {
      expect(classifyVerifyFailure(code).kind, code).toBe('pin');
    }
  });
});
