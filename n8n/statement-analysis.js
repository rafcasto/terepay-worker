// TerePay statement analysis — v1.0
// Deterministic parsing + metric computation for bank-statement text (pdftotext / n8n Extract From File output).
// Pure functions, no I/O. Used inside the n8n "Analyse Statements" Code node and by the test harness.
//
//   parseTransactions(text)                 -> { transactions[], opening_balance, notes[] }
//   analyseTransactions(txns, opts)          -> metrics object (all numbers the rules engine needs)
//   buildLlmBrief(analysis, application, otherDocsText, findings) -> compact text for the model (judgement + narrative only)
//   mergeObservations(analysis, judgement, opts)                   -> object in the shape scoreAssessment() expects (hallucination-gated)
//   repairJson(raw)                                                -> parse possibly truncated model JSON

// ---------------------------------------------------------------------------------------------
// Merchant / description patterns (NZ-centric; extend freely — every hit is recorded with the line)
// ---------------------------------------------------------------------------------------------
const P = {
  income:        /\b(salary|wages?|payroll|pay\s*run|winz|msd|work\s*and\s*income|ministry\s*of\s*social|benefit|jobseeker|sole\s*parent|supported\s*living|nz\s*super|superannuation|studylink|student\s*allowance|acc\s*(weekly|comp|payment)|ird\s*(refund|wff|working\s*for\s*families)|working\s*for\s*families|paid\s*parental)\b/i,
  ownTransfer:   /\b(transfer\s*to\s*savings|to\s*savings|from\s*savings|savings\s*transfer|own\s*account|internal\s*transfer|kiwisaver|term\s*deposit|to\s*serious\s*saver|from\s*serious\s*saver|to\s*notice\s*saver|from\s*notice\s*saver|to\s*online\s*call|from\s*online\s*call)\b/i,
  transferIn:    /\b(transfer\s*from|tfr\s*from|from\s+[a-z][a-z'\-]*(\s+[a-z][a-z'\-]+)?|deposit\s*from|osko|payid|ap\s*from|automatic\s*payment\s*from|dep\s*from|mobile\s*deposit|cash\s*deposit)\b/i,
  bnpl:          /\b(afterpay|after\s*pay|zip\s*(co|pay|money)?|laybuy|lay-buy|klarna|humm|genoapay|genoa\s*pay|openpay|latitude\s*pay|paypal\s*pay\s*in\s*4|payflex|splitit)\b/i,
  gambling:      /\b(tab\s*nz|tabnz|tab\s*online|tab\b|sky\s*bet|skybet|betcha|bet365|betway|unibet|sportsbet|ladbrokes|pokerstars|entain|mylotto|lotto\s*nz|lotto\b|instant\s*kiwi|skycity|sky\s*city|casino|pokies|gaming\s*machine|betfair|neds|bluebet|draftkings|stake\.com|1xbet|jackpot\s*city|spin\s*casino)\b/i,
  alcohol:       /\b(liquorland|liquor\s*land|super\s*liquor|thirsty\s*liquor|the\s*bottle-?o|bottle\s*o|liquor\s*centre|liquor\s*king|big\s*barrel|glengarry|black\s*bull|bws|dan\s*murphy|liquor|wine\s*shop|brew\s*bar|bottle\s*shop)\b/i,
  tobacco:       /\b(shosha|vape|vapo|alt\s*nz|tobacco|cosmic|smoke\s*shop|cigarette|e-?liquid)\b/i,
  remittance:    /\b(western\s*union|wu\s*apia|moneygram|world\s*remit|worldremit|remitly|orbit\s*remit|orbitremit|ria\s*money|ria\s*financial|xoom|wise\s*(transfer|payments)?|transferwise|kliksend|ave\s*money|ave\s*pay|kwikcash|digicel\s*mobile\s*money|m-?paisa|remit|international\s*(transfer|payment|tfr)|intl\s*(tfr|transfer|pmt)|overseas\s*(transfer|payment)|telegraphic\s*transfer|\btt\s*to\b|swift\s*transfer|foreign\s*currency|fx\s*transfer|to\s*(apia|nuku'?alofa|suva|manila|new\s*delhi|mumbai|lahore|karachi|dhaka|nadi|rarotonga|honiara|port\s*vila))\b/i,
  paydayLender:  /\b(moola|save\s*my\s*bacon|pretty\s*penny|cash\s*converters|ferratum|nimble|superloans|instant\s*finance|seed\s*cash|zebra\s*loans|need\s*cash\s*today|quick\s*cash|cash\s*relief|payday|the\s*lending\s*people|max\s*loans|cash\s*burst|loansmart|smart\s*cash|1st\s*capital|acorn\s*finance|money\s*shop|nectar\s*loans|nectar)\b/i,
  lender:        /\b(harmoney|avanti|latitude|gem\s*visa|gem\s*finance|q\s*card|qcard|q\s*mastercard|finance\s*now|pioneer\s*finance|geneva\s*finance|lending\s*crowd|squirrel|terepay|tere\s*pay|mtf\s*finance|udc|heartland|turners\s*finance|toyota\s*finance|oxford\s*finance|first\s*credit|credit\s*card|creditcard|visa\s*(payment|pmt)|mastercard\s*(payment|pmt)|amex|american\s*express|loan\s*(repayment|pmt|payment|rpmt)|personal\s*loan|car\s*loan|hire\s*purchase|flexi\s*card|farmers\s*card|afterpay\s*plus)\b/i,
  cashAdvanceIn: /\b(loan\s*(advance|drawdown|disbursement|top\s*up|topup)|cash\s*advance|credit\s*(advance|drawdown)|harmoney|avanti|latitude|moola|save\s*my\s*bacon|pretty\s*penny|ferratum|nimble|superloans|instant\s*finance|finance\s*now|pioneer|geneva|terepay)\b/i,
  penaltyFee:    /\b(overdraft|unarranged|dishonou?r|honou?r\s*fee|late\s*(fee|payment\s*fee)|penalty|default\s*fee|nsf|insufficient\s*funds|returned\s*payment|failed\s*payment\s*fee|arrears\s*fee|reversal\s*fee|excess\s*fee)\b/i,
  bankFee:       /\b(account\s*fee|monthly\s*fee|service\s*fee|maintenance\s*fee|transaction\s*fee|atm\s*fee|card\s*fee|annual\s*fee|bank\s*fee|fee\b)/i,
  atm:           /\b(atm|cash\s*withdrawal|cash\s*out|wdl\b|withdrawal)\b/i,
  rent:          /\b(rent|rental|tenancy|property\s*(mgmt|management)|barfoot|harcourts|ray\s*white|quinovic|crockers|kainga\s*ora|housing\s*nz|mortgage|home\s*loan)\b/i,
  utilities:     /\b(mercury|genesis|contact\s*energy|meridian|electric\s*kiwi|flick|nova\s*energy|pulse\s*energy|frank\s*energy|trustpower|powershop|globug|watercare|wellington\s*water|rates|council|spark|2degrees|one\s*nz|vodafone|skinny|slingshot|orcon|2talk|kogan\s*mobile|warehouse\s*mobile|insurance|aa\s*insurance|ami\b|state\s*insurance|tower\s*insurance|southern\s*cross|nib\b|partners\s*life|vero|fmg|cove|protecta|childcare|kindy|daycare|school\s*fees|early\s*learning|best\s*start)\b/i,
  groceries:     /\b(countdown|woolworths|pak\s*n\s*save|paknsave|pak'n'save|new\s*world|newworld|four\s*square|fresh\s*choice|supervalue|super\s*value|night\s*n\s*day|dairy|mini\s*mart|asian\s*(super)?market|tai\s*ping|lim\s*chhour|farro|moore\s*wilson|bin\s*inn|the\s*warehouse\s*(grocery)?|costco|butcher|fruit\s*(and|&)\s*vege|veggie)\b/i,
  fuel:          /\b(z\s*energy|z\s*\w+\s*\w*\b(?=.*fuel)|bp\b|caltex|mobil|gull|npd|waitomo|challenge\s*fuel|allied\s*petroleum|pak\s*n\s*save\s*fuel|petrol|fuel|service\s*station)\b/i,
  dining:        /\b(uber\s*eats|ubereats|doordash|menulog|delivereasy|mcdonald|mcd\b|kfc|burger\s*king|burgerfuel|burger\s*fuel|wendy'?s|carl'?s\s*jr|pizza\s*hut|domino'?s|dominos|hell\s*pizza|subway|sushi|st\s*pierre|columbus\s*coffee|starbucks|mojo\s*coffee|cafe|caf[eé]|coffee|espresso|restaurant|eatery|bistro|takeaway|takeaways|fish\s*(and|&)\s*chips|kebab|noodle|dumpling|bakery|bakehouse|muffin\s*break|nando'?s|hungry\s*jack|taco\s*bell|pita\s*pit|tank\s*juice|boost\s*juice|hungry|grill|diner|food\s*court|hospitality|bar\s*(and|&)\s*grill)\b/i,
  entertainment: /\b(netflix|spotify|disney|neon\b|sky\s*tv|sky\s*network|amazon\s*prime|prime\s*video|youtube|apple\.com\/bill|apple\s*music|tidal|twitch|steam\s*games|steampowered|playstation|xbox|nintendo|epic\s*games|riot\s*games|blizzard|event\s*cinemas|hoyts|reading\s*cinemas|cinema|movie|ticketek|ticketmaster|eventfinda|concert|festival|bowling|timezone|laser\s*tag|escape\s*room|nightclub|night\s*club|tavern|pub\b|bar\b|hotel\s*bar|rsa\b|cosmopolitan\s*club|workingmen'?s|sports\s*bar|brewery|onlyfans|patreon|tinder|bumble)\b/i,
  subscription:  /\b(netflix|spotify|disney|neon\b|sky\s*tv|amazon\s*prime|prime\s*video|youtube\s*premium|apple\.com\/bill|apple\s*music|icloud|google\s*(one|storage|play)|microsoft\s*365|office\s*365|adobe|dropbox|chatgpt|openai|anthropic|les\s*mills|cityfitness|city\s*fitness|anytime\s*fitness|jetts|snap\s*fitness|f45|club\s*physical|gym|hellofresh|my\s*food\s*bag|woop|audible|kindle\s*unlimited|crunchyroll|paramount|binge|tidal|patreon|onlyfans|nord\s*vpn|express\s*vpn|playstation\s*plus|xbox\s*game\s*pass|nintendo\s*online|linkedin\s*premium|canva)\b/i,
  rideshare:     /\b(uber(?!\s*eats)|ola\s*cabs|ola\b|zoomy|didi|bolt\s*ride|taxi|cab\b|corporate\s*cabs|green\s*cabs|lime\s*(scooter|ride)|beam\s*scooter|flamingo)\b/i,
  onlineShop:    /\b(amazon(?!\s*prime)|temu|shein|aliexpress|ali\s*express|trade\s*me|trademe|the\s*iconic|asos|ebay|wish\.com|zara\s*online|boohoo|pretty\s*little|fashion\s*nova|catch\.co|kogan|mighty\s*ape|onceit|hallenstein\s*online|glassons\s*online|noel\s*leeming\s*online|shopify|etsy|lightinthebox|dhgate)\b/i,
  luxury:        /\b(louis\s*vuitton|gucci|prada|chanel|dior|herm[eè]s|rolex|omega\s*boutique|cartier|tiffany|balenciaga|burberry|versace|fendi|celine|bottega|ysl|saint\s*laurent|valentino|givenchy|moncler|off-?white|supreme\s*store|michael\s*hill|partridge\s*jewellers|pascoes|stewart\s*dawson|mecca\s*(maxima|cosmetica)?|sephora|smith\s*(and|&)\s*caughey|david\s*jones|apple\s*store|nike\s*(store|town)|lululemon|kathmandu\s*premium|hugo\s*boss|ralph\s*lauren|coach\b|kate\s*spade|swarovski|pandora)\b/i,
  retail:        /\b(kmart|the\s*warehouse|warehouse\s*stationery|farmers|briscoes|rebel\s*sport|jb\s*hi-?fi|noel\s*leeming|harvey\s*norman|pb\s*tech|mitre\s*10|bunnings|hallenstein|glassons|cotton\s*on|h&m|zara|postie|number\s*one\s*shoes|hannahs|smiths\s*city|spotlight|look\s*sharp|typo|lush|body\s*shop|chemist\s*warehouse|unichem|life\s*pharmacy|bargain\s*chemist|ezibuy|torpedo7|stirling\s*sports|platypus|footlocker|foot\s*locker|culture\s*kings|barkers|country\s*road|witchery|max\b|decjuba|shoe\s*clinic|2\s*cheap|dollar\s*store|daiso|mall\b|shopping\s*centre)\b/i,
  refund:        /\b(refund|reversal|return|credit\s*adjustment|chargeback)\b/i,
  medical:       /\b(pharmacy|chemist|unichem|life\s*pharmacy|bargain\s*chemist|hospital|health\s*nz|te\s*whatu\s*ora|counties\s*manukau\s*health|waitemata\s*health|health\s*board|\bdhb\b|health\s*(centre|center|hub)|medical\s*(centre|center|clinic)|medical|doctor|dr\s+[a-z]+|gp\b|family\s*health|dental|dentist|lumino|orthodont|physio|radiology|pathology|labtests|x-?ray|ultrasound|optometr|specsavers|counsell|psycholog|surgery|surgical|clinic|healthcare|health\s*care|ambulance|st\s*john|mole\s*map|skin\s*clinic|ivf|maternity|midwife)\b/i,
  accIncome:     /\b(acc\b|accident\s*compensation|weekly\s*compensation|sick\s*(pay|leave)|income\s*protection|insurance\s*claim|claim\s*payment)\b/i,
  assetSale:     /\b(trade\s*me\s*(sale|payout|withdrawal)|tm\s*sale|facebook\s*marketplace|fb\s*marketplace|marketplace\s*sale|cash\s*converters\s*(buy|purchase)|pawn|sold\s*item|payout)\b/i,
};

const DATE_RE = /^\s*(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2}\s+[A-Za-z]{3,9}\.?\s+\d{2,4}|\d{1,2}\s+[A-Za-z]{3,9}\b)\s+(.*)$/;
const MONEY_TOKEN = /\(?-?\$?-?\d{1,3}(?:,\d{3})*(?:\.\d{2})\)?(?:\s?(?:CR|DR|Cr|Dr))?|\(?-?\$?-?\d+\.\d{2}\)?(?:\s?(?:CR|DR|Cr|Dr))?/;
const TRAILING_MONEY = new RegExp(`(?:\\s+(?:${MONEY_TOKEN.source}))+\\s*$`);
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };

function parseDate(s, hintYear) {
  s = s.trim();
  let m;
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/))) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if ((m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/))) { let y = +m[3]; if (y < 100) y += 2000; return new Date(Date.UTC(y, +m[2] - 1, +m[1])); }   // NZ: day first
  if ((m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(\d{2,4})$/))) { const mo = MONTHS[m[2].slice(0, 4).toLowerCase()] ?? MONTHS[m[2].slice(0, 3).toLowerCase()]; if (mo === undefined) return null; let y = +m[3]; if (y < 100) y += 2000; return new Date(Date.UTC(y, mo, +m[1])); }
  if ((m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,9})$/))) { const mo = MONTHS[m[2].slice(0, 3).toLowerCase()]; if (mo === undefined) return null; return new Date(Date.UTC(hintYear || new Date().getUTCFullYear(), mo, +m[1])); }
  return null;
}
function parseMoney(tok) {
  let t = tok.trim(); let neg = false;
  if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1); }
  if (/\bDR$/i.test(t)) { neg = true; } if (/\bCR$/i.test(t)) { neg = false; }
  t = t.replace(/\s?(CR|DR)$/i, '').replace(/[$,]/g, '');
  if (t.startsWith('-')) { neg = true; t = t.slice(1); }
  if (t.startsWith('-')) { t = t.slice(1); }   // tolerate '$-' and '-$-' variants
  const v = parseFloat(t); if (!isFinite(v)) return null; return neg ? -v : v;
}
const iso = d => d.toISOString().slice(0, 10);
const round2 = v => Math.round(v * 100) / 100;

// ---------------------------------------------------------------------------------------------
function parseTransactions(text) {
  const notes = [];
  const lines = String(text || '').split(/\r?\n/);
  let opening = null, hintYear = null;
  for (const l of lines) { const m = l.match(/opening\s*balance[^\d\-$(]*(\(?-?\$?[\d,]+\.\d{2}\)?)/i); if (m) { opening = parseMoney(m[1]); break; } }
  for (const l of lines) { const y = l.match(/\b(20\d{2})\b/); if (y) { hintYear = +y[1]; break; } }

  const raw = []; const residual = [];
  for (const line of lines) {
    const dm = line.match(DATE_RE); if (!dm) { residual.push(line); continue; }
    const date = parseDate(dm[1], hintYear); if (!date) { residual.push(line); continue; }
    let rest = dm[2];
    const tm = rest.match(TRAILING_MONEY); if (!tm) { residual.push(line); continue; }   // a dated line with no amounts is a header/continuation
    const nums = tm[0].trim().split(/\s+(?=[\(\-$\d])/).map(parseMoney).filter(v => v !== null);
    const desc = rest.slice(0, rest.length - tm[0].length).replace(/\s{2,}/g, ' ').trim();
    if (!desc || nums.length === 0) continue;
    raw.push({ date, desc, nums, line: line.trim() });
  }
  // Prose that is not part of the transaction table (e.g. a credit-history note appended to the statement)
  const residualText = residual.map(l => l.trim()).filter(l => l.length > 30 && !/^(date|description|debit|credit|balance|account|statement|opening|closing|page|\s*$)/i.test(l) && (l.match(/[A-Za-z]{3,}/g) || []).length >= 5).join('\n');
  if (!raw.length) return { transactions: [], opening_balance: opening, notes: ['No transaction lines recognised'], residual_text: residualText };

  // Decide layout: with >=2 numbers the last is the running balance. Signs come from balance deltas (bank-agnostic).
  const withBal = raw.filter(r => r.nums.length >= 2).length;
  const useBalance = withBal >= raw.length * 0.8;
  if (!useBalance) notes.push('Running balance column not detected; amounts signed by keywords');
  let prev = opening;
  const txns = [];
  for (const r of raw) {
    let amount, balance = null;
    if (useBalance && r.nums.length >= 2) {
      balance = r.nums[r.nums.length - 1];
      const mag = Math.abs(r.nums[r.nums.length - 2]);
      if (prev !== null) {
        const delta = round2(balance - prev);
        amount = Math.abs(Math.abs(delta) - mag) < 0.011 ? delta : (delta < 0 ? -mag : mag);
        if (Math.abs(Math.abs(delta) - mag) >= 0.011) notes.push(`Balance delta mismatch on ${iso(r.date)} "${r.desc}" (delta ${delta}, amount ${mag})`);
      } else {
        amount = (P.income.test(r.desc) || P.transferIn.test(r.desc) || P.refund.test(r.desc)) ? mag : -mag;
      }
      prev = balance;
    } else {
      const v = r.nums[0];
      const explicitNeg = v < 0 || /\bDR\b/i.test(r.line);
      const creditish = /\bCR\b/i.test(r.line) || P.income.test(r.desc) || P.transferIn.test(r.desc) || P.refund.test(r.desc) || P.cashAdvanceIn.test(r.desc);
      amount = explicitNeg ? -Math.abs(v) : (creditish ? Math.abs(v) : -Math.abs(v));
      if (r.nums.length >= 2) balance = r.nums[r.nums.length - 1];
      if (prev !== null && balance === null) { prev = round2(prev + amount); balance = prev; }
    }
    txns.push({ date: iso(r.date), desc: r.desc, amount: round2(amount), balance: balance === null ? null : round2(balance), line: r.line });
  }
  txns.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  return { transactions: txns, opening_balance: opening, notes, residual_text: residualText };
}

// ---------------------------------------------------------------------------------------------
function classify(desc, amount) {
  const d = desc;
  const isCredit = amount > 0;
  if (isCredit) {
    if (P.income.test(d) || P.accIncome.test(d)) return 'income';
    if (P.ownTransfer.test(d)) return 'own_transfer_in';
    if (P.refund.test(d)) return 'refund';
    if (P.cashAdvanceIn.test(d) || P.paydayLender.test(d)) return 'credit_advance_in';
    if (P.assetSale.test(d)) return 'asset_sale';
    if (P.transferIn.test(d)) return 'transfer_in';
    return 'other_credit';
  }
  if (P.gambling.test(d)) return 'gambling';
  if (P.bnpl.test(d)) return 'bnpl';
  if (P.remittance.test(d)) return 'remittance';
  if (P.paydayLender.test(d)) return 'payday_lender';
  if (P.penaltyFee.test(d)) return 'penalty_fee';
  if (P.lender.test(d)) return 'loan_repayment';
  if (P.ownTransfer.test(d)) return 'own_transfer_out';
  if (P.medical.test(d)) return 'medical';
  if (P.alcohol.test(d)) return 'alcohol';
  if (P.tobacco.test(d)) return 'tobacco';
  if (P.atm.test(d)) return 'atm';
  if (P.rent.test(d)) return 'rent';
  if (P.utilities.test(d)) return 'bills';
  if (P.groceries.test(d)) return 'groceries';
  if (P.fuel.test(d)) return 'fuel';
  if (P.dining.test(d)) return 'dining';
  if (P.subscription.test(d)) return 'subscription';
  if (P.entertainment.test(d)) return 'entertainment';
  if (P.rideshare.test(d)) return 'rideshare';
  if (P.luxury.test(d)) return 'luxury';
  if (P.onlineShop.test(d)) return 'online_shopping';
  if (P.retail.test(d)) return 'retail';
  if (P.bankFee.test(d)) return 'bank_fee';
  if (/\btransfer\s*to\b|\bap\s*to\b|\bpayment\s*to\b|\bto\s+[a-z][a-z'\-]+\s+[a-z][a-z'\-]+\b/i.test(d)) return 'transfer_out';
  return 'other_debit';
}

const normDesc = d => d.toLowerCase().replace(/[\d#*\/\-:.]+/g, ' ').replace(/\b(payment|pmt|ap|dd|direct debit|online|eftpos|visa|debit|purchase|card)\b/g, ' ').replace(/\s+/g, ' ').trim().split(' ').slice(0, 4).join(' ');
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
const weekKey = d => { const t = new Date(d + 'T00:00:00Z'); const day = (t.getUTCDay() + 6) % 7; t.setUTCDate(t.getUTCDate() - day); return iso(t); };
const sum = arr => round2(arr.reduce((s, t) => s + Math.abs(t.amount), 0));
const pct = (part, whole) => (whole && whole > 0) ? round2(part / whole * 100) : null;

function analyseTransactions(txns, opts) {
  opts = opts || {};
  const A = { parser: { transaction_count: txns.length, mode: 'deterministic' } };
  if (!txns.length) { A.parser.mode = 'none'; return A; }

  for (const t of txns) t.category = classify(t.desc, t.amount);
  const by = cat => txns.filter(t => t.category === cat);
  const start = txns[0].date, end = txns[txns.length - 1].date;
  const periodDays = Math.max(1, daysBetween(start, end) + 1);
  const months = periodDays / 30.4375, weeks = periodDays / 7;
  A.period = { start, end, days: periodDays, months: round2(months) };

  // ---- income: keyword credits + recurring credits >= $200 seen >= 2 times ----
  const credits = txns.filter(t => t.amount > 0);
  const recur = {}; for (const t of credits) { const k = normDesc(t.desc); (recur[k] = recur[k] || []).push(t); }
  // promote an unlabelled recurring credit to income only if it behaves like a pay run: 3+ credits, regular gap, near-identical amounts
  const looksLikePay = k => { const g = recur[k]; if (!g || g.length < 3) return false; const ds = [...new Set(g.map(t => t.date))].sort(); const gaps = ds.slice(1).map((d, i) => daysBetween(ds[i], d)); const mg = gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)]; if (!(mg >= 5 && mg <= 35)) return false; const amts = g.map(t => t.amount); const mean = amts.reduce((a, b) => a + b, 0) / amts.length; const cv = Math.sqrt(amts.reduce((a, v) => a + (v - mean) ** 2, 0) / amts.length) / mean; return cv < 0.1 && mean >= 200; };
  const incomeTx = credits.filter(t => t.category === 'income' || (t.category === 'other_credit' && looksLikePay(normDesc(t.desc))));
  for (const t of incomeTx) t.category = 'income';
  const incomeTotal = sum(incomeTx);
  // Annualise by detected pay cadence so 5 fortnightly pays in 62 days don't inflate "monthly" income
  const payDatesU = [...new Set(incomeTx.map(t => t.date))].sort();
  const gaps = payDatesU.slice(1).map((d, i) => daysBetween(payDatesU[i], d)).filter(g => g > 0);
  const medGap = gaps.length ? gaps.slice().sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : null;
  let cadence = 'irregular', perYear = null;
  if (medGap !== null) { if (medGap >= 5 && medGap <= 9) { cadence = 'weekly'; perYear = 52; } else if (medGap >= 12 && medGap <= 16) { cadence = 'fortnightly'; perYear = 26; } else if (medGap >= 26 && medGap <= 35) { cadence = 'monthly'; perYear = 12; } }
  let observedIncome = null;
  if (incomeTx.length) {
    if (perYear) { const typical = incomeTx.slice().sort((a, b) => a.amount - b.amount)[Math.floor(incomeTx.length / 2)].amount; observedIncome = round2(typical * perYear / 12); }
    else observedIncome = round2(incomeTotal / months);
  }
  const inc = observedIncome;
  // income trend: most recent 30 days vs the earlier part of the statement (sick leave / lost hours show up here)
  // Compare per-pay amounts (median) and missing pays, not window sums - window sums alias with fortnightly pay cycles.
  const recentCut = new Date(Date.parse(end) - 29 * 86400000).toISOString().slice(0, 10);
  const accTx = incomeTx.filter(t => P.accIncome.test(t.desc));
  const regular = incomeTx.filter(t => !P.accIncome.test(t.desc));
  const recentInc = regular.filter(t => t.date >= recentCut), priorInc = regular.filter(t => t.date < recentCut);
  const median = arr => { if (!arr.length) return null; const v = arr.map(t => t.amount).sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; };
  const priorMed = median(priorInc), recentMed = median(recentInc);
  let incomeDropPct = null;
  if (priorMed && priorInc.length >= 2) {
    const amountDrop = recentMed === null ? 100 : Math.max(0, (priorMed - recentMed) / priorMed * 100);
    const expectedRecent = medGap ? Math.max(1, Math.floor(30 / medGap)) : null;
    const missingDrop = expectedRecent ? Math.max(0, (expectedRecent - recentInc.length) / expectedRecent * 100) : 0;
    incomeDropPct = round2(Math.max(amountDrop, missingDrop));
  }
  const priorMonthly = priorMed && perYear ? round2(priorMed * perYear / 12) : null;
  A.income_credits = incomeTx.map(t => ({ date: t.date, amount: t.amount }));
  A.income = { observed_net_monthly: inc, credits_count: incomeTx.length, cadence, median_gap_days: medGap, period_total: incomeTotal, sources: [...new Set(incomeTx.map(t => normDesc(t.desc)))], pay_dates: payDatesU,
    recent_30d_income: round2(sum(recentInc)), recent_median_pay: recentMed, prior_median_pay: priorMed, prior_monthly_income: priorMonthly, income_drop_pct: incomeDropPct, acc_or_claim_credits: accTx.length, acc_or_claim_total: sum(accTx) };

  // ---- BNPL ----
  const bnpl = by('bnpl');
  const bnplWeeks = {}; for (const t of bnpl) bnplWeeks[weekKey(t.date)] = (bnplWeeks[weekKey(t.date)] || 0) + 1;
  const half = Math.floor(bnpl.length / 2);
  const avg = arr => arr.length ? arr.reduce((s, t) => s + Math.abs(t.amount), 0) / arr.length : null;
  A.bnpl = {
    providers: [...new Set(bnpl.map(t => (t.desc.match(P.bnpl) || [''])[0].toUpperCase().replace(/\s+/g, ' ').trim()))],
    transaction_count: bnpl.length, transaction_count_60d: bnpl.filter(t => daysBetween(t.date, end) < 60).length,
    total: sum(bnpl), monthly_spend: round2(sum(bnpl) / months), pct_of_income: pct(sum(bnpl) / months, inc),
    max_per_week: Object.values(bnplWeeks).length ? Math.max(...Object.values(bnplWeeks)) : 0, avg_per_week: round2(bnpl.length / weeks),
    small_txns_5_20: bnpl.filter(t => Math.abs(t.amount) >= 5 && Math.abs(t.amount) <= 20).length,
    amounts_shrinking: bnpl.length >= 6 ? avg(bnpl.slice(half)) < avg(bnpl.slice(0, half)) * 0.8 : null,
  };

  // ---- balance reconstruction ----
  const hasBal = txns.filter(t => t.balance !== null).length >= txns.length * 0.8;
  if (hasBal) {
    const eod = {}; for (const t of txns) if (t.balance !== null) eod[t.date] = t.balance;
    const days = []; let cur = new Date(start + 'T00:00:00Z'); let last = txns[0].balance;
    while (iso(cur) <= end) { const k = iso(cur); if (eod[k] !== undefined) last = eod[k]; days.push({ date: k, balance: last }); cur.setUTCDate(cur.getUTCDate() + 1); }
    const under = lim => days.filter(d => d.balance < lim).length;
    const balances = days.map(d => d.balance);
    const preBal = i => { for (let j = i - 1; j >= 0; j--) if (txns[j].balance !== null) return txns[j].balance; return null; };
    const payDates = incomeTx.map(t => t.date);
    let nearZeroAfterPay = 0;
    for (const pd of payDates) { const window = days.filter(d => d.date >= pd && daysBetween(pd, d.date) <= 3); if (window.some(d => d.balance < 50)) nearZeroAfterPay++; }
    A.cash_flow = {
      balance_days_reconstructed: days.length,
      lowest_balance_by_month: Object.entries(days.reduce((m, d) => { const k = d.date.slice(0, 7); m[k] = m[k] === undefined ? d.balance : Math.min(m[k], d.balance); return m; }, {})).map(([month, low]) => ({ month, low })),
      min_balance: Math.min(...balances), max_balance: Math.max(...balances), avg_balance: round2(balances.reduce((a, b) => a + b, 0) / balances.length),
      days_under_100_per_month: round2(under(100) / months), days_under_50_per_month: round2(under(50) / months), days_under_20_per_month: round2(under(20) / months),
      zero_balance_events_per_month: round2(days.reduce((acc, d, i) => acc + ((d.balance <= 0 && (i === 0 || days[i - 1].balance > 0)) ? 1 : 0), 0) / months), zero_balance_days: days.filter(d => d.balance <= 0).length,
      overdraft_or_dishonour_fees: by('penalty_fee').length,
      near_zero_within_3_days_of_pay: nearZeroAfterPay > 0, near_zero_after_pay_count: nearZeroAfterPay, paydays: payDates.length,
      atm_withdrawals_when_under_50: txns.filter((t, i) => t.category === 'atm' && t.balance !== null && t.balance < 50).length,
      micro_spending_when_low: txns.filter((t, i) => t.amount < 0 && Math.abs(t.amount) <= 5 && t.balance !== null && t.balance < 50).length,
      pct_days_at_or_above_200: round2(days.filter(d => d.balance >= 200).length / days.length * 100),
    };
  } else {
    A.cash_flow = { balance_days_reconstructed: 0, overdraft_or_dishonour_fees: by('penalty_fee').length, note: 'No running balance column; balance-based metrics unavailable' };
  }

  // ---- credit dependency ----
  const loanTx = by('loan_repayment').concat(by('payday_lender'));
  const facilities = [...new Set(loanTx.map(t => normDesc(t.desc)).concat(A.bnpl.providers.map(p => p.toLowerCase())))];
  const advancesIn = by('credit_advance_in');
  const famIn = by('transfer_in');
  const bailouts = famIn.filter(t => t.balance !== null ? (round2(t.balance - t.amount) < 100) : true);   // arrived while balance was under $100 (pre-transfer)
  const famPerWeek = bailouts.length / weeks, famPerMonth = bailouts.length / months;
  A.credit_dependency = {
    active_credit_facilities: facilities.length, facilities,
    payday_lenders: [...new Set(by('payday_lender').map(t => normDesc(t.desc)))],
    loan_repayments_monthly: round2(sum(loanTx) / months), loan_repayments_pct_of_income: pct(sum(loanTx) / months, inc),
    cash_advances_or_topups: advancesIn.length, cash_advance_total: sum(advancesIn),
    advance_then_repayment_same_week: advancesIn.filter(a => loanTx.some(l => Math.abs(daysBetween(a.date, l.date)) <= 7)).length,
    family_transfers_in: famIn.length, family_transfers_in_total: sum(famIn), emergency_bailouts: bailouts.length, emergency_bailouts_total: sum(bailouts),
    family_bailout_frequency: bailouts.length === 0 ? 'none' : famPerWeek >= 0.8 ? 'weekly' : famPerMonth >= 0.8 ? 'monthly' : 'occasional',
    asset_sale_deposits: by('asset_sale').length,
  };

  // ---- gambling / substance ----
  const gamb = by('gambling');
  const bigWd = txns.filter(t => t.amount <= -200 && (t.category === 'atm' || t.category === 'transfer_out'));
  A.gambling = { any_activity: gamb.length > 0, transaction_count: gamb.length, operators: [...new Set(gamb.map(t => (t.desc.match(P.gambling) || [''])[0].toUpperCase()))], total_spend: sum(gamb), monthly_spend: round2(sum(gamb) / months), pct_of_income: pct(sum(gamb) / months, inc),
    withdraw_redeposit_pattern: bigWd.some(w => credits.some(c => c.category !== 'income' && daysBetween(w.date, c.date) >= 0 && daysBetween(w.date, c.date) <= 2 && c.amount >= 100)) };
  const alc = by('alcohol'), tob = by('tobacco');
  const alcDays = new Set(alc.map(t => t.date)).size;
  A.substance = { alcohol_purchases: alc.length, alcohol_purchases_per_week: round2(alc.length / weeks), alcohol_purchase_days_pct: round2(alcDays / periodDays * 100), daily_alcohol: alcDays / periodDays >= 0.7,
    tobacco_purchases: tob.length, tobacco_high_frequency: tob.length / weeks >= 3, total: sum(alc.concat(tob)), pct_of_income: pct(sum(alc.concat(tob)) / months, inc) };

  // ---- medical / unplanned expense shock ----
  const med = by('medical');
  const medRecent = med.filter(t => t.date >= recentCut);
  A.medical = { transaction_count: med.length, total: sum(med), monthly: round2(sum(med) / months), pct_of_income: pct(sum(med) / months, inc), recent_30d_total: sum(medRecent), providers: [...new Set(med.map(t => normDesc(t.desc)))].slice(0, 6), largest: med.length ? Math.max(...med.map(t => Math.abs(t.amount))) : 0 };

  // ---- financial planning / bills ----
  const bills = by('bills').concat(by('rent'));
  const billGroups = {}; for (const t of bills) (billGroups[normDesc(t.desc)] = billGroups[normDesc(t.desc)] || []).push(t.date);
  let irregular = 0, recurringBills = 0;
  for (const dates of Object.values(billGroups)) { if (dates.length < 2) continue; recurringBills++; const gaps = dates.slice(1).map((d, i) => daysBetween(dates[i], d)); const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length; const cv = Math.sqrt(gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length) / (mean || 1); if (cv > 0.35) irregular++; }
  const debits = txns.filter(t => t.amount < 0);
  const weeklySpend = {}; for (const t of debits) if (!['rent', 'loan_repayment', 'own_transfer_out'].includes(t.category)) weeklySpend[weekKey(t.date)] = (weeklySpend[weekKey(t.date)] || 0) + Math.abs(t.amount);
  const ws = Object.values(weeklySpend); const wmean = ws.reduce((a, b) => a + b, 0) / (ws.length || 1); const wcv = ws.length >= 6 ? Math.sqrt(ws.reduce((a, v) => a + (v - wmean) ** 2, 0) / ws.length) / (wmean || 1) : null;
  A.financial_planning = {
    buffer_200_maintained: hasBal ? A.cash_flow.pct_days_at_or_above_200 >= 50 : null,
    savings_transfers_out: by('own_transfer_out').length, savings_transfers_total: sum(by('own_transfer_out')),
    bank_fee_count: by('bank_fee').length + by('penalty_fee').length, non_penalty_fee_count: by('bank_fee').length,
    recurring_bills: recurringBills, irregular_bills: irregular, bill_payments_regular: recurringBills ? irregular === 0 : null,
    weekly_spend_cv: wcv === null ? null : round2(wcv), chaotic_spending_signal: wcv !== null ? wcv > 0.9 : null,
  };

  // ---- remittances / family strain ----
  const rem = by('remittance');
  const rh = Math.floor(rem.length / 2);
  A.remittances = { count: rem.length, count_90d: rem.filter(t => daysBetween(t.date, end) < 90).length, total: sum(rem), monthly_total: round2(sum(rem) / months), pct_of_income: pct(sum(rem) / months, inc),
    sent_while_under_100: rem.filter(t => t.balance !== null && t.balance < 100).length > 0, sent_while_under_100_count: rem.filter(t => t.balance !== null && t.balance < 100).length,
    sent_while_bnpl_for_basics: null, rising_over_time: rem.length >= 4 ? avg(rem.slice(rh)) > avg(rem.slice(0, rh)) * 1.2 : null, destinations: [...new Set(rem.map(t => (t.desc.match(P.remittance) || [''])[0].toUpperCase()))] };
  const bigOut = by('transfer_out').filter(t => Math.abs(t.amount) >= 200);
  A.family_strain = { emergency_transfers_in_count: bailouts.length, large_transfers_out_count: bigOut.length, large_transfers_out_total: sum(bigOut) };

  // ---- lifestyle ----
  const dining = by('dining'), ent = by('entertainment'), subs = by('subscription'), ride = by('rideshare'), lux = by('luxury'), shop = by('online_shopping'), retail = by('retail');
  const subMerchants = [...new Set(subs.map(t => normDesc(t.desc)))];
  const dayRetail = {}; for (const t of retail.concat(shop, lux)) dayRetail[t.date] = (dayRetail[t.date] || 0) + 1;
  A.lifestyle = {
    dining_monthly: round2(sum(dining) / months), dining_pct: pct(sum(dining) / months, inc),
    entertainment_monthly: round2(sum(ent) / months), entertainment_pct: pct(sum(ent) / months, inc),
    subscriptions_count: subMerchants.length, subscriptions_monthly: round2(sum(subs) / months), subscriptions: subMerchants,
    rideshare_count: ride.length, rideshare_monthly: round2(sum(ride) / months),
    lifestyle_pct: pct((sum(dining) + sum(ent) + sum(subs) + sum(ride)) / months, inc),
    luxury_txns: lux.map(t => ({ date: t.date, desc: t.desc, amount: t.amount })),
    online_shopping_count: shop.length, online_shopping_per_week: round2(shop.length / weeks),
    same_day_multi_retail_days: Object.values(dayRetail).filter(n => n >= 3).length,
    refunds: by('refund').length,
  };

  // ---- essentials while on BNPL (deterministic part; LLM judges the rest) ----
  const bnplDays = new Set(bnpl.map(t => t.date));
  A.bnpl.days_with_bnpl_and_essentials = txns.filter(t => bnplDays.has(t.date) && ['groceries', 'fuel', 'bills'].includes(t.category)).length;
  A.remittances.sent_while_bnpl_for_basics = (rem.length && bnpl.length) ? null : false;   // needs judgement (repayment lines don't show what was bought)

  // ---- category totals + unclassified for the model ----
  const totals = {}; for (const t of txns) { totals[t.category] = totals[t.category] || { count: 0, total: 0 }; totals[t.category].count++; totals[t.category].total = round2(totals[t.category].total + Math.abs(t.amount)); }
  A.category_totals = totals;
  A.unclassified = by('other_debit').concat(by('other_credit'), by('transfer_out')).sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)).slice(0, 15).map(t => ({ date: t.date, desc: t.desc, amount: t.amount }));
  A.flagged_lines = {
    gambling: gamb.map(t => t.line), remittances: rem.map(t => t.line), penalty_fees: by('penalty_fee').map(t => t.line),
    family_transfers_in: bailouts.concat(famIn.filter(t => !bailouts.includes(t))).map(t => t.line), credit_advances_in: advancesIn.map(t => t.line), payday_lenders: by('payday_lender').map(t => t.line),
    luxury: lux.map(t => t.line), asset_sales: by('asset_sale').map(t => t.line), alcohol_tobacco: alc.concat(tob).slice(0, 10).map(t => t.line), medical: med.slice(0, 8).map(t => t.line),
    bnpl_sample: bnpl.slice(0, 6).map(t => t.line), low_balance_atm: hasBal ? txns.filter(t => t.category === 'atm' && t.balance !== null && t.balance < 50).map(t => t.line) : [],
  };
  return A;
}

// ---------------------------------------------------------------------------------------------
// Payslips: extract net/gross pay, period, frequency and employer from pdftotext output, then reconcile
// against the statement's observed income and the declared income. Deterministic; the model never sees raw payslips.
const PS = {
  keyword:   /\b(payslip|pay\s*slip|pay\s*advice|payroll|earnings|paye|kiwisaver|gross\s*(pay|earnings)|net\s*(pay|earnings)|take[- ]home|pay\s*period|period\s*end(ing)?|pay\s*date|ird\s*number|tax\s*code)\b/i,
  ytd:       /\b(ytd|year\s*to\s*date|y\.t\.d)\b/i,
  gross:     /\b(total\s*gross|gross\s*(pay|earnings|total|income|wages|salary)?)\b/i,
  net:       /\b(net\s*(pay|earnings|amount|income|wages|salary)?|take[- ]home(\s*pay)?|total\s*net|amount\s*paid|paid\s*to\s*(bank|account)|bank\s*(deposit|credit|transfer)|direct\s*credit|payment\s*to\s*account)\b/i,
  freq:      /\b(weekly|fortnightly|bi-?weekly|four-?weekly|monthly|semi-?monthly)\b/i,
  employer:  /\b(employer|company|business|trading\s*as|paid\s*by)\s*(name)?\s*[:\-]\s*(.{3,60})/i,
  payDate:   /\b(pay(ment)?\s*date|paid\s*on|date\s*paid)\s*[:\-]?\s*(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2}\s+[A-Za-z]{3,9}\.?\s+\d{2,4})/i,
  period:    /\b(pay\s*)?period\s*[:\-]?\s*(from\s*)?(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2}\s+[A-Za-z]{3,9}\.?\s+\d{2,4})\s*(-|–|to)\s*(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2}\s+[A-Za-z]{3,9}\.?\s+\d{2,4})/i,
  periodEnd: /\b(period\s*end(ing)?|week\s*end(ing)?|pay\s*end(ing)?)\s*[:\-]?\s*(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2}\s+[A-Za-z]{3,9}\.?\s+\d{2,4})/i,
  hours:     /\b(ordinary|total|standard)?\s*hours\s*(worked)?\b[^\d\n]{0,20}(\d{1,3}(?:\.\d{1,2})?)\b/i,
  money:     /\$?\s*(\d{1,3}(?:,\d{3})*\.\d{2}|\d+\.\d{2})/g,
};
function looksLikePayslip(text) {
  const t = String(text || ''); const kw = (t.match(new RegExp(PS.keyword.source, 'gi')) || []).length;
  return kw >= 3 && (PS.net.test(t) || PS.gross.test(t));
}
function parsePayslip(text) {
  const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const out = { employer: null, pay_date: null, period_start: null, period_end: null, frequency: null, gross: null, net: null, hours: null, notes: [] };
  const lastMoney = l => { const ms = [...l.matchAll(PS.money)].map(m => parseFloat(m[1].replace(/,/g, ''))).filter(v => isFinite(v)); return ms.length ? ms[ms.length - 1] : null; };
  const firstMoney = l => { const ms = [...l.matchAll(PS.money)].map(m => parseFloat(m[1].replace(/,/g, ''))).filter(v => isFinite(v)); return ms.length ? ms[0] : null; };
  let hintYear = null; for (const l of lines) { const y = l.match(/\b(20\d{2})\b/); if (y) { hintYear = +y[1]; break; } }
  const d = s => { const v = parseDate(s, hintYear); return v ? iso(v) : null; };
  for (const l of lines) {
    let m;
    if (out.pay_date === null && (m = l.match(PS.payDate))) out.pay_date = d(m[3]);
    if (out.period_start === null && (m = l.match(PS.period))) { out.period_start = d(m[3]); out.period_end = d(m[5]); }
    if (out.period_end === null && (m = l.match(PS.periodEnd))) out.period_end = d(m[4]);
    if (out.frequency === null && (m = l.match(PS.freq))) out.frequency = m[1].toLowerCase().replace(/-/g, '').replace('biweekly', 'fortnightly').replace('fourweekly', 'fourweekly');
    if (out.employer === null && (m = l.match(PS.employer))) out.employer = m[3].replace(/\s{2,}.*$/, '').trim();
    if (out.hours === null && (m = l.match(PS.hours)) && !PS.ytd.test(l)) out.hours = parseFloat(m[3]);
    if (PS.ytd.test(l)) continue;
    if (PS.gross.test(l) && !/\bnet\b/i.test(l)) { const v = /this\s*pay|current/i.test(l) ? firstMoney(l) : lastMoney(l); if (v !== null && v > 0 && (out.gross === null || v > out.gross)) out.gross = v; }
    if (PS.net.test(l)) { const v = /this\s*pay|current/i.test(l) ? firstMoney(l) : lastMoney(l); if (v !== null && v > 0 && (out.net === null || v > out.net)) out.net = v; }
  }
  if (out.employer === null) { for (const l of lines.slice(0, 6)) { const seg = l.split(/\s{2,}/)[0].trim(); if (/\b(ltd|limited|group|holdings|trust|co\.|inc\b|nz\b|new zealand)\b/i.test(seg) && !PS.keyword.test(seg)) { out.employer = seg; break; } } }
  if (out.frequency === null && out.period_start && out.period_end) { const n = daysBetween(out.period_start, out.period_end) + 1; out.frequency = n <= 8 ? 'weekly' : n <= 16 ? 'fortnightly' : n <= 31 ? 'monthly' : null; if (out.frequency) out.notes.push('frequency inferred from period length'); }
  if (out.net !== null && out.gross !== null && out.net > out.gross) { out.notes.push('net exceeded gross; values swapped'); const t = out.net; out.net = out.gross; out.gross = t; }
  if (out.net === null && out.gross === null) out.notes.push('no pay amounts recognised');
  return out;
}
const PER_YEAR = { weekly: 52, fortnightly: 26, fourweekly: 13, monthly: 12, semimonthly: 24 };
function summarisePayslips(slips, A, app) {
  const ok = (slips || []).filter(p => p && p.net !== null);
  const S = { count: (slips || []).length, usable: ok.length, employer: null, frequency: null, net_per_pay_median: null, net_monthly: null, gross_monthly: null, latest_pay_date: null, matched_in_statement: 0, unmatched_pay_dates: [], vs_statement_pct: null, vs_declared_pct: null, notes: [] };
  if (!ok.length) { if (S.count) S.notes.push('payslip amounts could not be read'); return S; }
  const median = arr => { const v = arr.slice().sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; };
  const freqs = ok.map(p => p.frequency).filter(Boolean); const cadence = A && A.income ? A.income.cadence : null;
  S.frequency = freqs.length ? freqs.sort((a, b) => freqs.filter(x => x === b).length - freqs.filter(x => x === a).length)[0] : (PER_YEAR[cadence] ? cadence : null);
  if (!freqs.length && S.frequency) S.notes.push('pay frequency taken from statement cadence');
  const py = PER_YEAR[S.frequency] || null;
  S.employer = [...new Set(ok.map(p => p.employer).filter(Boolean))].join(' / ') || null;
  S.net_per_pay_median = median(ok.map(p => p.net));
  const gross = ok.filter(p => p.gross !== null).map(p => p.gross);
  if (py) { S.net_monthly = round2(S.net_per_pay_median * py / 12); if (gross.length) S.gross_monthly = round2(median(gross) * py / 12); } else S.notes.push('pay frequency unknown; monthly figure not computed');
  S.latest_pay_date = ok.map(p => p.pay_date || p.period_end).filter(Boolean).sort().pop() || null;
  if (A && A.income && Array.isArray(A.income.pay_dates)) {
    const incomeTx = (A.income_credits || []);
    for (const p of ok) { const ref = p.pay_date || p.period_end; if (!ref) continue; const hit = incomeTx.some(t => Math.abs(daysBetween(ref, t.date)) <= 4 && Math.abs(t.amount - p.net) <= Math.max(5, p.net * 0.02)); if (hit) S.matched_in_statement++; else S.unmatched_pay_dates.push(ref); }
  }
  const obs = A && A.income ? A.income.observed_net_monthly : null;
  if (S.net_monthly !== null && obs) S.vs_statement_pct = round2(Math.abs(S.net_monthly - obs) / obs * 100);
  const decl = app && app.income !== null && app.income !== undefined && app.income !== '' ? Number(app.income) : null;
  if (S.net_monthly !== null && decl) S.vs_declared_pct = round2(Math.abs(S.net_monthly - decl) / decl * 100);
  return S;
}

// ---------------------------------------------------------------------------------------------
function buildLlmBrief(A, app, extraDocsText, findings) {
  const f = v => v === null || v === undefined ? 'n/a' : (typeof v === 'number' ? (Number.isInteger(v) ? v : v.toFixed(1)) : v);
  const $ = v => v === null || v === undefined ? 'n/a' : '$' + Number(v).toLocaleString('en-NZ');
  const L = [];
  L.push(`APPLICATION: ${app.applicant_name || 'applicant'} | requested ${$(app.loan_amount)} at ${f(app.interest_rate)}% p.a. | declared income ${$(app.income)}/mo, expenses ${$(app.expenses)}/mo, existing debt ${$(app.existing_debt)}`);
  if (!A.period) { L.push('STATEMENT DATA: none parsed.'); if (extraDocsText) L.push('\nOTHER DOCUMENTS (credit history / prior loans):\n' + extraDocsText); return L.join('\n'); }
  L.push(`STATEMENT: ${A.period.start} to ${A.period.end} (${A.period.days} days), ${A.parser.transaction_count} transactions parsed`);
  L.push(`INCOME OBSERVED: ${$(A.income.observed_net_monthly)}/mo (${A.income.cadence}, ${A.income.credits_count} credits) [${A.income.sources.join(', ') || 'none identified'}] vs declared ${$(app.income)}${A.income.income_drop_pct !== null && A.income.income_drop_pct > 10 ? ` | INCOME FELL ${f(A.income.income_drop_pct)}% in the last 30 days` : ''}${A.income.acc_or_claim_credits ? ` | ACC/claim credits: ${A.income.acc_or_claim_credits} (${$(A.income.acc_or_claim_total)})` : ''}`);
  if (app.loan_purpose) L.push(`STATED LOAN PURPOSE: ${app.loan_purpose}`);
  const ps = A.payslips;
  if (ps && ps.count) L.push(ps.usable ? `PAYSLIPS: ${ps.usable} of ${ps.count} readable${ps.employer ? ` [${ps.employer}]` : ''}, net ${$(ps.net_per_pay_median)} per ${ps.frequency || 'pay (frequency unknown)'} = ${$(ps.net_monthly)}/mo${ps.gross_monthly ? ` (gross ${$(ps.gross_monthly)}/mo)` : ''}; ${ps.matched_in_statement} pay credits matched in statement${ps.unmatched_pay_dates.length ? `, unmatched: ${ps.unmatched_pay_dates.join(', ')}` : ''}; vs statement income ${ps.vs_statement_pct === null ? 'n/a' : f(ps.vs_statement_pct) + '% diff'}; vs declared ${ps.vs_declared_pct === null ? 'n/a' : f(ps.vs_declared_pct) + '% diff'}` : `PAYSLIPS: ${ps.count} provided but amounts could not be read`);
  if (A.medical && A.medical.transaction_count) L.push(`MEDICAL SPEND: ${A.medical.transaction_count} txns, ${$(A.medical.monthly)}/mo = ${f(A.medical.pct_of_income)}% of income, largest ${$(A.medical.largest)}, last 30 days ${$(A.medical.recent_30d_total)} [${A.medical.providers.join(', ')}]`);
  const cf = A.cash_flow || {};
  L.push(`BALANCE: min ${$(cf.min_balance)}, avg ${$(cf.avg_balance)} | days/month under $100: ${f(cf.days_under_100_per_month)}, under $50: ${f(cf.days_under_50_per_month)}, under $20: ${f(cf.days_under_20_per_month)} | overdrawn events/month: ${f(cf.zero_balance_events_per_month)} | overdraft/dishonour fees: ${f(cf.overdraft_or_dishonour_fees)} | days at/above $200: ${f(cf.pct_days_at_or_above_200)}%`);
  L.push(`BNPL (buy-now-pay-later repayments): ${A.bnpl.transaction_count} txns [${A.bnpl.providers.join(', ') || 'none'}], ${$(A.bnpl.monthly_spend)}/mo = ${f(A.bnpl.pct_of_income)}% of income, max ${A.bnpl.max_per_week}/week`);
  L.push(`CREDIT FACILITIES: ${A.credit_dependency.active_credit_facilities} [${A.credit_dependency.facilities.join(', ')}], repayments ${$(A.credit_dependency.loan_repayments_monthly)}/mo (${f(A.credit_dependency.loan_repayments_pct_of_income)}% of income), loan advances received: ${A.credit_dependency.cash_advances_or_topups}, payday lenders: ${A.credit_dependency.payday_lenders.join(', ') || 'none'}`);
  L.push(`TRANSFERS IN from family/others: ${A.credit_dependency.family_transfers_in} (${$(A.credit_dependency.family_transfers_in_total)}), of which emergency (arrived while balance < $100): ${A.credit_dependency.emergency_bailouts} = ${A.credit_dependency.family_bailout_frequency}; large transfers out: ${A.family_strain.large_transfers_out_count} (${$(A.family_strain.large_transfers_out_total)})`);
  L.push(`GAMBLING: ${A.gambling.any_activity ? `${A.gambling.transaction_count} txns, ${$(A.gambling.total_spend)} [${A.gambling.operators.join(', ')}]` : 'none detected'}`);
  L.push(`ALCOHOL/TOBACCO: ${A.substance.alcohol_purchases} alcohol (${f(A.substance.alcohol_purchases_per_week)}/wk), ${A.substance.tobacco_purchases} tobacco/vape, ${f(A.substance.pct_of_income)}% of income`);
  L.push(`REMITTANCES SENT OVERSEAS (money out): ${A.remittances.count} txns, ${$(A.remittances.monthly_total)}/mo = ${f(A.remittances.pct_of_income)}% of income [${A.remittances.destinations.join(', ')}], sent while balance <$100: ${A.remittances.sent_while_under_100_count}, rising: ${f(A.remittances.rising_over_time)}`);
  L.push(`LIFESTYLE: dining ${$(A.lifestyle.dining_monthly)}/mo (${f(A.lifestyle.dining_pct)}%), entertainment ${$(A.lifestyle.entertainment_monthly)}/mo (${f(A.lifestyle.entertainment_pct)}%), ${A.lifestyle.subscriptions_count} subscriptions, rideshare ${A.lifestyle.rideshare_count}, online shopping ${A.lifestyle.online_shopping_count}, luxury ${A.lifestyle.luxury_txns.length}`);
  L.push(`PLANNING: savings transfers ${A.financial_planning.savings_transfers_out} (${$(A.financial_planning.savings_transfers_total)}), fees ${A.financial_planning.bank_fee_count}, recurring bills ${A.financial_planning.recurring_bills} (irregular ${A.financial_planning.irregular_bills}), weekly-spend variability ${f(A.financial_planning.weekly_spend_cv)}`);
  if (findings) {
    const hits = findings.rule_hits || {};
    const list = k => (hits[k] || []).map(h => h.rule + (h.value !== true && h.value !== undefined ? ` (${Array.isArray(h.value) ? h.value.join(', ') : h.value})` : '')).join('; ');
    L.push('');
    L.push(`RULES ENGINE FINDINGS (policy already applied to the metrics above - explain these, never soften or contradict them):`);
    L.push(`  Expense risk tier: ${findings.expense_risk_tier}. Provisional outcome: risk ${findings.risk_rating}, ${findings.recommendation}${findings.escalation && findings.escalation !== 'none' ? ` (${findings.escalation.replace(/_/g, ' ')})` : ''}.`);
    if ((hits.immediate_decline || []).length) L.push(`  Immediate-decline triggers: ${list('immediate_decline')}`);
    if ((hits.critical || []).length) L.push(`  Critical: ${list('critical')}`);
    if ((hits.high || []).length) L.push(`  High: ${list('high')}`);
    if ((hits.moderate || []).length) L.push(`  Moderate: ${list('moderate')}`);
    if (!Object.values(hits).some(a => a && a.length)) L.push('  No red-flag thresholds triggered.');
    const af = findings.affordability || {};
    L.push(`  Affordability: declared surplus ${$(af.declared_surplus)}/mo; observed income ${$(af.observed_income)}${af.income_mismatch_pct !== null && af.income_mismatch_pct !== undefined ? ` (${af.income_mismatch_pct}% from declared)` : ''}.`);
  }
  const F = A.flagged_lines;
  const block = (title, arr, max) => { if (arr && arr.length) L.push(`\n${title}:\n` + arr.slice(0, max || 8).map(l => '  ' + l.replace(/\s{2,}/g, ' ')).join('\n') + (arr.length > (max || 8) ? `\n  ... +${arr.length - (max || 8)} more` : '')); };
  block('GAMBLING LINES', F.gambling, 3); block('REMITTANCE LINES (money sent out)', F.remittances, 3); block('FEE LINES', F.penalty_fees, 2);
  block('TRANSFERS IN (family/other)', F.family_transfers_in, 3); block('LOAN ADVANCES RECEIVED', F.credit_advances_in, 3); block('PAYDAY LENDER LINES', F.payday_lenders, 3);
  block('LUXURY LINES', F.luxury, 3); block('ASSET-SALE LINES', F.asset_sales, 2); block('ATM WHILE UNDER $50', F.low_balance_atm, 2); block('MEDICAL LINES', F.medical, 3);
  if (A.unclassified.length) L.push('\nUNCLASSIFIED (largest, for your judgement only):\n' + A.unclassified.slice(0, 5).map(t => `  ${t.date} ${t.desc} ${t.amount}`).join('\n'));
  if (extraDocsText) L.push('\nOTHER DOCUMENTS (credit history / prior loans):\n' + extraDocsText);
  return L.join('\n');
}

// ---------------------------------------------------------------------------------------------
// Merge deterministic metrics (authoritative) with the model's judgement calls.
// Every model boolean that can trigger a rule is GATED on deterministic corroboration; uncorroborated -> null.
const BEHAVIOUR_KEYS = ['paid_previous_loan_early', 'paid_on_time_consistently', 'communicates_proactively', 'missed_payments_before', 'existing_defaults', 'write_off_history', 'requests_bigger_loan_too_fast', 'provides_multiple_excuses', 'avoids_communication'];
function mergeObservations(A, J, opts) {
  J = J || {}; opts = opts || {};
  const jd = (J.judgements && typeof J.judgements === 'object') ? J.judgements : {};
  const legacy = (obj, k) => (obj && typeof obj === 'object' && typeof obj[k] === 'boolean') ? obj[k] : null;
  const jget = (flat, legacyObj, legacyKey) => typeof jd[flat] === 'boolean' ? jd[flat] : legacy(legacyObj, legacyKey);
  const gate = (val, ok) => (val === true && !ok) ? null : val;          // a "true" without corroboration is discarded
  const has = !!A.period; const cf = A.cash_flow || {};
  const bn = A.bnpl || {}, cd = A.credit_dependency || {}, re = A.remittances || {}, li = A.lifestyle || {}, fp = A.financial_planning || {}, fs = A.family_strain || {};
  const usedForEssentials = gate(jget('bnpl_used_for_essentials', J.bnpl, 'used_for_essentials'), has && bn.transaction_count >= 1);
  // behaviour scorecard: only from other documents (credit history), and each tick must be corroborated by words in that text
  const BEHAVIOUR_EVIDENCE = {
    paid_previous_loan_early: /\b(early|ahead of schedule|before (the )?(due|final|end))\b/i,
    paid_on_time_consistently: /\b(on[- ]time|no (missed|late)|all .{0,40}(paid|instalments?|payments?)|never (missed|late)|good (payment|repayment) history)\b/i,
    communicates_proactively: /\b(emailed|e-mailed|called|phoned|contacted|advised|notified|informed|proactive|ahead of|in advance|let us know)\b/i,
    missed_payments_before: /\b(missed|late payment|arrears|overdue|dishonou?r|failed payment|bounced)\b/i,
    existing_defaults: /\bdefault(s|ed)?\b/i,
    write_off_history: /\b(writ(e|ten)[- ]?off|charged[- ]off|bad debt)\b/i,
    requests_bigger_loan_too_fast: /\b(top[- ]?up|increase|larger|bigger|higher amount|additional (loan|credit))\b/i,
    provides_multiple_excuses: /\b(excuse|reasons? for (missing|late)|promised to pay|promise to pay)\b/i,
    avoids_communication: /\b(no response|unresponsive|not respond|avoid|uncontactable|not contactable|ignored|no contact|unreachable)\b/i,
  };
  let behaviour = {}; const rejectedTicks = [];
  // Authoritative source first: TerePay's own loan history, if the application row carries behaviour_* columns
  const dbbRaw = opts.dbBehaviour && typeof opts.dbBehaviour === 'object' ? opts.dbBehaviour : null;
  const dbb = dbbRaw && BEHAVIOUR_KEYS.some(k => typeof dbbRaw[k] === 'boolean' || typeof dbbRaw['behaviour_' + k] === 'boolean') ? dbbRaw : null;
  if (dbb) for (const k of BEHAVIOUR_KEYS) if (dbb[k] === true || dbb['behaviour_' + k] === true) behaviour[k] = true;
  if (!dbb && opts.hasOtherDocs) {
    const txt = String(opts.otherDocsText || '');
    let ticks = [];
    if (Array.isArray(J.behaviour)) ticks = J.behaviour;
    else if (J.behaviour_scorecard && typeof J.behaviour_scorecard === 'object') ticks = BEHAVIOUR_KEYS.filter(k => J.behaviour_scorecard[k] === true);
    for (const k of ticks) { if (!BEHAVIOUR_KEYS.includes(k)) continue; if (!txt || BEHAVIOUR_EVIDENCE[k].test(txt)) behaviour[k] = true; else rejectedTicks.push(k); }
  }
  // BNPL-for-essentials cannot be read from repayment lines; the critical pairing with remittances needs deterministic cash-stress evidence
  const cashStress = has && bn.monthly_spend >= 200 && ((cf.days_under_50_per_month || 0) > 5 || (cf.overdraft_or_dishonour_fees || 0) >= 2);
  return {
    shock: has ? { income_drop_pct: A.income.income_drop_pct, acc_or_claim_credits: A.income.acc_or_claim_credits, medical_monthly: A.medical ? A.medical.monthly : null, medical_pct_of_income: A.medical ? A.medical.pct_of_income : null, medical_recent_30d: A.medical ? A.medical.recent_30d_total : null, medical_largest: A.medical ? A.medical.largest : 0, medical_explained: (typeof jd.medical_expense_explained === 'boolean') ? jd.medical_expense_explained : null } : {},
    statement_summary: { period_start: has ? A.period.start : null, period_end: has ? A.period.end : null, period_days: has ? A.period.days : null,
      observed_net_monthly_income: has ? A.income.observed_net_monthly : null, income_sources: has ? A.income.sources : [], income_matches_declared: jget('income_matches_declared', J, 'income_matches_declared'),
      payslip_count: A.payslips ? A.payslips.count : 0, payslip_usable: A.payslips ? A.payslips.usable : 0, payslip_net_monthly: A.payslips ? A.payslips.net_monthly : null, payslip_vs_statement_pct: A.payslips ? A.payslips.vs_statement_pct : null, payslip_vs_declared_pct: A.payslips ? A.payslips.vs_declared_pct : null, payslip_matched: A.payslips ? A.payslips.matched_in_statement : 0, payslip_employer: A.payslips ? A.payslips.employer : null, notes: has ? `${A.parser.transaction_count} transactions parsed deterministically` : 'no statement parsed' },
    bnpl: has ? { providers: bn.providers, transaction_count_60d: bn.transaction_count_60d, monthly_spend: bn.monthly_spend, pct_of_income: bn.pct_of_income, max_per_week: bn.max_per_week, used_for_essentials: usedForEssentials, cycling: gate(jget('bnpl_cycling', J.bnpl, 'cycling'), bn.providers && bn.providers.length >= 2), amounts_shrinking: bn.amounts_shrinking } : {},
    cash_flow: has ? { lowest_balance_by_month: cf.lowest_balance_by_month || [], days_under_100_per_month: cf.days_under_100_per_month ?? null, days_under_50_per_month: cf.days_under_50_per_month ?? null, days_under_20_per_month: cf.days_under_20_per_month ?? null, zero_balance_events_per_month: cf.zero_balance_events_per_month ?? null, overdraft_or_dishonour_fees: cf.overdraft_or_dishonour_fees ?? null, near_zero_within_3_days_of_pay: cf.near_zero_within_3_days_of_pay ?? null, atm_withdrawals_when_under_50: cf.atm_withdrawals_when_under_50 ?? null, micro_spending_when_low: cf.micro_spending_when_low ?? null } : {},
    credit_dependency: has ? { active_credit_facilities: cd.active_credit_facilities, facilities: cd.facilities, credit_paying_credit: gate(jget('credit_paying_credit', J.credit_dependency, 'credit_paying_credit'), cd.cash_advances_or_topups >= 1) ?? (cd.advance_then_repayment_same_week >= 2 ? true : null), payday_lenders: cd.payday_lenders, cash_advances_or_topups: cd.cash_advances_or_topups, family_bailout_frequency: cd.family_bailout_frequency, asset_sale_deposits: cd.asset_sale_deposits > 0 } : {},
    gambling: has ? { any_activity: A.gambling.any_activity, operators: A.gambling.operators, total_spend: A.gambling.total_spend, withdraw_redeposit_pattern: A.gambling.withdraw_redeposit_pattern } : {},
    substance: has ? { daily_alcohol: A.substance.daily_alcohol, alcohol_purchases_per_week: A.substance.alcohol_purchases_per_week, pct_of_income: A.substance.pct_of_income, tobacco_high_frequency: A.substance.tobacco_high_frequency } : {},
    impulse: has ? { same_day_multi_retail: li.same_day_multi_retail_days >= 2, daily_online_shopping: li.online_shopping_per_week >= 5, buy_return_cycles: li.refunds >= 3, luxury_on_low_income: gate(jget('luxury_on_low_income', J.lifestyle, 'luxury_on_low_income'), li.luxury_txns && li.luxury_txns.length >= 1) } : {},
    financial_planning: has ? { buffer_200_maintained: fp.buffer_200_maintained, bank_fee_count: (fp.non_penalty_fee_count >= 3 || fp.bank_fee_count >= 5) ? fp.bank_fee_count : 0, bill_payments_regular: fp.bill_payments_regular, chaotic_spending: gate(jget('chaotic_spending', J.financial_planning, 'chaotic_spending'), fp.weekly_spend_cv !== null && fp.weekly_spend_cv > 0.7) ?? fp.chaotic_spending_signal } : {},
    family_strain: has ? { emergency_transfers_in_count: fs.emergency_transfers_in_count, large_transfers_out_count: fs.large_transfers_out_count, undisclosed_dependents_suspected: gate(jget('undisclosed_dependents_suspected', J.family_strain, 'undisclosed_dependents_suspected'), (fs.large_transfers_out_count >= 1) || (re.count >= 1)), paying_others_debts: jget('paying_others_debts', J.family_strain, 'paying_others_debts') } : {},
    remittances: has ? { count_90d: re.count_90d, monthly_total: re.monthly_total, pct_of_income: re.pct_of_income, sent_while_under_100: re.sent_while_under_100, sent_while_bnpl_for_basics: gate(jget('remittances_sent_while_bnpl_for_basics', J.remittances, 'sent_while_bnpl_for_basics'), cashStress && re.pct_of_income !== null && re.pct_of_income >= 10 && usedForEssentials === true), crisis_driven: gate(jget('remittances_crisis_driven', J.remittances, 'crisis_driven'), re.count >= 1), undisclosed_obligation: gate(jget('remittances_undisclosed_obligation', J.remittances, 'undisclosed_obligation'), re.pct_of_income !== null && re.pct_of_income >= 10), rising_over_time: re.rising_over_time } : {},
    lifestyle: has ? { dining_pct: li.dining_pct, entertainment_pct: li.entertainment_pct, subscriptions_count: li.subscriptions_count, transport_beyond_need: jget('transport_beyond_need', J.lifestyle, 'transport_beyond_need'), luxury_while_bnpl_basics: gate(jget('luxury_while_bnpl_basics', J.lifestyle, 'luxury_while_bnpl_basics'), li.luxury_txns && li.luxury_txns.length >= 1 && bn.transaction_count >= 1 && usedForEssentials === true) } : {},
    behaviour_scorecard: behaviour,
    factors: Array.isArray(J.factors) ? J.factors : [],
    reasoning: cleanNote(J.analyst_note || J.reasoning || ''),
    evidence: deterministicEvidence(A).concat((Array.isArray(J.evidence) ? J.evidence : []).map(String)).filter((v, i, arr) => arr.indexOf(v) === i).slice(0, 14),
    preliminary_risk_view: J.preliminary_risk_view || null,
    confidence: (typeof J.confidence === 'number' ? J.confidence : (Number(String(J.confidence || '').replace(/[^\d.]/g, '')) || confidenceFromNote(J.analyst_note || J.reasoning) || null)),
    data_gaps: Array.isArray(J.data_gaps) ? J.data_gaps : [],
    rejected_behaviour_ticks: rejectedTicks,
  };
}

// Small models sometimes append 'Confidence: 90, Data Gaps: None' to the note, or loop; keep the note clean and bounded
function cleanNote(t) {
  let s = String(t || '').replace(/\s+/g, ' ').trim();
  s = s.replace(/\s*(confidence(\s*level)?\s*[:=]\s*\d+%?\.?)(\s*,?\s*data\s*gaps?\s*[:=]?\s*[^.]*\.?)?\s*$/i, '').trim();
  const sentences = s.match(/[^.!?]+[.!?]+(\s|$)/g) || [s];
  const seen = new Set(); const out = [];
  for (const raw of sentences) { const k = raw.trim().toLowerCase(); if (!k || seen.has(k)) continue; seen.add(k); out.push(raw.trim()); if (out.join(' ').split(/\s+/).length > 110) break; }
  return out.join(' ');
}
function confidenceFromNote(t) { const m = String(t || '').match(/confidence(?:\s*level)?\s*[:=]\s*(\d{1,3})/i); return m ? Number(m[1]) : null; }

// Verbatim statement lines that back the triggered flags — the audit evidence, produced by code not the model
function deterministicEvidence(A) {
  const F = (A && A.flagged_lines) || {}; const out = [];
  const take = (arr, n, tag) => { for (const l of (arr || []).slice(0, n)) out.push(`[${tag}] ` + String(l).replace(/\s{2,}/g, ' ')); };
  take(F.medical, 2, 'medical'); take(F.gambling, 4, 'gambling'); take(F.remittances, 3, 'remittance'); take(F.penalty_fees, 3, 'fee'); take(F.payday_lenders, 2, 'payday lender');
  take(F.credit_advances_in, 2, 'loan advance'); take(F.family_transfers_in, 2, 'transfer in'); take(F.low_balance_atm, 2, 'atm while low'); take(F.luxury, 2, 'luxury'); take(F.asset_sales, 1, 'asset sale'); take(F.bnpl_sample, 2, 'bnpl');
  return out;
}

// ---------------------------------------------------------------------------------------------
// Parse model output that may be fenced, prefixed, or truncated by the token limit.
function repairJson(raw) {
  let s = String(raw || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = s.indexOf('{'); if (start > 0) s = s.slice(start);
  try { return { value: JSON.parse(s), repaired: false }; } catch (e) {}
  const closeAll = str => {
    const stack = []; let inStr = false, esc = false;
    for (const ch of str) { if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; } else if (ch === '"') inStr = true; else if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']'); else if (ch === '}' || ch === ']') stack.pop(); }
    let out = str; if (inStr) out += '"'; while (stack.length) out += stack.pop(); return out;
  };
  for (let i = 0; i < 60; i++) {
    const cand = s.replace(/,\s*$/, '').replace(/:\s*$/, ': null').replace(/,\s*"[^"]*$/, '');
    try { return { value: JSON.parse(closeAll(cand)), repaired: true }; } catch (e) {}
    const cut = Math.max(s.lastIndexOf(','), s.lastIndexOf('}'), s.lastIndexOf(']'));
    if (cut <= 0) break; s = s.slice(0, cut);
  }
  throw new Error('Unrepairable JSON from model: ' + String(raw).slice(0, 200));
}

if (typeof module !== 'undefined') module.exports = { parseTransactions, analyseTransactions, buildLlmBrief, mergeObservations, repairJson, cleanNote, classify, PATTERNS: P, BEHAVIOUR_KEYS, looksLikePayslip, parsePayslip, summarisePayslips };
