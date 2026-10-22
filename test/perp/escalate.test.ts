// test/perp/escalate.test.ts
import { describe, it, expect } from 'vitest';
import { escalate, type EscalateInput } from '../../src/perp/intake/escalate.js';

const base: EscalateInput = { impact: 'moderate', sourceClass: 'press', calendarWindowOpen: false, sonnetPassesLastHour: 0, sonnetPerHour: 6 };

describe('escalate', () => {
  it('none never escalates, whatever else is true', () => {
    expect(escalate({ ...base, impact: 'none', calendarWindowOpen: true, sourceClass: 'official_macro' })).toEqual({ escalate: false, reason: 'none' });
  });
  it('moderate and major escalate on impact', () => {
    expect(escalate({ ...base, impact: 'moderate' })).toEqual({ escalate: true, reason: 'impact' });
    expect(escalate({ ...base, impact: 'major' })).toEqual({ escalate: true, reason: 'impact' });
  });
  it('minor escalates only inside a high-impact calendar window', () => {
    expect(escalate({ ...base, impact: 'minor' })).toEqual({ escalate: false, reason: 'below_threshold' });
    expect(escalate({ ...base, impact: 'minor', calendarWindowOpen: true })).toEqual({ escalate: true, reason: 'calendar' });
  });
  it('official_macro escalates at minor and above', () => {
    expect(escalate({ ...base, impact: 'minor', sourceClass: 'official_macro' })).toEqual({ escalate: true, reason: 'official' });
  });
  it('the Sonnet cap blocks moderate and minor but never major or official_macro', () => {
    const full = { ...base, sonnetPassesLastHour: 6 };
    expect(escalate({ ...full, impact: 'moderate' })).toEqual({ escalate: false, reason: 'sonnet_cap' });
    expect(escalate({ ...full, impact: 'minor', calendarWindowOpen: true })).toEqual({ escalate: false, reason: 'sonnet_cap' });
    expect(escalate({ ...full, impact: 'major' })).toEqual({ escalate: true, reason: 'impact' });
    expect(escalate({ ...full, impact: 'minor', sourceClass: 'official_macro' })).toEqual({ escalate: true, reason: 'official' });
  });
});
