#!/usr/bin/env node
// Synthetic NZ bank-statement generator for TerePay's migrant micro-lending population.
// Produces, per case: statement text in one or more real bank layouts, the application record, and ground truth.
//   node training/generate.js --n 200 --seed 7 --out training/data [--layouts anz,asb,bnz,kiwibank,westpac]
// Deterministic for a given seed. No customer data involved.
const fs = require('fs'), path = require('path');

// ---------------- tiny seeded RNG ----------------
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
let R = rng(1);
const rand = (a, b) => a + R() * (b - a);
const rint = (a, b) => Math.floor(rand(a, b + 1));
const pick = arr => arr[Math.floor(R() * arr.length)];
const chance = p => R() < p;
const r2 = v => Math.round(v * 100) / 100;

// ---------------- vocab ----------------
const NAMES = ['Sione Tuilagi', 'Maria Santos', 'Rajesh Kumar', 'Litia Naidu', 'Nguyen Van Minh', 'Ana Fifita', 'Priya Sharma', 'Josefa Ratu', 'Mele Latu', 'Carlos Reyes', 'Amina Hassan', 'Tevita Havili', 'Grace Mendoza', 'Deepak Patel', 'Sela Vaea', 'Ivan Petrov', 'Fatima Ali', 'Joseph Kalolo', 'Rina Devi', 'Paulo Silva'];
const EMPLOYERS = ['PAK N SAVE ROYAL OAK', 'COUNTDOWN PAYROLL', 'MAINFREIGHT LTD', 'FLETCHER CONSTRUCTION', 'AUCKLAND COUNCIL', 'BUPA CARE SERVICES', 'RYMAN HEALTHCARE', 'FOODSTUFFS NI', 'HAWKINS CONSTRUCTION', 'SPOTLESS SERVICES', 'ISS FACILITY SERVICES', 'TALLEYS GROUP', 'AFFCO NZ', 'SILVER FERN FARMS', 'OJI FIBRE', 'MITRE 10 MEGA', 'FIRST SECURITY', 'ALLIED SECURITY', 'HEALTHCARE NZ', 'CROWN RELOCATIONS'];
const BENEFITS = ['MSD WORK AND INCOME', 'WINZ JOBSEEKER', 'IRD WORKING FOR FAMILIES', 'MSD SOLE PARENT SUPPORT', 'STUDYLINK ALLOWANCE'];
const RENT = ['RENT - BARFOOT & THOMPSON', 'RENT - RAY WHITE PROPERTY MGMT', 'RENT - HARCOURTS', 'RENT - QUINOVIC', 'KAINGA ORA RENT', 'RENT - CROCKERS', 'RENT - A & B PROPERTY MGMT'];
const GROCERY = ['COUNTDOWN MANUKAU', 'PAK N SAVE MANGERE', 'NEW WORLD OTAHUHU', 'COUNTDOWN LYNFIELD', 'FOUR SQUARE PAPATOETOE', 'TAI PING SUPERMARKET', 'FRESH CHOICE OTARA', 'NIGHT N DAY PENROSE', 'COUNTDOWN HENDERSON', 'PAK N SAVE ORMISTON'];
const FUEL = ['Z ENERGY MT ROSKILL', 'BP PAPATOETOE', 'CALTEX OTAHUHU', 'GULL MANUREWA', 'MOBIL MANGERE', 'NPD PENROSE', 'WAITOMO FUEL WIRI'];
const POWER = ['MERCURY ENERGY', 'GENESIS ENERGY', 'CONTACT ENERGY', 'MERIDIAN ENERGY', 'ELECTRIC KIWI', 'GLOBUG TOP UP'];
const TELCO = ['SPARK NZ', '2DEGREES MOBILE', 'ONE NZ', 'SKINNY MOBILE', 'SLINGSHOT'];
const INSURANCE = ['AA INSURANCE', 'STATE INSURANCE', 'AMI INSURANCE', 'TOWER INSURANCE', 'COVE INSURANCE'];
const DINING = ['MCDONALDS MANUKAU', 'KFC OTAHUHU', 'UBER EATS', 'BURGER KING PAPATOETOE', 'PIZZA HUT MANGERE', 'HELL PIZZA', 'SUSHI TRAIN', 'ST PIERRES SUSHI', 'COLUMBUS COFFEE', 'MENULOG', 'DOMINOS MANUREWA', 'TANK JUICE BAR', 'NANDOS SYLVIA PARK'];
const RETAIL = ['KMART MANUKAU', 'THE WAREHOUSE MANUKAU', 'FARMERS SYLVIA PARK', 'COTTON ON', 'REBEL SPORT', 'JB HI-FI', 'NOEL LEEMING', 'BRISCOES', 'GLASSONS', 'HALLENSTEIN BROS', 'NUMBER ONE SHOES', 'POSTIE PLUS', 'SPOTLIGHT'];
const ONLINE = ['TEMU', 'SHEIN', 'AMAZON AU', 'ALIEXPRESS', 'TRADE ME', 'THE ICONIC', 'EBAY AU'];
const BNPL = ['AFTERPAY PAYMENT', 'ZIP CO PAYMENT', 'LAYBUY PAYMENT', 'KLARNA PAYMENT', 'HUMM PAYMENT', 'GENOAPAY'];
const GAMBLING = ['TAB NZ ONLINE', 'SKY BET', 'MYLOTTO NZ', 'SKYCITY AUCKLAND', 'BETCHA', 'LOTTO NZ INSTANT KIWI', 'BET365'];
const ALCOHOL = ['LIQUORLAND MANUKAU', 'SUPER LIQUOR OTAHUHU', 'THIRSTY LIQUOR MANGERE', 'THE BOTTLE-O PAPATOETOE', 'BIG BARREL'];
const TOBACCO = ['SHOSHA VAPE', 'COSMIC OTAHUHU', 'VAPO MANUKAU'];
const REMIT = ['WESTERN UNION APIA WS', 'MONEYGRAM NUKU\'ALOFA', 'WORLDREMIT SUVA', 'REMITLY MANILA', 'WISE TRANSFER NEW DELHI', 'ORBIT REMIT TO FIJI', 'RIA MONEY TRANSFER', 'KLIKSEND APIA', 'WESTERN UNION LAHORE', 'DIGICEL MOBILE MONEY'];
const LENDERS = ['HARMONEY LOAN REPAYMENT', 'AVANTI FINANCE', 'LATITUDE GEM VISA PAYMENT', 'Q CARD PAYMENT', 'FINANCE NOW', 'TEREPAY LOAN REPAYMENT', 'PIONEER FINANCE', 'GENEVA FINANCE', 'MTF FINANCE'];
const PAYDAY = ['MOOLA', 'SAVE MY BACON', 'PRETTY PENNY', 'CASH CONVERTERS', 'SUPERLOANS', 'INSTANT FINANCE', 'NIMBLE'];
const MEDICAL = ['UNICHEM OTAHUHU PHARMACY', 'MIDDLEMORE HOSPITAL', 'MANGERE MEDICAL CENTRE', 'LUMINO THE DENTISTS', 'LIFE PHARMACY MANUKAU', 'EAST TAMAKI HEALTHCARE', 'LABTESTS AUCKLAND', 'AUCKLAND RADIOLOGY', 'DR PATEL FAMILY HEALTH', 'PHYSIO MANUKAU', 'SPECSAVERS MANUKAU', 'COUNTIES MANUKAU HEALTH'];
const FAMILY = ['TRANSFER FROM S TUILAGI', 'TRANSFER FROM M SANTOS', 'FROM R KUMAR', 'DEPOSIT FROM L NAIDU', 'TRANSFER FROM A FIFITA', 'FROM MUM', 'TRANSFER FROM T HAVILI'];
const CHURCH = ['AP TO EFKS MANGERE', 'AP TO CATHOLIC PARISH', 'AP TO LDS WARD', 'DONATION - SIVA SAMOA', 'AP TO TONGAN METHODIST'];
const SUBS = ['NETFLIX', 'SPOTIFY', 'DISNEY PLUS', 'NEON', 'YOUTUBE PREMIUM', 'APPLE.COM/BILL', 'CITYFITNESS', 'LES MILLS', 'HELLOFRESH'];
const UNKNOWN = ['PAYMENT TO J SMITH', 'EFTPOS 4521 AUCKLAND', 'INTERNET TRANSFER 1234', 'AP 887766', 'CARD PURCHASE 09/08', 'DIRECT DEBIT 5581', 'MANUKAU CITY 4431', 'POS 20310 AKL'];
const OTHER_LAYOUT_NOISE = ['TRANSFER TO SAVINGS 38-9012-0345678-01', 'TRANSFER TO SAVINGS', 'KIWISAVER VOLUNTARY'];

// ---------------- profiles (migrant micro-lending population) ----------------
// Each profile sets monthly rates/amounts; the simulator turns them into dated transactions.
const PROFILES = {
  clean_saver:        { w: 14, spendRatio: [0.72, 0.88], income: [3800, 5600], remitPct: [0, 0.12], bnplPerWeek: 0, gambling: 0, alcoholPerWeek: [0, 0.3], savings: [200, 500], buffer: [800, 2500], lenders: [0, 1], purpose: ['car repairs', 'furniture', 'visa renewal fees', 'flights to see family', 'bond for new flat'], history: 'good' },
  thin_file_migrant:  { w: 16, spendRatio: [0.88, 1.0], income: [2600, 4200], remitPct: [0.08, 0.2], bnplPerWeek: [0, 0.5], gambling: 0, alcoholPerWeek: [0, 0.5], savings: [0, 150], buffer: [150, 700], lenders: [0, 0], purpose: ['visa renewal fees', 'flights to see family', 'car repairs', 'bond for new flat', 'work tools'], history: 'none' },
  remittance_stress:  { w: 12, spendRatio: [0.98, 1.08], income: [2800, 4400], remitPct: [0.28, 0.42], bnplPerWeek: [0.5, 1.5], gambling: 0, alcoholPerWeek: [0, 0.5], savings: [0, 0], buffer: [50, 300], lenders: [0, 2], purpose: ['family emergency overseas', 'send money to family', 'funeral costs overseas', 'school fees for children overseas'], history: 'mixed' },
  bnpl_heavy:         { w: 10, spendRatio: [0.98, 1.08], income: [3000, 4800], remitPct: [0, 0.12], bnplPerWeek: [3, 6], gambling: 0, alcoholPerWeek: [0, 1], savings: [0, 0], buffer: [30, 250], lenders: [1, 3], purpose: ['consolidate afterpay', 'pay off zip', 'phone', 'car repairs'], history: 'mixed' },
  gambling:           { w: 8, spendRatio: [0.98, 1.1], income: [3000, 5000], remitPct: [0, 0.15], bnplPerWeek: [0, 2], gambling: [2, 8], alcoholPerWeek: [0.5, 2], savings: [0, 0], buffer: [20, 300], lenders: [0, 2], purpose: ['car repairs', 'rent arrears', 'bills', 'personal'], history: 'bad' },
  payday_cycle:       { w: 8, spendRatio: [1.0, 1.12], income: [2600, 4200], remitPct: [0.05, 0.2], bnplPerWeek: [1, 3], gambling: [0, 1], alcoholPerWeek: [0, 1], savings: [0, 0], buffer: [0, 150], lenders: [2, 4], payday: [1, 3], purpose: ['pay off moola', 'consolidate loans', 'rent arrears', 'bills'], history: 'bad' },
  medical_shock:      { w: 14, spendRatio: [0.9, 1.02], income: [3000, 5000], remitPct: [0.05, 0.18], bnplPerWeek: [0, 1.5], gambling: 0, alcoholPerWeek: [0, 0.5], savings: [0, 100], buffer: [100, 600], lenders: [0, 1], medical: true, purpose: ['hospital bill', 'dental surgery', 'medical bills for my wife', 'surgery costs not covered', 'medication and specialist fees', 'medical treatment'], history: 'good' },
  family_bailouts:    { w: 8, spendRatio: [1.0, 1.1], income: [2600, 4000], remitPct: [0.1, 0.25], bnplPerWeek: [0.5, 2], gambling: 0, alcoholPerWeek: [0, 0.5], savings: [0, 0], buffer: [0, 120], lenders: [0, 2], familyIn: [3, 6], purpose: ['bills', 'rent arrears', 'car repairs', 'personal'], history: 'mixed' },
  lifestyle_inflation:{ w: 6, spendRatio: [0.98, 1.08], income: [3600, 5600], remitPct: [0, 0.1], bnplPerWeek: [1, 3], gambling: 0, alcoholPerWeek: [1, 3], savings: [0, 0], buffer: [50, 400], lenders: [1, 2], dining: [0.2, 0.3], subs: [4, 8], purpose: ['holiday', 'phone', 'car', 'personal'], history: 'mixed' },
  income_drop:        { w: 4, spendRatio: [0.9, 1.0], income: [3200, 4800], remitPct: [0.05, 0.2], bnplPerWeek: [0, 1], gambling: 0, alcoholPerWeek: [0, 0.5], savings: [0, 100], buffer: [100, 500], lenders: [0, 1], drop: true, purpose: ['bills while off work', 'rent', 'living costs', 'car repairs'], history: 'good' },
};
const rr = v => Array.isArray(v) ? rand(v[0], v[1]) : v;

// ---------------- simulator ----------------
const iso = d => d.toISOString().slice(0, 10);
const addDays = (d, n) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; };

function simulate(profileName, prof) {
  const days = rint(61, 92);
  const end = new Date(Date.UTC(2026, 7, 31)); const start = addDays(end, -(days - 1));
  const cadence = pick(['weekly', 'fortnightly', 'fortnightly', 'fortnightly', 'monthly']);
  const monthly = r2(rr(prof.income));
  const payAmt = r2(cadence === 'weekly' ? monthly * 12 / 52 : cadence === 'fortnightly' ? monthly * 12 / 26 : monthly);
  const gap = cadence === 'weekly' ? 7 : cadence === 'fortnightly' ? 14 : 30;
  const employer = chance(0.85) ? `SALARY - ${pick(EMPLOYERS)}` : pick(BENEFITS);
  const rent = r2(Math.min(monthly * rand(0.2, 0.34), 1300)); const rentDesc = pick(RENT); const rentWeekly = chance(0.6);
  const weeks = days / 7, months = days / 30.4375;
  const remitPct = rr(prof.remitPct); const remitDesc = pick(REMIT);
  const bnplPerWeek = rr(prof.bnplPerWeek || 0); const bnplProviders = bnplPerWeek > 0 ? Array.from({ length: bnplPerWeek >= 3 ? rint(2, 3) : 1 }, () => pick(BNPL)).filter((v, i, a) => a.indexOf(v) === i) : [];
  const gamblingPerWeek = rr(prof.gambling || 0); const alcoholPerWeek = rr(prof.alcoholPerWeek || 0);
  const savings = r2(rr(prof.savings || 0)); const lendersN = Math.round(rr(prof.lenders || 0)); const lenders = Array.from({ length: lendersN }, () => pick(LENDERS)).filter((v, i, a) => a.indexOf(v) === i);
  const paydayN = Math.round(rr(prof.payday || 0)); const paydays = Array.from({ length: paydayN }, () => pick(PAYDAY)).filter((v, i, a) => a.indexOf(v) === i);
  const familyInPerMonth = rr(prof.familyIn || [0, 0.4]); const diningPct = rr(prof.dining || [0.02, 0.09]); const subsN = Math.round(rr(prof.subs || [0, 3]));
  const churchWeekly = chance(0.45) ? r2(rand(20, 80)) : 0;
  const medical = !!prof.medical; const drop = !!prof.drop || (medical && chance(0.5));
  const dropFrom = addDays(end, -rint(18, 34)); const dropFactor = drop ? rand(0.35, 0.7) : 1;
  const acc = drop && chance(0.5);

  // Budget calibration: expected fixed outgoings per month vs income -> scale discretionary so total spend ~= income x spendRatio
  const spendRatio = rr(prof.spendRatio || [0.9, 1.0]);
  const expectedFixed = rent + 150 + 65 + (chance(0.7) ? 80 : 0) + monthly * remitPct + savings + lendersN * 340 + paydayN * 240 + bnplPerWeek * 4.35 * 27 + gamblingPerWeek * 4.35 * 40 + alcoholPerWeek * 4.35 * 42 + (medical ? 250 : 0);
  const baseDisc = 830 + 245 + diningPct * 4 * 28 * 30.4 + 187 + 77 + 79 + (churchWeekly ? churchWeekly * 4.35 : 0) + subsN * 20;
  const k = Math.max(0.35, Math.min(1.4, (monthly * spendRatio - expectedFixed) / baseDisc));
  let bal = r2(rr(prof.buffer)); const opening = bal; const tx = [];
  const odLimit = -pick([0, 50, 100, 200, 300]);   // unarranged overdraft tolerance of this account
  const T = (date, desc, amount, cat) => tx.push({ date: iso(date), desc, amount: r2(amount), cat });
  // debit that respects the bank's tolerance: below the limit the payment is declined (dishonour fee, nothing posted)
  const D = (date, desc, amount, cat) => { if (bal - amount < odLimit) { if (chance(0.6) && truth.fees < 10) { T(date, cat === 'bills' || cat === 'rent' || cat === 'loan' ? 'DISHONOUR FEE - DIRECT DEBIT' : 'UNARRANGED OVERDRAFT FEE', -10, 'fee'); truth.fees++; bal -= 10; } return false; } T(date, desc, -amount, cat); bal -= amount; return true; };
  // schedule
  let payDay = addDays(start, rint(0, gap - 1));
  const subsList = Array.from({ length: subsN }, () => pick(SUBS)).filter((v, i, a) => a.indexOf(v) === i);
  const billDay = { power: rint(3, 26), telco: rint(1, 28), insurance: rint(1, 28) };
  const power = pick(POWER), telco = pick(TELCO), insurance = chance(0.7) ? pick(INSURANCE) : null;
  const medEpisodeStart = medical ? addDays(end, -rint(25, 50)) : null;
  const truth = { income_monthly: monthly, cadence, bnpl: 0, bnpl_total: 0, gambling: 0, gambling_total: 0, remit: 0, remit_total: 0, alcohol: 0, fees: 0, family_in: 0, medical: 0, medical_total: 0, lenders: lenders.length + paydays.length, payday: paydays.length, income_credits: 0, drop, acc, opening };
  const daysWithBnpl = {};
  for (let d = new Date(start); d <= end; d = addDays(d, 1)) {
    const dom = d.getUTCDate(); const dow = d.getUTCDay();
    // income
    if (iso(d) === iso(payDay)) {
      const factor = (drop && d >= dropFrom) ? dropFactor : 1;
      if (!(drop && d >= dropFrom && factor < 0.45 && chance(0.4))) { T(d, employer, payAmt * factor, 'income'); truth.income_credits++; bal += payAmt * factor; }
      if (acc && d >= dropFrom) { const a = r2(payAmt * rand(0.5, 0.8)); T(d, 'ACC WEEKLY COMPENSATION', a, 'income'); truth.income_credits++; bal += a; }
      payDay = addDays(payDay, gap);
      // payday behaviours
      if (remitPct > 0 && (cadence !== 'weekly' || chance(0.5))) { const a = r2(monthly * remitPct * (cadence === 'weekly' ? 12 / 26 : gap / 30.4375)); if (a >= 40) { if (D(d, remitDesc, a, 'remittance')) { truth.remit++; truth.remit_total += a; } } }
      if (savings > 0) { const a = r2(savings * gap / 30.4375); D(d, 'TRANSFER TO SAVINGS 38-9012-0345678-01', a, 'own'); }
      for (const l of lenders) { const a = r2(rand(80, 260) * (gap / 14)); D(d, l, a, 'loan'); }
      for (const p of paydays) { const a = r2(rand(60, 180)); D(d, `${p} REPAYMENT`, a, 'payday'); }
      if (rentWeekly ? false : true) { /* fortnightly/monthly rent paid on payday below */ }
    }
    // rent
    if (rentWeekly ? dow === 1 : (cadence === 'monthly' ? dom === 1 : (Math.round((d - start) / 86400000) % 14 === 1))) { const a = rentWeekly ? rent * 12 / 52 : (cadence === 'monthly' ? rent : rent * 12 / 26); D(d, rentDesc, a, 'rent'); }
    // bills
    if (dom === billDay.power) { const a = r2(rand(90, 220)); D(d, power, a, 'bills'); }
    if (dom === billDay.telco) { const a = r2(rand(35, 95)); D(d, telco, a, 'bills'); }
    if (insurance && dom === billDay.insurance) { const a = r2(rand(45, 120)); D(d, insurance, a, 'bills'); }
    if (churchWeekly && dow === 0 && bal > 0) { D(d, pick(CHURCH), churchWeekly, 'other'); }
    for (const s of subsList) if (dom === (SUBS.indexOf(s) % 27) + 1) { const a = r2(rand(9, 35)); D(d, s, a, 'subs'); }
    // groceries / fuel / dining
    const broke = bal < -150;   // people stop discretionary spending when the account is deep in the red
    if (!broke && chance(0.28 * Math.min(1, k + 0.3))) { const a = r2(rand(35, 160) * Math.min(1, k + 0.2)); D(d, pick(GROCERY), a, 'groceries'); }
    if (!broke && chance(0.12 * k)) { const a = r2(rand(40, 95)); D(d, pick(FUEL), a, 'fuel'); }
    if (!broke && chance(diningPct * 4 * k)) { const a = r2(rand(9, 48)); D(d, pick(DINING), a, 'dining'); }
    if (!broke && chance(0.08 * k)) { const a = r2(rand(15, 140)); D(d, pick(RETAIL), a, 'retail'); }
    if (!broke && chance(0.05 * k)) { const a = r2(rand(12, 90)); D(d, pick(ONLINE), a, 'online'); }
    if (!broke && chance(0.04 * k)) { const a = r2(rand(10, 120)); D(d, pick(UNKNOWN), a, 'unknown'); }
    // risk behaviours
    const bnplToday = Math.min(3, Math.floor(bnplPerWeek / 7 + (chance((bnplPerWeek / 7) % 1) ? 1 : 0)));
    for (let i = 0; i < bnplToday; i++) { const a = r2(pick([18.75, 22.5, 24.99, 31.25, 37.5, 12.49, 49.99, 15])); if (D(d, pick(bnplProviders), a, 'bnpl')) { truth.bnpl++; truth.bnpl_total += a; daysWithBnpl[iso(d)] = 1; } }
    if (gamblingPerWeek && chance(gamblingPerWeek / 7)) { const a = r2(pick([10, 20, 25, 30, 40, 50, 60, 100])); if (D(d, pick(GAMBLING), a, 'gambling')) { truth.gambling++; truth.gambling_total += a; } }
    if (alcoholPerWeek && chance(alcoholPerWeek / 7)) { const a = r2(rand(15, 70)); if (D(d, pick(ALCOHOL), a, 'alcohol')) truth.alcohol++; }
    if (chance(0.03)) { const a = r2(rand(15, 40)); D(d, pick(TOBACCO), a, 'tobacco'); }
    if (familyInPerMonth && chance(familyInPerMonth / 30.4)) { const a = r2(rand(40, 250)); T(d, pick(FAMILY), a, 'family_in'); truth.family_in++; bal += a; }
    if (medical && d >= medEpisodeStart && chance(0.22)) { const big = chance(0.15); const a = r2(big ? rand(400, 2400) : rand(18, 160)); if (D(d, pick(MEDICAL), a, 'medical')) { truth.medical++; truth.medical_total += a; } }
    if (bal < 50 && chance(0.15)) { const a = r2(pick([20, 40, 50, 100])); D(d, 'ATM WITHDRAWAL MANUKAU', a, 'atm'); }
    // fees when overdrawn
    if (bal < 0 && chance(0.06) && truth.fees < 10) { T(d, 'UNARRANGED OVERDRAFT FEE', -15, 'fee'); truth.fees++; bal -= 15; }
    if (bal < 0 && chance(0.12)) { const a = r2(Math.min(-bal + rand(20, 120), 400)); T(d, pick(FAMILY), a, 'family_in'); truth.family_in++; bal += a; }   // someone bails them out
  }
  // running balances
  let b = opening; for (const t of tx) { b = r2(b + t.amount); t.balance = b; }
  truth.closing = b; truth.days = days; truth.months = r2(months);
  truth.bnpl_monthly = r2(truth.bnpl_total / months); truth.remit_monthly = r2(truth.remit_total / months); truth.remit_pct = r2(truth.remit_monthly / monthly * 100);
  const name = pick(NAMES);
  const app = { id: null, applicant_name: name, loan_amount: pick([500, 800, 1000, 1500, 2000, 2500, 3000]), interest_rate: 49 /* % p.a. — TerePay's fixed rate; ~4.74% is the total over the 8-week term */, income: r2(monthly * rand(0.85, 1.15)), expenses: r2(monthly * rand(0.6, 0.95)), existing_debt: lenders.length ? r2(rand(300, 4000)) : 0, loan_purpose: pick(prof.purpose), created_at: '2026-09-01T09:00:00+12:00' };
  const history = prof.history === 'good' ? `TEREPAY CUSTOMER HISTORY EXTRACT\nPrevious loan TPN-${rint(1000, 2999)}: $${pick([800, 1000, 1500])} over ${pick([6, 9, 12])} months, repaid in full ${pick([1, 2, 3])} months early. All instalments paid on time. Customer emailed ahead of a pay-date change to confirm the debit timing.`
    : prof.history === 'bad' ? `TEREPAY CUSTOMER HISTORY EXTRACT\nPrevious loan TPN-${rint(1000, 2999)}: $${pick([800, 1000, 1500])} over 12 months. ${pick([2, 3, 4])} missed payments; account went into arrears in ${pick(['March', 'April', 'May'])} 2026. Customer did not respond to two calls and one email; a default was listed with Centrix in June 2026. Requested a top-up to a larger amount within ${pick([3, 5])} weeks of drawdown.`
    : prof.history === 'mixed' ? `TEREPAY CUSTOMER HISTORY EXTRACT\nPrevious loan TPN-${rint(1000, 2999)}: $${pick([800, 1000])} over 9 months, completed. One missed payment in ${pick(['February', 'March'])} 2026, caught up the following week after the customer called to explain a late pay run.` : '';
  return { profile: profileName, opening, tx, app, truth, history, cadence, name };
}

// ---------------- bank layouts ----------------
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dmy = (s, sep = '/') => { const [y, m, d] = s.split('-'); return `${d}${sep}${m}${sep}${y}`; };
const dmy2 = s => { const [y, m, d] = s.split('-'); return `${d}/${m}/${y.slice(2)}`; };
const dMonY = s => { const [y, m, d] = s.split('-'); return `${d} ${MON[+m - 1]} ${y}`; };
const money = v => Math.abs(v).toLocaleString('en-NZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signed = v => (v < 0 ? '-' : '') + money(v);
const pad = (s, n) => (s + ' '.repeat(n)).slice(0, n);
const rpad = (s, n) => (' '.repeat(n) + s).slice(-n);
const LAYOUTS = {
  anz: c => [`ANZ NEW ZEALAND — GO ACCOUNT STATEMENT`, `Account: 01-0${rint(100, 999)}-0${rint(100000, 999999)}-00   Statement period: ${dMonY(c.tx[0].date)} to ${dMonY(c.tx[c.tx.length - 1].date)}   Opening balance: $${signed(c.opening)}`, ``, `Date        Description                                   Debit      Credit     Balance`,
    ...c.tx.map(t => `${dmy(t.date)}  ${pad(t.desc, 44)}${t.amount < 0 ? rpad(money(t.amount), 10) + ' '.repeat(11) : ' '.repeat(10) + rpad(money(t.amount), 11)}   ${rpad(signed(t.balance), 10)}`), `Closing balance: $${signed(c.truth.closing)}`].join('\n'),
  asb: c => [`ASB Bank Limited`, `Streamline Account   12-3${rint(100, 999)}-0${rint(100000, 999999)}-50`, `Statement Period ${dMonY(c.tx[0].date)} - ${dMonY(c.tx[c.tx.length - 1].date)}`, `Opening Balance ${signed(c.opening)}`, ``, `Date         Particulars                                Withdrawals      Deposits        Balance`,
    ...c.tx.map(t => `${pad(dMonY(t.date), 13)}${pad(t.desc, 42)}${t.amount < 0 ? rpad(money(t.amount), 12) + ' '.repeat(14) : ' '.repeat(12) + rpad(money(t.amount), 14)}${rpad(signed(t.balance), 15)}`), ``, `Closing Balance ${signed(c.truth.closing)}`, `Page 1 of 2`].join('\n'),
  bnz: c => [`BNZ  YouMoney Everyday`, `Account number 02-0${rint(100, 999)}-0${rint(100000, 999999)}-000`, `Transactions ${dmy2(c.tx[0].date)} to ${dmy2(c.tx[c.tx.length - 1].date)}`, `Opening balance ${signed(c.opening)}`, ``, `Date      Payee / Details                              Amount        Balance`,
    ...c.tx.map(t => `${dmy2(t.date)}  ${pad(t.desc, 42)}${rpad(signed(t.amount), 12)}${rpad(signed(t.balance), 14)}`), `Closing balance ${signed(c.truth.closing)}`].join('\n'),
  kiwibank: c => [`Kiwibank Limited  Free Up Account`, `Account 38-9${rint(100, 999)}-0${rint(100000, 999999)}-00`, `Statement from ${dmy(c.tx[0].date, '-')} to ${dmy(c.tx[c.tx.length - 1].date, '-')}`, `Opening Balance: $${signed(c.opening)}`, ``, `Date         Transaction Details                          Amount          Balance`,
    ...c.tx.map(t => `${dmy(t.date, '-')}   ${pad(t.desc, 42)}${rpad(money(t.amount) + (t.amount < 0 ? ' DR' : ' CR'), 14)}${rpad(money(t.balance) + (t.balance < 0 ? ' DR' : ' CR'), 16)}`), `Closing Balance: $${signed(c.truth.closing)}`].join('\n'),
  westpac: c => [`Westpac New Zealand Limited`, `Everyday Account  03-0${rint(100, 999)}-0${rint(100000, 999999)}-00`, `Statement ${dmy(c.tx[0].date)} to ${dmy(c.tx[c.tx.length - 1].date)}`, `Opening balance: $${signed(c.opening)}`, ``, `Date         Transaction Description                         Amount         Balance`,
    ...c.tx.map(t => `${dmy(t.date)}   ${pad(t.desc, 44)}${rpad('$' + signed(t.amount), 12)}${rpad('$' + signed(t.balance), 15)}`), `Closing balance: $${signed(c.truth.closing)}`].join('\n'),
};

// ---------------- main ----------------
function main() {
  const args = process.argv.slice(2); const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
  const n = Number(opt('n', 100)), seed = Number(opt('seed', 7)), out = opt('out', path.join(__dirname, 'data')); const layouts = opt('layouts', 'anz,asb,bnz,kiwibank,westpac').split(',');
  R = rng(seed);
  const names = Object.keys(PROFILES); const weights = names.map(k => PROFILES[k].w); const wsum = weights.reduce((a, b) => a + b, 0);
  fs.mkdirSync(out, { recursive: true });
  const index = [];
  for (let i = 0; i < n; i++) {
    let r = R() * wsum, pname = names[0]; for (let k = 0; k < names.length; k++) { r -= weights[k]; if (r <= 0) { pname = names[k]; break; } }
    const c = simulate(pname, PROFILES[pname]);
    const id = `case-${String(i + 1).padStart(4, '0')}-${pname}`; const dir = path.join(out, id); fs.mkdirSync(dir, { recursive: true });
    c.app.id = `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`;
    for (const L of layouts) fs.writeFileSync(path.join(dir, `statement-${L}.txt`), LAYOUTS[L](c) + (c.history ? `\n\n${c.history}\n` : '\n'));
    fs.writeFileSync(path.join(dir, 'application.json'), JSON.stringify(c.app, null, 2));
    fs.writeFileSync(path.join(dir, 'truth.json'), JSON.stringify(Object.assign({ profile: pname, transactions: c.tx.length }, c.truth), null, 2));
    index.push({ id, profile: pname, transactions: c.tx.length, days: c.truth.days, income_monthly: c.truth.income_monthly, purpose: c.app.loan_purpose });
  }
  fs.writeFileSync(path.join(out, 'index.json'), JSON.stringify(index, null, 2));
  const byP = {}; for (const x of index) byP[x.profile] = (byP[x.profile] || 0) + 1;
  console.log(`generated ${n} cases x ${layouts.length} layouts in ${out}`); console.log(byP);
}
if (require.main === module) main();
module.exports = { simulate, PROFILES, LAYOUTS };
