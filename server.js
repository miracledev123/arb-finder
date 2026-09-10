const express  = require('express');
const cors     = require('cors');
const fetch    = require('node-fetch');
const { Pool } = require('pg');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── DB ────────────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({ origin: '*', methods: ['GET','POST','DELETE'], allowedHeaders: ['Content-Type','Authorization'] }));
app.use(express.json());

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// ── Helpers ───────────────────────────────────────────────────────────────────
function stableHash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}

function stringSimilarity(a, b) {
  if (!a || !b) return 0;
  a = a.toLowerCase().replace(/[^a-z0-9 ]/g,'').trim();
  b = b.toLowerCase().replace(/[^a-z0-9 ]/g,'').trim();
  if (a === b) return 1;
  const bg = s => { const t = new Set(); for (let i=0;i<s.length-1;i++) t.add(s.slice(i,i+2)); return t; };
  const aB = bg(a), bB = bg(b);
  let inter = 0;
  for (const x of aB) if (bB.has(x)) inter++;
  return (2*inter)/(aB.size+bB.size);
}

// ── Fetch SportyBet ───────────────────────────────────────────────────────────
const SPORTY_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Origin': 'https://www.sportybet.com',
  'Referer': 'https://www.sportybet.com/ng/',
};

const NAIRA_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Origin': 'https://www.nairabet.com',
  'Referer': 'https://www.nairabet.com/',
};

const SPORTY_SPORTS = [
  { id: 'sr:sport:1',  name: 'Football'     },
  { id: 'sr:sport:2',  name: 'Basketball'   },
  { id: 'sr:sport:5',  name: 'Tennis'       },
  { id: 'sr:sport:22', name: 'Cricket'      },
  { id: 'sr:sport:20', name: 'Table Tennis' },
  { id: 'sr:sport:4',  name: 'Ice Hockey'   },
  { id: 'sr:sport:6',  name: 'Handball'     },
];

async function fetchSportyBet() {
  const all = [];
  for (const sport of SPORTY_SPORTS) {
    try {
      const url = `https://www.sportybet.com/api/ng/factsCenter/homePageSport?sportId=${sport.id}&_t=${Date.now()}`;
      const res = await fetch(url, { headers: SPORTY_HEADERS, timeout: 12000 });
      if (!res.ok) continue;
      const data = await res.json();
      const tournaments = data?.data?.tournamentEvents || data?.data || [];
      for (const t of (Array.isArray(tournaments) ? tournaments : [])) {
        for (const ev of (t.events || [])) {
          all.push({ ...ev, _sport: sport.name });
        }
      }
    } catch(e) { console.error('SportyBet fetch error:', sport.name, e.message); }
  }
  return all;
}

async function fetchNairabet() {
  const all = [];
  // Try multiple known endpoint patterns for Nairabet
  const endpoints = [
    'https://www.nairabet.com/api/v1/events?status=prematch&limit=500',
    'https://www.nairabet.com/api/events?type=prematch&limit=500',
    'https://ms.nairabet.com/v2/en/sports/prematch/events?limit=500',
  ];
  for (const url of endpoints) {
    try {
      const res = await fetch(url, { headers: NAIRA_HEADERS, timeout: 12000 });
      if (!res.ok) continue;
      const data = await res.json();
      const evs = data?.data || data?.events || data?.result || (Array.isArray(data) ? data : []);
      if (Array.isArray(evs) && evs.length > 0) { all.push(...evs); break; }
    } catch(e) { console.error('Nairabet fetch error:', url, e.message); }
  }
  return all;
}

// ── Normalize ─────────────────────────────────────────────────────────────────
function normalizeSportybet(ev) {
  const home = ev.homeTeamName || ev.home || ev.team1 || '';
  const away = ev.awayTeamName || ev.away || ev.team2 || '';
  const name  = `${home} vs ${away}`.trim();
  const kickoff = Number(ev.estimateStartTime || ev.startTime || 0);
  const markets = {};
  for (const mkt of (ev.markets || [])) {
    const mktName = mkt.name || mkt.desc || 'Unknown';
    const outcomes = {};
    for (const out of (mkt.outcomes || mkt.result || [])) {
      const oName = out.desc || out.name || '';
      const odds  = parseFloat(out.odds || out.price || 0);
      if (oName && odds > 1.01) outcomes[oName] = odds;
    }
    if (Object.keys(outcomes).length) markets[mktName] = outcomes;
  }
  return { source:'sportybet', eventName: name.toLowerCase(), displayName: name, kickoff, sport: ev._sport||'Football', markets };
}

function normalizeNairabet(ev) {
  const home = ev.homeTeam || ev.home_team || ev.team1 || ev.home || '';
  const away = ev.awayTeam || ev.away_team || ev.team2 || ev.away || '';
  const name  = `${home} vs ${away}`.trim();
  const kickoff = Number(ev.startTime || ev.start_time || ev.eventDate || ev.kickoff || 0);
  const markets = {};
  const rawMkts = ev.markets || ev.odds || ev.betTypes || ev.bet_types || [];
  for (const mkt of rawMkts) {
    const mktName = mkt.name || mkt.betTypeName || mkt.market_name || mkt.type || 'Unknown';
    const outcomes = {};
    for (const out of (mkt.outcomes || mkt.selections || mkt.odds || mkt.picks || [])) {
      const oName = out.name || out.selectionName || out.outcome || out.label || '';
      const odds  = parseFloat(out.odds || out.price || out.value || 0);
      if (oName && odds > 1.01) outcomes[oName] = odds;
    }
    if (Object.keys(outcomes).length) markets[mktName] = outcomes;
  }
  return { source:'nairabet', eventName: name.toLowerCase(), displayName: name, kickoff, sport: ev.sport||ev.category||'Football', markets };
}

// ── Match + Detect ────────────────────────────────────────────────────────────
function matchEvents(sEvs, nEvs) {
  const matched = [];
  for (const sEv of sEvs) {
    if (!sEv.eventName || sEv.eventName.trim() === 'vs') continue;
    for (const nEv of nEvs) {
      if (!nEv.eventName || nEv.eventName.trim() === 'vs') continue;
      if (stringSimilarity(sEv.eventName, nEv.eventName) < 0.75) continue;
      const sK = sEv.kickoff, nK = nEv.kickoff;
      if (sK && nK) {
        const diff = Math.abs(sK - nK);
        const diffSec = diff > 1e10 ? diff/1000 : diff;
        if (diffSec > 10800) continue;
      }
      matched.push({ sporty: sEv, naira: nEv });
      break;
    }
  }
  return matched;
}

function detectArbs(matched, minPct = 3.0) {
  const arbs = [], seen = new Set();
  for (const { sporty, naira } of matched) {
    for (const [sMkt, sOuts] of Object.entries(sporty.markets)) {
      const nMktKey = Object.keys(naira.markets).find(k => stringSimilarity(k, sMkt) > 0.65);
      if (!nMktKey) continue;
      const nOuts = naira.markets[nMktKey];
      for (const [sOut, sOdds] of Object.entries(sOuts)) {
        for (const [nOut, nOdds] of Object.entries(nOuts)) {
          if (sOut.toLowerCase() === nOut.toLowerCase()) continue;
          const imp = (1/sOdds) + (1/nOdds);
          if (imp >= 1) continue;
          const margin = (1 - imp) * 100;
          if (margin < minPct) continue;
          const id = 'arb_' + stableHash([sporty.eventName, sMkt, sOut, nOut].join('||'));
          if (seen.has(id)) continue;
          seen.add(id);
          arbs.push({
            id, event_name: sporty.displayName, sport: sporty.sport,
            market_name: sMkt,
            leg1_outcome: sOut, leg1_odds: sOdds, leg1_market: sMkt,
            leg2_outcome: nOut, leg2_odds: nOdds, leg2_market: nMktKey,
            margin: parseFloat(margin.toFixed(4)),
            kickoff_ts: sporty.kickoff || Date.now()
          });
        }
      }
    }
  }
  return arbs.sort((a,b) => b.margin - a.margin);
}

// ── DB helpers ────────────────────────────────────────────────────────────────
async function loadArbs({ page = 1, perPage = 20 } = {}) {
  const offset = (page - 1) * perPage;
  const [rows, countRes] = await Promise.all([
    pool.query(`SELECT * FROM arb_opportunities ORDER BY 
      DATE_TRUNC('day', TO_TIMESTAMP(kickoff_ts/1000)) ASC,
      margin DESC
      LIMIT $1 OFFSET $2`, [perPage, offset]),
    pool.query(`SELECT COUNT(*) FROM arb_opportunities`)
  ]);
  return { arbs: rows.rows, total: parseInt(countRes.rows[0].count) };
}

async function syncArbs(freshArbs) {
  const freshIds = freshArbs.map(a => a.id);
  const existing = await pool.query(`SELECT id, leg1_odds, leg2_odds, scan_count FROM arb_opportunities`);
  const existMap = {};
  for (const r of existing.rows) existMap[r.id] = r;

  let added = 0, updated = 0, removed = 0;

  for (const arb of freshArbs) {
    const ex = existMap[arb.id];
    if (!ex) {
      await pool.query(
        `INSERT INTO arb_opportunities
          (id,event_name,sport,market_name,leg1_outcome,leg1_odds,leg1_market,
           leg2_outcome,leg2_odds,leg2_market,margin,kickoff_ts,first_seen,last_seen,odds_changed,scan_count)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW(),NOW(),false,1)
         ON CONFLICT (id) DO NOTHING`,
        [arb.id,arb.event_name,arb.sport,arb.market_name,
         arb.leg1_outcome,arb.leg1_odds,arb.leg1_market,
         arb.leg2_outcome,arb.leg2_odds,arb.leg2_market,
         arb.margin, arb.kickoff_ts]
      );
      added++;
    } else {
      const changed = Math.abs(ex.leg1_odds-arb.leg1_odds)>0.001 || Math.abs(ex.leg2_odds-arb.leg2_odds)>0.001;
      await pool.query(
        `UPDATE arb_opportunities SET
           last_seen=NOW(), leg1_odds=$2, leg2_odds=$3, margin=$4,
           odds_changed=$5, scan_count=$6, kickoff_ts=$7
         WHERE id=$1`,
        [arb.id, arb.leg1_odds, arb.leg2_odds, arb.margin,
         changed, (ex.scan_count||0)+1, arb.kickoff_ts]
      );
      updated++;
    }
  }

  // Remove expired arbs
  if (existing.rows.length > 0) {
    const toRemove = existing.rows.map(r=>r.id).filter(id=>!freshIds.includes(id));
    if (toRemove.length) {
      await pool.query(`DELETE FROM arb_opportunities WHERE id = ANY($1)`, [toRemove]);
      removed = toRemove.length;
    }
  }

  return { added, updated, removed };
}

// ── Routes ────────────────────────────────────────────────────────────────────
app.get('/arbs', async (req, res) => {
  try {
    const page    = parseInt(req.query.page)    || 1;
    const perPage = parseInt(req.query.perPage) || 20;
    const result  = await loadArbs({ page, perPage });
    res.json({ success: true, ...result, page, perPage, pages: Math.ceil(result.total / perPage) });
  } catch(e) {
    console.error('Load error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/scan', async (req, res) => {
  const minMargin = parseFloat(req.query.minMargin || req.body?.minMargin || 3.0);
  try {
    console.log('Scan started...');
    const [sportyRaw, nairaRaw] = await Promise.all([fetchSportyBet(), fetchNairabet()]);
    console.log(`Raw: Sporty=${sportyRaw.length} Naira=${nairaRaw.length}`);

    const sportyNorm = sportyRaw.map(normalizeSportybet).filter(e=>e.eventName.replace('vs','').trim().length>2);
    const nairaNorm  = nairaRaw.map(normalizeNairabet).filter(e=>e.eventName.replace('vs','').trim().length>2);

    const matched  = matchEvents(sportyNorm, nairaNorm);
    const fresh    = detectArbs(matched, minMargin);
    const sync     = await syncArbs(fresh);
    const result   = await loadArbs({ page: 1, perPage: 20 });

    res.json({
      success: true,
      scan: { sportybet_events: sportyRaw.length, nairabet_events: nairaRaw.length, matched_pairs: matched.length, arbs_found: fresh.length, ...sync },
      ...result, page: 1, perPage: 20, pages: Math.ceil(result.total/20)
    });
  } catch(e) {
    console.error('Scan error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.delete('/arbs', async (_, res) => {
  try {
    await pool.query('DELETE FROM arb_opportunities');
    res.json({ success: true });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

app.listen(PORT, () => console.log(`Arb proxy on port ${PORT}`));
