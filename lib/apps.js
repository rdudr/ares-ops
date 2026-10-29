// The ARES apps a person can be given access to. Codes match docs/PLATFORM_RULES.md §3
// and must never change once data exists under them.
export const APPS = [
  // The field apps (Android, and as web apps at `web`; AR names, see the AR app guide).
  { code: 'survey', name: 'BRIEF', field: true, web: '/field/brief/', tagline: 'Plant electrical survey: panels, motors, APFC and energy sources' },
  { code: 'textile', name: 'JET', field: true, web: '/field/jet/', tagline: 'Jet dyeing machine efficiency' },
  { code: 'pump', name: 'Pump Testing', field: true, web: '/field/pump/', tagline: 'Pump performance with transit and Doppler flow meters' },
  { code: 'air', name: 'Air Findings', field: true, web: '/field/air/', tagline: 'Compressed air: compressor efficiency, FAD and leak tests' },
  { code: 'heat', name: 'Boiler & Fuel', field: true, web: '/field/boiler/', tagline: 'Boiler and thermic fluid heater efficiency' },
  { code: 'cool', name: 'AHU & Cooling', field: true, web: '/field/cooling/', tagline: 'AC, chiller, AHU and cooling-tower performance' },
  { code: 'motor', name: 'MLA', field: true, web: '/field/mla/', tagline: 'Motor load analysis: load factor, efficiency, unbalance, thermal loss and long-term monitoring' },
  // Web app on this server (ops.arenergyservices.in/pqa/), not an APK.
  { code: 'power', name: 'Power Quality', web: true, tagline: 'AI power quality analyser: harmonics, dips and swells, IEEE 519, EN 50160 and IEC 61000' },
  // Planned.
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
