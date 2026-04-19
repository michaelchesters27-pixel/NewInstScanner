const { DateTime } = require('luxon');
const { createClient } = require('@supabase/supabase-js');

const APP_TZ = process.env.APP_TIMEZONE || 'Europe/London';
const PAIR = 'EUR/USD';
const SYMBOL = 'EUR/USD';
const RR_MIN = 2;

function roundPrice(value) {
  if (value == null || Number.isNaN(value)) return null;
  return Number(Number(value).toFixed(5));
}

function parseCandle(raw) {
  return {
    datetime: raw.datetime,
    open: Number(raw.open),
    high: Number(raw.high),
    low: Number(raw.low),
    close: Number(raw.close),
    volume: raw.volume != null ? Number(raw.volume) : null,
  };
}

async function fetchJson(url) {
  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.message || `Request failed with status ${response.status}`);
  }
  if (data.status === 'error') {
    throw new Error(data.message || 'Twelve Data returned an error');
  }
  return data;
}

async function fetchCandles(interval, outputsize) {
  const apiKey = process.env.TWELVEDATA_API_KEY;
  if (!apiKey) {
    throw new Error('Missing TWELVEDATA_API_KEY');
  }
  const params = new URLSearchParams({
    symbol: SYMBOL,
    interval,
    outputsize: String(outputsize),
    timezone: 'UTC',
    order: 'ASC',
    apikey: apiKey,
  });
  const url = `https://api.twelvedata.com/time_series?${params.toString()}`;
  const data = await fetchJson(url);
  const values = Array.isArray(data.values) ? data.values.map(parseCandle) : [];
  if (!values.length) {
    throw new Error(`No candle data returned for ${interval}`);
  }
  return values;
}

async function fetchLatestPrice() {
  const apiKey = process.env.TWELVEDATA_API_KEY;
  const params = new URLSearchParams({
    symbol: SYMBOL,
    apikey: apiKey,
  });
  const data = await fetchJson(`https://api.twelvedata.com/price?${params.toString()}`);
  return Number(data.price);
}

function toLocalDateTime(utcString) {
  return DateTime.fromSQL(utcString, { zone: 'UTC' }).setZone(APP_TZ);
}

function previousClosedCandle(candles) {
  return candles[candles.length - 1];
}

function findPivots(candles, span = 2) {
  const highs = [];
  const lows = [];
  for (let i = span; i < candles.length - span; i += 1) {
    const candle = candles[i];
    let isHigh = true;
    let isLow = true;
    for (let j = i - span; j <= i + span; j += 1) {
      if (j === i) continue;
      if (candles[j].high >= candle.high) isHigh = false;
      if (candles[j].low <= candle.low) isLow = false;
    }
    if (isHigh) highs.push({ index: i, value: candle.high, datetime: candle.datetime });
    if (isLow) lows.push({ index: i, value: candle.low, datetime: candle.datetime });
  }
  return { highs, lows };
}

function deriveBias(hourlyCandles) {
  const { highs, lows } = findPivots(hourlyCandles, 2);
  const lastTwoHighs = highs.slice(-2);
  const lastTwoLows = lows.slice(-2);
  const latestClose = hourlyCandles[hourlyCandles.length - 1].close;

  let bias = 'NEUTRAL';
  const reasons = [];

  if (lastTwoHighs.length === 2 && lastTwoLows.length === 2) {
    const [prevHigh, lastHigh] = lastTwoHighs;
    const [prevLow, lastLow] = lastTwoLows;

    if (lastHigh.value > prevHigh.value && lastLow.value > prevLow.value) {
      bias = 'BULLISH';
      reasons.push('1H structure shows higher high and higher low.');
    } else if (lastHigh.value < prevHigh.value && lastLow.value < prevLow.value) {
      bias = 'BEARISH';
      reasons.push('1H structure shows lower high and lower low.');
    }
  }

  if (bias === 'NEUTRAL') {
    const recent = hourlyCandles.slice(-12);
    const averageClose = recent.reduce((sum, candle) => sum + candle.close, 0) / recent.length;
    if (latestClose > averageClose) {
      bias = 'BULLISH';
      reasons.push('1H fallback bias is bullish from recent closing structure.');
    } else if (latestClose < averageClose) {
      bias = 'BEARISH';
      reasons.push('1H fallback bias is bearish from recent closing structure.');
    } else {
      reasons.push('1H bias is neutral because structure is mixed.');
    }
  }

  return {
    bias,
    reasons,
    pivots: {
      highs: lastTwoHighs,
      lows: lastTwoLows,
    },
  };
}

function sessionName(localDt) {
  const hhmm = Number(localDt.toFormat('HHmm'));
  if (hhmm >= 800 && hhmm < 1200) return 'LONDON';
  if (hhmm >= 1300 && hhmm < 1700) return 'NEW_YORK';
  return 'OUTSIDE_SESSION';
}

function institutionalWindow(localDt) {
  const hhmm = Number(localDt.toFormat('HHmm'));
  const hour = localDt.hour;
  const minute = localDt.minute;
  const activeWindow = hhmm >= 700 && hhmm < 1700;
  const monitorWindow = hhmm >= 1700 && hhmm < 2300;
  const offWindow = !activeWindow && !monitorWindow;
  return {
    activeWindow,
    monitorWindow,
    offWindow,
    inScanWindow: activeWindow || monitorWindow,
    shouldScanNow: (activeWindow && minute % 15 === 0) || (monitorWindow && minute === 0 && hour % 2 === 1),
  };
}

function nextScheduledScan(nowLocal) {
  const weekday = nowLocal.weekday;
  if (weekday > 5) {
    return nowLocal.plus({ days: 8 - weekday }).startOf('day').set({ hour: 7, minute: 0, second: 0, millisecond: 0 });
  }
  const hhmm = Number(nowLocal.toFormat('HHmm'));
  if (hhmm < 700) {
    return nowLocal.startOf('day').set({ hour: 7, minute: 0, second: 0, millisecond: 0 });
  }
  if (hhmm >= 2300) {
    let next = nowLocal.plus({ days: 1 }).startOf('day').set({ hour: 7, minute: 0, second: 0, millisecond: 0 });
    if (next.weekday > 5) next = next.plus({ days: 8 - next.weekday });
    return next;
  }
  if (hhmm < 1700) {
    const minute = nowLocal.minute;
    const nextMinute = Math.floor(minute / 15) * 15 + 15;
    if (nextMinute >= 60) return nowLocal.plus({ hours: 1 }).set({ minute: 0, second: 0, millisecond: 0 });
    return nowLocal.set({ minute: nextMinute, second: 0, millisecond: 0 });
  }
  const targetHour = nowLocal.hour % 2 === 1 ? nowLocal.hour + 2 : nowLocal.hour + 1;
  if (targetHour >= 23) {
    let next = nowLocal.plus({ days: 1 }).startOf('day').set({ hour: 7, minute: 0, second: 0, millisecond: 0 });
    if (next.weekday > 5) next = next.plus({ days: 8 - next.weekday });
    return next;
  }
  return nowLocal.set({ hour: targetHour, minute: 0, second: 0, millisecond: 0 });
}

function shouldRunScheduledScan(nowLocal) {
  const weekday = nowLocal.weekday;
  if (weekday < 1 || weekday > 5) return false;
  return institutionalWindow(nowLocal).shouldScanNow;
}

function groupCandlesByLocalDate(candles) {
  const map = new Map();
  for (const candle of candles) {
    const dt = toLocalDateTime(candle.datetime);
    const key = dt.toISODate();
    if (!map.has(key)) map.set(key, []);
    map.get(key).push({ ...candle, local: dt });
  }
  return map;
}

function getDailyLevels(candles15m) {
  const grouped = groupCandlesByLocalDate(candles15m);
  const dates = [...grouped.keys()].sort();
  const todayKey = dates[dates.length - 1];
  const yesterdayKey = dates[dates.length - 2];
  const today = grouped.get(todayKey) || [];
  const yesterday = grouped.get(yesterdayKey) || [];

  const pdh = yesterday.length ? Math.max(...yesterday.map((c) => c.high)) : null;
  const pdl = yesterday.length ? Math.min(...yesterday.map((c) => c.low)) : null;

  const asia = today.filter((c) => Number(c.local.toFormat('HHmm')) >= 0 && Number(c.local.toFormat('HHmm')) < 800);
  const london = today.filter((c) => Number(c.local.toFormat('HHmm')) >= 800 && Number(c.local.toFormat('HHmm')) < 1200);

  return {
    pdh,
    pdl,
    asiaHigh: asia.length ? Math.max(...asia.map((c) => c.high)) : null,
    asiaLow: asia.length ? Math.min(...asia.map((c) => c.low)) : null,
    londonHigh: london.length ? Math.max(...london.map((c) => c.high)) : null,
    londonLow: london.length ? Math.min(...london.map((c) => c.low)) : null,
  };
}

function nearestKeyLevel(price, levels, bias) {
  const candidates = [
    { name: 'PDH', value: levels.pdh },
    { name: 'PDL', value: levels.pdl },
    { name: 'ASIA_HIGH', value: levels.asiaHigh },
    { name: 'ASIA_LOW', value: levels.asiaLow },
    { name: 'LONDON_HIGH', value: levels.londonHigh },
    { name: 'LONDON_LOW', value: levels.londonLow },
  ].filter((item) => item.value != null);

  const range = 0.0008;
  const matches = candidates.filter((item) => Math.abs(price - item.value) <= range);
  if (!matches.length) {
    return { atKeyLevel: false, keyLevel: null, side: null };
  }

  const preferred = matches.find((item) => {
    if (bias === 'BULLISH') return /(LOW|PDL)/.test(item.name);
    if (bias === 'BEARISH') return /(HIGH|PDH)/.test(item.name);
    return true;
  }) || matches[0];

  const side = /(LOW|PDL)/.test(preferred.name) ? 'LOW' : 'HIGH';
  return {
    atKeyLevel: true,
    keyLevel: preferred,
    side,
  };
}

function averageBody(candles, count = 10) {
  const sample = candles.slice(-count);
  return sample.reduce((sum, candle) => sum + Math.abs(candle.close - candle.open), 0) / sample.length;
}

function detectSweep(candles15m, levels, bias) {
  const last = candles15m[candles15m.length - 1];
  const prev = candles15m[candles15m.length - 2];
  const candidates = [];

  if (levels.pdh != null) candidates.push({ name: 'PDH', value: levels.pdh, type: 'HIGH' });
  if (levels.pdl != null) candidates.push({ name: 'PDL', value: levels.pdl, type: 'LOW' });
  if (levels.asiaHigh != null) candidates.push({ name: 'ASIA_HIGH', value: levels.asiaHigh, type: 'HIGH' });
  if (levels.asiaLow != null) candidates.push({ name: 'ASIA_LOW', value: levels.asiaLow, type: 'LOW' });
  if (levels.londonHigh != null) candidates.push({ name: 'LONDON_HIGH', value: levels.londonHigh, type: 'HIGH' });
  if (levels.londonLow != null) candidates.push({ name: 'LONDON_LOW', value: levels.londonLow, type: 'LOW' });

  const tests = [];
  for (const level of candidates) {
    if (level.type === 'LOW') {
      const swept = last.low < level.value && last.close > level.value;
      if (swept) tests.push({ ...level, direction: 'BUY', candle: last });
      const sweptPrev = prev.low < level.value && prev.close > level.value;
      if (sweptPrev) tests.push({ ...level, direction: 'BUY', candle: prev });
    } else {
      const swept = last.high > level.value && last.close < level.value;
      if (swept) tests.push({ ...level, direction: 'SELL', candle: last });
      const sweptPrev = prev.high > level.value && prev.close < level.value;
      if (sweptPrev) tests.push({ ...level, direction: 'SELL', candle: prev });
    }
  }

  const best = tests.find((test) => (bias === 'BULLISH' ? test.direction === 'BUY' : bias === 'BEARISH' ? test.direction === 'SELL' : true)) || tests[0];
  if (!best) {
    return { detected: false, direction: null, level: null, candle: null };
  }

  return {
    detected: true,
    direction: best.direction,
    level: best,
    candle: best.candle,
  };
}

function detectReclaimAndDisplacement(candles15m, sweep) {
  const last = candles15m[candles15m.length - 1];
  const prev = candles15m[candles15m.length - 2];
  const bodyAvg = averageBody(candles15m.slice(0, -1), 10) || 0.0002;

  if (!sweep.detected) {
    return {
      reclaim: false,
      displacement: false,
      displacementStrength: 'NONE',
    };
  }

  if (sweep.direction === 'BUY') {
    const reclaim = last.close > sweep.level.value || prev.close > sweep.level.value;
    const body = Math.abs(last.close - last.open);
    const bullishClose = last.close > last.open;
    const displacement = bullishClose && body >= bodyAvg * 1.4 && last.close > prev.high;
    return {
      reclaim,
      displacement,
      displacementStrength: displacement ? 'STRONG' : body >= bodyAvg ? 'MODERATE' : 'WEAK',
    };
  }

  const reclaim = last.close < sweep.level.value || prev.close < sweep.level.value;
  const body = Math.abs(last.close - last.open);
  const bearishClose = last.close < last.open;
  const displacement = bearishClose && body >= bodyAvg * 1.4 && last.close < prev.low;
  return {
    reclaim,
    displacement,
    displacementStrength: displacement ? 'STRONG' : body >= bodyAvg ? 'MODERATE' : 'WEAK',
  };
}

function buildTrade(candles15m, bias, sweep, reclaimInfo, levels) {
  const last = candles15m[candles15m.length - 1];
  const prev = candles15m[candles15m.length - 2];
  if (!sweep.detected || !reclaimInfo.reclaim || !reclaimInfo.displacement) {
    return {
      direction: null,
      entry: null,
      stop: null,
      target: null,
      rr: null,
      actionable: false,
      status: 'NO_TRADE',
    };
  }

  if (bias === 'BULLISH' && sweep.direction === 'BUY') {
    const entry = Math.max(last.high, prev.high) + 0.00003;
    const stop = Math.min(last.low, prev.low, sweep.level.value) - 0.00003;
    const targetCandidates = [levels.londonHigh, levels.asiaHigh, levels.pdh].filter((v) => v != null && v > entry);
    const target = targetCandidates.sort((a, b) => a - b)[0] || entry + (entry - stop) * RR_MIN;
    const rr = (target - entry) / (entry - stop);
    const distanceMoved = Math.max(0, last.close - entry);
    const totalDistance = Math.max(target - entry, 0.00001);
    const actionable = rr >= RR_MIN && distanceMoved / totalDistance <= 0.3 && last.close <= entry;
    return {
      direction: 'BUY',
      entry: roundPrice(entry),
      stop: roundPrice(stop),
      target: roundPrice(target),
      rr: Number(rr.toFixed(2)),
      actionable,
      status: actionable ? 'IDEA_READY' : 'TRADE_PASSED',
    };
  }

  if (bias === 'BEARISH' && sweep.direction === 'SELL') {
    const entry = Math.min(last.low, prev.low) - 0.00003;
    const stop = Math.max(last.high, prev.high, sweep.level.value) + 0.00003;
    const targetCandidates = [levels.londonLow, levels.asiaLow, levels.pdl].filter((v) => v != null && v < entry);
    const target = targetCandidates.sort((a, b) => b - a)[0] || entry - (stop - entry) * RR_MIN;
    const rr = (entry - target) / (stop - entry);
    const distanceMoved = Math.max(0, entry - last.close);
    const totalDistance = Math.max(entry - target, 0.00001);
    const actionable = rr >= RR_MIN && distanceMoved / totalDistance <= 0.3 && last.close >= entry;
    return {
      direction: 'SELL',
      entry: roundPrice(entry),
      stop: roundPrice(stop),
      target: roundPrice(target),
      rr: Number(rr.toFixed(2)),
      actionable,
      status: actionable ? 'IDEA_READY' : 'TRADE_PASSED',
    };
  }

  return {
    direction: null,
    entry: null,
    stop: null,
    target: null,
    rr: null,
    actionable: false,
    status: 'NO_TRADE',
  };
}

function criteriaChecklist({ biasInfo, keyLevelInfo, sweep, reclaimInfo, session, trade }) {
  const sessionValid = session === 'LONDON' || session === 'NEW_YORK';
  const rrValid = trade.rr != null && trade.rr >= RR_MIN;

  return [
    { key: 'bias', label: '1H bias confirmed', passed: biasInfo.bias !== 'NEUTRAL' },
    { key: 'keyLevel', label: 'Price at key level', passed: keyLevelInfo.atKeyLevel },
    { key: 'sweep', label: 'Liquidity sweep detected', passed: sweep.detected },
    { key: 'reclaim', label: 'Reclaim / rejection confirmed', passed: reclaimInfo.reclaim },
    { key: 'displacement', label: 'Displacement confirmed', passed: reclaimInfo.displacement },
    { key: 'session', label: 'Valid London / New York session', passed: sessionValid },
    { key: 'actionable', label: 'Trade still actionable', passed: trade.actionable },
    { key: 'rr', label: 'Minimum RR 1:2 met', passed: rrValid },
  ];
}

function progressFromChecklist(checklist) {
  const passed = checklist.filter((item) => item.passed).length;
  const total = checklist.length;
  const percent = Math.round((passed / total) * 100);
  return { passed, total, percent };
}

function finalState({ checklist, trade, biasInfo, sweep }) {
  const allPassed = checklist.every((item) => item.passed);
  if (allPassed && trade.direction === 'BUY') return 'BUY_IDEA';
  if (allPassed && trade.direction === 'SELL') return 'SELL_IDEA';
  if (trade.status === 'TRADE_PASSED') return 'TRADE_PASSED';

  const percent = progressFromChecklist(checklist).percent;
  if (percent >= 65 || (biasInfo.bias !== 'NEUTRAL' && sweep.detected)) return 'WE_ARE_CLOSE';
  return 'NO_TRADE';
}

function summaryText(state, scan) {
  const reasons = [];
  reasons.push(`1H bias: ${scan.bias.bias}`);
  reasons.push(`Session: ${scan.session.replace('_', ' ')}`);
  if (scan.sweep.detected) {
    reasons.push(`Sweep detected at ${scan.sweep.level.name}`);
  } else {
    reasons.push('No valid sweep at tracked liquidity levels');
  }
  if (scan.reclaim.reclaim) reasons.push('Reclaim confirmed');
  if (scan.reclaim.displacement) reasons.push('Displacement confirmed');
  if (scan.trade.rr) reasons.push(`RR ${scan.trade.rr}`);

  if (state === 'BUY_IDEA') return `Buy idea ready. ${reasons.join('. ')}.`;
  if (state === 'SELL_IDEA') return `Sell idea ready. ${reasons.join('. ')}.`;
  if (state === 'WE_ARE_CLOSE') return `Criteria building. ${reasons.join('. ')}.`;
  if (state === 'TRADE_PASSED') return `Trade setup was seen but is no longer actionable. ${reasons.join('. ')}.`;
  return `No trade. ${reasons.join('. ')}.`;
}

function createSupabaseAdmin() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

async function updateExistingTradeOutcomes(supabase, latestPrice) {
  if (!supabase) return;
  const { data: openTrades, error } = await supabase
    .from('trade_ideas')
    .select('*')
    .in('status', ['WAITING_ENTRY', 'ACTIVE']);

  if (error || !openTrades) return;

  for (const trade of openTrades) {
    let nextStatus = trade.status;
    if (trade.status === 'WAITING_ENTRY') {
      if (trade.direction === 'BUY' && latestPrice >= trade.entry) nextStatus = 'ACTIVE';
      if (trade.direction === 'SELL' && latestPrice <= trade.entry) nextStatus = 'ACTIVE';
    }

    if (nextStatus === 'ACTIVE') {
      if (trade.direction === 'BUY') {
        if (latestPrice >= trade.target) nextStatus = 'WON';
        else if (latestPrice <= trade.stop) nextStatus = 'LOST';
      } else if (trade.direction === 'SELL') {
        if (latestPrice <= trade.target) nextStatus = 'WON';
        else if (latestPrice >= trade.stop) nextStatus = 'LOST';
      }
    }

    const createdAt = DateTime.fromISO(trade.created_at || trade.scan_time, { zone: 'utc' });
    const ageHours = DateTime.utc().diff(createdAt, 'hours').hours;
    if (['WAITING_ENTRY', 'ACTIVE'].includes(nextStatus) && ageHours > 24) {
      nextStatus = trade.status === 'WAITING_ENTRY' ? 'EXPIRED' : 'INVALIDATED';
    }

    if (nextStatus !== trade.status) {
      await supabase
        .from('trade_ideas')
        .update({ status: nextStatus, outcome_price: latestPrice, updated_at: new Date().toISOString() })
        .eq('id', trade.id);
    }
  }
}

async function persistScan({ supabase, scan, state, progress }) {
  if (!supabase) return { history: [], stats: null };

  const scannerStatePayload = {
    pair: PAIR,
    state,
    direction: scan.trade.direction,
    bias: scan.bias.bias,
    session: scan.session,
    entry: scan.trade.entry,
    stop: scan.trade.stop,
    target: scan.trade.target,
    rr: scan.trade.rr,
    progress_percent: progress.percent,
    summary: summaryText(state, scan),
    key_levels: scan.levels,
    checklist: scan.checklist,
    last_scan_time: scan.scanTimeUtc,
    raw_payload: scan,
    updated_at: new Date().toISOString(),
  };

  await supabase.from('scanner_state').upsert(scannerStatePayload, { onConflict: 'pair' });

  const shouldStoreIdea = ['BUY_IDEA', 'SELL_IDEA', 'WE_ARE_CLOSE', 'TRADE_PASSED'].includes(state);
  if (shouldStoreIdea) {
    const fingerprint = `${state}-${scan.trade.direction || 'NA'}-${scan.trade.entry || 'NA'}-${scan.sweep.level?.name || 'NONE'}-${scan.scanTimeUtc.slice(0, 16)}`;
    const { data: existing } = await supabase
      .from('trade_ideas')
      .select('id')
      .eq('fingerprint', fingerprint)
      .maybeSingle();

    if (!existing) {
      await supabase.from('trade_ideas').insert({
        pair: PAIR,
        state,
        direction: scan.trade.direction,
        bias: scan.bias.bias,
        session: scan.session,
        entry: scan.trade.entry,
        stop: scan.trade.stop,
        target: scan.trade.target,
        rr: scan.trade.rr,
        progress_percent: progress.percent,
        key_level: scan.sweep.level?.name || scan.keyLevel.keyLevel?.name || null,
        summary: summaryText(state, scan),
        checklist: scan.checklist,
        status: state === 'BUY_IDEA' || state === 'SELL_IDEA' ? 'WAITING_ENTRY' : state === 'TRADE_PASSED' ? 'PASSED' : 'BUILDING',
        scan_time: scan.scanTimeUtc,
        fingerprint,
      });
    }
  }

  await supabase.from('scanner_runs').insert({
    pair: PAIR,
    state,
    progress_percent: progress.percent,
    summary: summaryText(state, scan),
    scan_time: scan.scanTimeUtc,
  });

  const { data: history } = await supabase
    .from('trade_ideas')
    .select('*')
    .order('scan_time', { ascending: false })
    .limit(25);

  const { data: statsRows } = await supabase
    .from('trade_ideas')
    .select('status, state');

  const stats = buildStats(statsRows || []);
  return { history: history || [], stats };
}

function buildStats(rows) {
  const total = rows.length;
  const wins = rows.filter((row) => row.status === 'WON').length;
  const losses = rows.filter((row) => row.status === 'LOST').length;
  const active = rows.filter((row) => ['WAITING_ENTRY', 'ACTIVE'].includes(row.status)).length;
  const passed = rows.filter((row) => row.status === 'PASSED').length;
  const close = rows.filter((row) => row.state === 'WE_ARE_CLOSE' || row.status === 'BUILDING').length;
  return {
    totalIdeas: total,
    wins,
    losses,
    active,
    passed,
    close,
    winRate: total ? Number(((wins / Math.max(wins + losses, 1)) * 100).toFixed(1)) : 0,
  };
}

async function loadFallbackHistory(supabase) {
  if (!supabase) return { history: [], stats: buildStats([]) };
  const { data: history } = await supabase
    .from('trade_ideas')
    .select('*')
    .order('scan_time', { ascending: false })
    .limit(25);
  return { history: history || [], stats: buildStats(history || []) };
}


async function loadFallbackHistory(supabase) {
  if (!supabase) return { history: [], stats: buildStats([]) };
  const { data: history } = await supabase.from('trade_ideas').select('*').order('scan_time', { ascending: false }).limit(25);
  return { history: history || [], stats: buildStats(history || []) };
}

async function loadDashboardState() {
  const supabase = createSupabaseAdmin();
  if (!supabase) {
    return {
      ok: true,
      state: 'NO_TRADE',
      summary: 'No stored scanner state yet.',
      scan: null,
      history: [],
      stats: buildStats([]),
    };
  }

  const { data: stateRow } = await supabase.from('scanner_state').select('*').eq('pair', PAIR).maybeSingle();
  const { data: history } = await supabase.from('trade_ideas').select('*').order('scan_time', { ascending: false }).limit(25);
  const { data: statsRows } = await supabase.from('trade_ideas').select('status, state');

  if (!stateRow) {
    return {
      ok: true,
      state: 'NO_TRADE',
      summary: 'No stored scanner state yet.',
      scan: null,
      history: history || [],
      stats: buildStats(statsRows || []),
    };
  }

  return {
    ok: true,
    state: stateRow.state,
    summary: stateRow.summary,
    scan: stateRow.raw_payload || {
      pair: PAIR,
      latestPrice: null,
      scanTimeUtc: stateRow.last_scan_time,
      bias: { bias: stateRow.bias || 'NEUTRAL' },
      trade: {
        direction: stateRow.direction,
        entry: stateRow.entry,
        stop: stateRow.stop,
        target: stateRow.target,
        rr: stateRow.rr,
        actionable: false,
      },
      session: stateRow.session,
      checklist: stateRow.checklist || [],
      progress: { percent: stateRow.progress_percent || 0 },
      levels: stateRow.key_levels || {},
      window: { nextScanLocal: nextScheduledScan(DateTime.now().setZone(APP_TZ)).toISO() },
    },
    history: history || [],
    stats: buildStats(statsRows || []),
  };
}

async function runScan(options = {}) {
  const { force = false } = options;
  const nowLocal = DateTime.now().setZone(APP_TZ);
  if (!force && !shouldRunScheduledScan(nowLocal)) {
    return loadDashboardState();
  }

  const [candles15m, candles1h, latestPrice] = await Promise.all([
    fetchCandles('15min', 220),
    fetchCandles('1h', 120),
    fetchLatestPrice(),
  ]);

  const latest15 = previousClosedCandle(candles15m);
  const localDt = toLocalDateTime(latest15.datetime);
  const session = sessionName(localDt);
  const levels = getDailyLevels(candles15m);
  const bias = deriveBias(candles1h);
  const keyLevel = nearestKeyLevel(latest15.close, levels, bias.bias);
  const sweep = detectSweep(candles15m, levels, bias.bias);
  const reclaim = detectReclaimAndDisplacement(candles15m, sweep);
  const trade = buildTrade(candles15m, bias.bias, sweep, reclaim, levels);

  const checklist = criteriaChecklist({
    biasInfo: bias,
    keyLevelInfo: keyLevel,
    sweep,
    reclaimInfo: reclaim,
    session,
    trade,
  });
  const progress = progressFromChecklist(checklist);
  const state = finalState({ checklist, trade, biasInfo: bias, sweep });

  const scan = {
    pair: PAIR,
    latestPrice: roundPrice(latestPrice),
    scanTimeUtc: DateTime.utc().toISO(),
    latestCandleTimeUtc: DateTime.fromSQL(latest15.datetime, { zone: 'UTC' }).toISO(),
    latestCandleTimeLocal: localDt.toISO(),
    bias,
    levels: Object.fromEntries(Object.entries(levels).map(([k, v]) => [k, roundPrice(v)])),
    keyLevel,
    sweep,
    reclaim,
    trade,
    session,
    window: { ...institutionalWindow(localDt), nextScanLocal: nextScheduledScan(DateTime.now().setZone(APP_TZ)).toISO() },
    checklist,
    progress,
  };

  const supabase = createSupabaseAdmin();
  await updateExistingTradeOutcomes(supabase, latestPrice);
  let historyBundle = await persistScan({ supabase, scan, state, progress });
  if (!supabase) {
    historyBundle = await loadFallbackHistory(supabase);
  }

  return {
    ok: true,
    state,
    summary: summaryText(state, scan),
    scan,
    history: historyBundle.history || [],
    stats: historyBundle.stats || buildStats([]),
  };
}

module.exports = {
  runScan,
  loadDashboardState,
  shouldRunScheduledScan,
};
