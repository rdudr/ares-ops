// The AR Energy Services apps a person can be given access to. Codes must never change once data
// exists under them (docs/PLATFORM_RULES.md §3); names are AR's own and must not repeat the KISEM
// app names. `web` is where the field app opens on this server (deploy/field-web.sh).
export const APPS = [
  // The field apps (Android, and the same screens on the web at /field/<app>/).
  { code: 'survey', name: 'BRIEF', field: true, web: '/field/brief/', tagline: 'Site walk-through: panels, motors, APFC, name-plates and energy sources' },
  { code: 'motor', name: 'Motor Pulse', field: true, web: '/field/mla/', tagline: 'Motor loading, efficiency, voltage unbalance and long-term logging' },
  { code: 'heat', name: 'Boiler & Fuel', field: true, web: '/field/boiler/', tagline: 'Steam boilers and thermic fluid heaters: direct and indirect efficiency, flue gas' },
  { code: 'textile', name: 'Dye House', field: true, web: '/field/jet/', tagline: 'Jet dyeing machines: heat lost from surfaces, pump duty and steam traps' },
  { code: 'air', name: 'Air Findings', field: true, web: '/field/air/', tagline: 'Compressors: free air delivery, pump-up test, leaks and specific power' },
  { code: 'pump', name: 'Hydro Flow', field: true, web: '/field/pump/', tagline: 'Pump duty point and efficiency from ultrasonic flow readings' },
  { code: 'cool', name: 'Cool Zone', field: true, web: '/field/cooling/', tagline: 'Chillers, AHUs, split ACs and cooling towers: kW per TR and approach' },
  { code: 'xmer', name: 'Trafo Check', field: true, web: '/field/xmer/', tagline: 'Transformer no-load and load losses, efficiency and IS 1180 star rating' },
  { code: 'light', name: 'Lux Survey', field: true, web: '/field/light/', tagline: 'Lux readings on a grid, room index, lighting power density and ILER' },
  { code: 'dryer', name: 'Dryer Heat', field: true, web: '/field/dryer/', tagline: 'Dryer heat and mass balance, thermal efficiency and steam per kg of product' },
  // Web tools on this server, not APKs.
  { code: 'power', name: 'Grid Lens', web: '/pqa/', url: '/pqa/', where: 'ops.arenergyservices.in/pqa', tagline: 'Power quality: harmonics, sags and swells checked against IEEE 519, EN 50160 and IEC 61000' },
  // A Console menu, not an app: bills, energy baseline and GHG inputs per company (lib/routes-ledger.js).
  { code: 'ledger', name: 'Energy Ledger', tagline: 'Electricity bills with OCR, energy and water baseline, GHG accounting' },
  // Free GST Billing Software at billing.arenergyservices.in, behind the ARES sign-in (lib/routes-billing.js).
  { code: 'bills', name: 'GST Billing', web: 'https://billing.arenergyservices.in/', url: 'https://billing.arenergyservices.in/', where: 'billing.arenergyservices.in', managersOnly: true, tagline: 'GST invoices, credit notes, purchases, GSTR-1 and GSTR-3B' },
  // Planned.
  { code: 'report', name: 'Report Studio' },
  { code: 'solar', name: 'Solar' },
];

export const APP_CODES = new Set(APPS.map(a => a.code));

// AR gives each person the apps they work on (docs/PLATFORM_RULES.md §8), so access is per app.
export const TEAM_WIDE_ACCESS = false;
// New people are Engineers unless a Super Admin chooses Admin.
export const DEFAULT_CARD_ROLE = 'engineer';

// Plant types. The two letters start the public industry tag (TX-SRT-001); existing codes never change.
export const SECTORS = {
  TX: 'Textile (spinning, weaving, processing)', DY: 'Dyes & pigments', CH: 'Chemicals', PH: 'Pharma',
  FD: 'Food & beverages', DA: 'Dairy', SU: 'Sugar & distillery', AG: 'Agro & rice mills',
  CR: 'Ceramics & tiles', GL: 'Glass', BR: 'Bricks & refractories', CE: 'Cement',
  FO: 'Foundry & forging', ST: 'Steel & rolling mills', EN: 'Engineering & fabrication', AU: 'Auto components',
  PL: 'Plastics', RU: 'Rubber & tyres', PP: 'Paper & pulp', PR: 'Printing & packaging',
  FE: 'Fertilisers', WT: 'Water & wastewater', HO: 'Hospitals & hotels', CB: 'Commercial buildings',
  OT: 'Other',
};

// Type of work an audit is.
export const WORK_TYPES = {
  walkthrough: 'Walkthrough energy audit',
  detailed: 'Detailed energy audit',
  pq: 'Power quality study',
  flow: 'Flow study',
};

export const STATES = ['Gujarat', 'Rajasthan', 'Maharashtra', 'Madhya Pradesh', 'Dadra and Nagar Haveli and Daman and Diu',
  'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Goa', 'Haryana', 'Himachal Pradesh', 'Jharkhand',
  'Karnataka', 'Kerala', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Punjab', 'Sikkim', 'Tamil Nadu',
  'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal', 'Andaman and Nicobar Islands', 'Chandigarh',
  'Delhi', 'Jammu and Kashmir', 'Ladakh', 'Lakshadweep', 'Puducherry'];

export const ROLES = ['super_admin', 'head', 'engineer'];
export const STATUSES = ['active', 'hold', 'revoked'];
export const AUDIT_STATUSES = ['draft', 'in_field', 'processing', 'review', 'approved', 'published', 'archived'];
export const TASK_STATUSES = ['todo', 'running', 'done'];
