#!/usr/bin/env node
/* ── THE GOVERNOR WAS NOT THE LAST THING TO TOUCH THE TEXT ────────────────────
   SW-20260915-R8U2E published a Morning Report of 5,149 characters. The posting
   field it is written for holds 4,000. The operator could not post the morning's
   report at all.

   The pack from that same run recorded:

       public_morning_chars_full : 6273
       public_morning_chars_4k   : 3900
       public_morning_4k_compacted: true

   So the governor ran, and produced a compliant 3,900-character text — and the
   artifact that reached the operator was 5,149. Both facts are true, because the
   governor was installed as a wrapper around buildMorningStoryText, which is the
   INNERMOST stage. canonicalMorningStory (02-core.js:17450) then runs three more
   stages on top of the governed text:

       fn(p)                              <- governed here
       finalizeReportPresentation(...)    <- layer 23 re-adds "Under the Surface"
                                             and "How to Read It", layer 26 the
                                             escrow story, layer 33 terminology
       SW_DAILY_GATE.gateDelivery(...)
       _canonicalNewsUsedBlock(p)         <- re-appends the NEWS USED block that
                                             govern() had just stripped

   The result is the worst of both: over the limit AND missing sections that were
   cut to meet a limit the delivered text never met.

   A character budget can only be enforced by the last stage. So the governor is
   no longer a wrapper on the renderer — it is applied at the publication
   boundary, to the finished canonical text, by the surfaces that hand it to a
   person. The canonical text, the seal's morning_hash and the TOTAL REPORT keep
   the complete render; the download keeps byte-parity with the canonical text
   (morning-story-canonical.test.js proves that and must stay green).

   Run: node scripts/public-morning-4k.test.js
──────────────────────────────────────────────────────────────────────────── */
'use strict';

const fs   = require('fs');
const vm   = require('vm');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC  = fs.readFileSync(path.join(ROOT, 'src/brief/31-public-morning-4k-20260817.js'), 'utf8');

// The artifact the operator could not post, byte for byte.
const DELIVERED = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'morning-report-SW-20260915-R8U2E.txt'), 'utf8');

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
};

// Load the layer the way the page does: an IIFE against a window. A renderer is
// already present so that a wrapper installation, if one were attempted, would
// succeed and be visible rather than silently no-op.
function load() {
  const renderer = function (pack) { return 'RENDERED'; };
  const win = { buildMorningStoryText: renderer };
  const ctx = { window: win, setInterval: () => 0, clearInterval: () => {}, URL, console };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx, { filename: '31-public-morning-4k-20260817.js' });
  return { win, renderer, G: win.SW_PUBLIC_MORNING_4K_20260817 };
}

console.log('PUBLIC MORNING REPORT — 4,000 CHARACTER PUBLICATION LIMIT\n');

const { win, renderer, G } = load();

// ══ 0. THE SETUP IS REAL ═════════════════════════════════════════════════════
// Every check below is worthless if the fixture is not the oversized artifact or
// the module did not load.
console.log('0. the evidence and the module are real');
check('the layer installed its public surface', !!G && typeof G.govern === 'function');
check('the delivered report is the one that could not be posted',
      DELIVERED.length === 5149 && /\nExecutive Summary\n/.test(DELIVERED) &&
      /\nLEDGER DIAGNOSTICS\n/.test(DELIVERED) && DELIVERED.indexOf('121.36M XRP') > -1,
      DELIVERED.length);
check('it is over the publication limit by every way of counting',
      DELIVERED.length > 4000 && [...DELIVERED].length > 4000,
      { utf16: DELIVERED.length, codepoints: [...DELIVERED].length });

// ══ 1. THE GOVERNOR IS NOT A RENDERER WRAPPER ════════════════════════════════
// This is the defect, stated structurally. Wrapping the renderer puts the budget
// check upstream of stages that add text, so no amount of trimming inside the
// wrapper can bound the artifact. If this check fails, the 5,149-character
// report can ship again while the pack still reports 3,900.
console.log('\n1. the budget is not enforced upstream of the stages that add text');
check('loading the layer leaves buildMorningStoryText untouched',
      win.buildMorningStoryText === renderer);
check('the renderer carries no governor marker',
      !win.buildMorningStoryText._swPublic4kGovernor20260817);
check('a publication-boundary entry point is exposed instead',
      typeof G.publicText === 'function');

// ══ 2. THE PUBLISHED TEXT FITS ═══════════════════════════════════════════════
console.log('\n2. what the operator posts fits the field');
const published = G.publicText(DELIVERED);
console.log('     ' + DELIVERED.length + ' chars in  ->  ' + published.length + ' chars out');
check('the published text is within the hard limit', published.length <= 4000, published.length);
check('counted in code points too', [...published].length <= 4000, [...published].length);
check('the limit the layer publishes is the one it enforces', G.hard_limit === 4000, G.hard_limit);

// ══ 3. IT IS STILL THE MORNING'S REPORT ══════════════════════════════════════
// A text that fits by dropping the evidence is a worse failure than one that is
// too long — Lady K reads these figures on air. The trim ladder spends duplicate
// and explanatory prose first; the ledger facts are not spendable.
console.log('\n3. the figures that are read on air survive the trim');
const MUST_KEEP = [
  '121.36M XRP',                 // shadow volume, the headline figure
  '29 large transfers',          // the count behind it
  '31.70B XRP locked now',       // Ripple escrow position
  'registry check 20/20',        // escrow registry coverage
  '408',                         // watched wallets
  'LEDGER DIAGNOSTICS',
  '263.24M XRP moved',           // watched activity
  'THE DAILY PRAYER',
  'THE DAILY SCRIPTURE',
  'Psalm 24:1',
  'Not financial advice',
  '(38/100)'                     // the verdict score
];
MUST_KEEP.forEach(fact => check('kept: ' + fact, published.indexOf(fact) > -1));
// A trim may remove; it may never add. Every number surviving in the published
// text must be a number the delivered report already carried.
const numbersIn = t => String(t).match(/\d[\d,.]*/g) || [];
const deliveredNumbers = new Set(numbersIn(DELIVERED));
const invented = numbersIn(published).filter(x => !deliveredNumbers.has(x));
check('the trim removed figures, it did not invent any', invented.length === 0, invented);

// ══ 4. THE LIMIT HOLDS WHATEVER ARRIVES ══════════════════════════════════════
// The trim ladder recognises headings. A report it cannot parse must still be
// bounded, because an unparseable report is exactly when a limit matters.
console.log('\n4. the bound does not depend on recognising the report');
const SHAPELESS = 'x'.repeat(20000);
check('an unstructured 20,000-character text is bounded',
      G.publicText(SHAPELESS).length <= 4000, G.publicText(SHAPELESS).length);
const NO_HEADINGS = ('A single unbroken paragraph of morning narrative. ').repeat(200);
check('a report with no headings at all is bounded',
      G.publicText(NO_HEADINGS).length <= 4000, G.publicText(NO_HEADINGS).length);

// ══ 5. A REPORT THAT ALREADY FITS IS NOT TOUCHED ═════════════════════════════
// Trimming a compliant report would silently cost the operator content for
// nothing, on every quiet morning.
console.log('\n5. a compliant report is passed through unchanged');
const SHORT = DELIVERED.slice(0, 1200);
check('a 1,200-character report comes back byte-identical', G.publicText(SHORT) === SHORT);

// ══ 6. RE-APPLYING IT IS SAFE ════════════════════════════════════════════════
// Two publication surfaces may both route through this, and a later stage may
// append to an already-governed text — which is precisely how the shipped bug
// worked. Applying the budget again must re-check, not trust the earlier pass.
console.log('\n6. applying the budget again re-checks rather than trusting');
check('governing twice is stable', G.publicText(published) === published);
const APPENDED = published + '\n\nNEWS USED:\n' + ('[1] a headline that arrived after the trim\n').repeat(40);
check('text appended after an earlier pass is caught',
      APPENDED.length > 4000 && G.publicText(APPENDED).length <= 4000,
      { appended: APPENDED.length, regoverned: G.publicText(APPENDED).length });

// ══ 7. THE PUBLICATION IS AUDITABLE ══════════════════════════════════════════
// The run that shipped 5,149 characters recorded 3,900 in the pack, so the debug
// export agreed the artifact was compliant while it was not. These fields must
// describe the text that was actually handed over.
console.log('\n7. the debug export describes the text that was published');
const pack = {};
const out = G.publicText(DELIVERED, pack);
check('full length recorded', pack.public_morning_chars_full === DELIVERED.length, pack.public_morning_chars_full);
check('published length recorded', pack.public_morning_chars_4k === out.length, pack.public_morning_chars_4k);
check('compaction recorded', pack.public_morning_4k_compacted === true);
const quietPack = {};
G.publicText(SHORT, quietPack);
check('a report that needed no trim is not reported as compacted',
      quietPack.public_morning_4k_compacted === false &&
      quietPack.public_morning_chars_4k === SHORT.length);

// ══ 8. NOTHING ELSE MOVED ════════════════════════════════════════════════════
console.log('\n8. publication-only');
check('the layer still declares itself publication-only',
      G.publication_only === true && G.total_report_untouched === true &&
      G.scanner_untouched === true && G.lookback_untouched === true);
check('governing does not mutate its input', (() => {
  const before = DELIVERED;
  G.publicText(DELIVERED);
  return DELIVERED === before;
})());

console.log('\n' + (fail === 0 ? 'ALL ' + pass + ' CHECKS PASS' : pass + ' pass, ' + fail + ' FAIL'));
process.exit(fail === 0 ? 0 : 1);
