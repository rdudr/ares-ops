// The ARES apps a person can be given access to. Codes match docs/PLATFORM_RULES.md §3
// and must never change once data exists under them.
export const APPS = [
  { code: 'survey', name: 'Plant Survey' },
  { code: 'textile', name: 'Textile Machines' },
  { code: 'air', name: 'Compressed Air' },
  { code: 'pump', name: 'Pumps' },
  { code: 'cool', name: 'Cooling' },
  { code: 'heat', name: 'Boilers & Heaters' },
  { code: 'power', name: 'Power Quality' },
  { code: 'bills', name: 'Bills' },
  { code: 'solar', name: 'Solar' },
  { code: 'report', name: 'Report Studio' },
];

export const APP_CODES = new Set(APPS.map(a => a.code));

export const SECTORS = {
  TX: 'Textile', CH: 'Chemicals', PH: 'Pharma', FD: 'Food', CR: 'Ceramics',
  EN: 'Engineering', PL: 'Plastics', PP: 'Paper', DY: 'Dyes & pigments', OT: 'Other',
};

export const ROLES = ['super_admin', 'head', 'engineer'];
export const STATUSES = ['active', 'hold', 'revoked'];
export const AUDIT_STATUSES = ['draft', 'in_field', 'processing', 'review', 'approved', 'published', 'archived'];
export const TASK_STATUSES = ['todo', 'running', 'done'];
