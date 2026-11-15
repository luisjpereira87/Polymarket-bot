#!/usr/bin/env node
// Uso: node analyze-logs.mjs [pasta-dos-logs]      (default: ./logs, ou $LOG_DIR)
// Lê edge-log.jsonl, dutch-book.jsonl e lag-probe.jsonl e imprime um resumo curto.
import { readFileSync, existsSync } from 'fs';
import path from 'path';

const dir = process.argv[2] || process.env.LOG_DIR || 'logs';

function readJsonl(name) {
    const f = path.join(dir, name);
    if (!existsSync(f)) return null;
    const rows = [];
    let bad = 0;
    for (const line of readFileSync(f, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try { rows.push(JSON.parse(line)); } catch { bad++; }
    }
    return { rows, bad };
}

const nums = (a) => a.filter((x) => typeof x === 'number' && isFinite(x));
const pct = (a, p) => {
    const v = nums(a).sort((x, y) => x - y);
    if (!v.length) return null;
    return v[Math.min(v.length - 1, Math.floor((p / 100) * v.length))];
};
const mean = (a) => { const v = nums(a); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
const f = (x, d = 3) => (x === null || x === undefined ? '-' : Number(x).toFixed(d));
const countBy = (rows, key) => {
    const m = new Map();
    for (const r of rows) m.set(r[key] ?? '?', (m.get(r[key] ?? '?') ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
};
const span = (rows) => {
    const t = rows.map((r) => Date.parse(r.ts)).filter(isFinite);
    if (!t.length) return '-';
    return `${new Date(Math.min(...t)).toISOString().slice(0, 16)} → ${new Date(Math.max(...t)).toISOString().slice(0, 16)}`;
};
const bps = (diff, ref) => (diff / ref) * 1e4;

console.log(`Pasta: ${dir}\n`);

// ───────────── edge-log.jsonl ─────────────
const edge = readJsonl('edge-log.jsonl');
if (!edge) {
    console.log('[edge-log] ficheiro não encontrado\n');
} else {
    const { rows, bad } = edge;
    const entries = rows.filter((r) => r.type === 'entry');
    const skips = rows.filter((r) => r.type === 'skip');
    const cmp = rows.filter((r) => r.type === 'price_compare');
    console.log(`[edge-log] ${rows.length} linhas (${bad} inválidas) | ${span(rows)}`);
    console.log(`  entradas=${entries.length} skips=${skips.length} price_compare=${cmp.length}`);

    if (skips.length) {
        const top = countBy(skips, 'reason').slice(0, 6).map(([k, n]) => `${k.slice(0, 40)}=${n}`).join(' | ');
        console.log(`  skips por motivo (amostrados): ${top}`);
    }

    if (entries.length) {
        console.log(`  entradas: pTarget médio=${f(mean(entries.map((e) => e.pTarget)))} | preço médio=${f(mean(entries.map((e) => e.avgPrice)))} | z médio=${f(mean(entries.map((e) => e.z)), 2)} | gap médio=${f(mean(entries.map((e) => e.gap)))}`);
        console.log(`  por priceSource: ${countBy(entries, 'priceSource').map(([k, n]) => `${k}=${n}`).join(' ')}`);
        const buckets = [[0, 120], [120, 300], [300, 480], [480, 9999]];
        const line = buckets
            .map(([a, b]) => {
                const s = entries.filter((e) => e.secondsLeft >= a && e.secondsLeft < b);
                return s.length ? `${a}-${b === 9999 ? '+' : b}s: n=${s.length} p=${f(mean(s.map((e) => e.pTarget)), 2)} preço=${f(mean(s.map((e) => e.avgPrice)), 2)}` : null;
            })
            .filter(Boolean);
        if (line.length) console.log(`  por tempo restante: ${line.join(' | ')}`);
        console.log('  (os resultados ganhou/perdeu não estão neste ficheiro: junta-os pelo slug)');
    }

    if (cmp.length) {
        const withWsOpen = cmp.filter((r) => r.wsOpen !== null && r.wsOpen !== undefined);
        const openBps = withWsOpen.map((r) => Math.abs(bps(r.openDiff, r.restOpen)));
        const exactOpen = withWsOpen.filter((r) => r.openDiff === 0).length;
        const withSpot = cmp.filter((r) => r.wsSpot !== null && r.wsSpot !== undefined);
        const spotBps = withSpot.map((r) => Math.abs(bps(r.spotDiff, r.restSpot)));
        const ages = cmp.map((r) => r.wsAgeMs);
        console.log(`  [REST vs websocket] wsOpen disponível: ${withWsOpen.length}/${cmp.length} (${f((withWsOpen.length / cmp.length) * 100, 0)}%)`);
        console.log(`    open: diff exata (=0) em ${exactOpen}/${withWsOpen.length} | |diff| bps mediana=${f(pct(openBps, 50), 2)} p95=${f(pct(openBps, 95), 2)} máx=${f(pct(openBps, 100), 2)}`);
        console.log(`    spot: |diff| bps mediana=${f(pct(spotBps, 50), 2)} p95=${f(pct(spotBps, 95), 2)} | idade tick ws (ms) mediana=${f(pct(ages, 50), 0)} p95=${f(pct(ages, 95), 0)}`);
        const bigOpen = withWsOpen.filter((r) => Math.abs(bps(r.openDiff, r.restOpen)) > 1).length;
        if (bigOpen) console.log(`    ⚠️ ${bigOpen} linhas com |openDiff| > 1 bp: não confies no open do websocket até perceberes porquê`);
    }
    console.log('');
}

// ───────────── dutch-book.jsonl ─────────────
const db = readJsonl('dutch-book.jsonl');
if (!db) {
    console.log('[dutch-book] ficheiro não encontrado\n');
} else {
    const { rows, bad } = db;
    const samples = rows.filter((r) => r.type === 'sample');
    const opps = rows.filter((r) => r.type === 'opportunity');
    console.log(`[dutch-book] ${rows.length} linhas (${bad} inválidas) | ${span(rows)}`);
    console.log(`  amostras=${samples.length} oportunidades=${opps.length} (oportunidades são registadas sempre, amostras só a cada 30 s: não compares as contagens)`);
    if (samples.length) {
        const s = samples.map((r) => r.sumAsks);
        const below = samples.filter((r) => r.sumAsks < 1).length;
        console.log(`  soma dos asks (amostras): min=${f(pct(s, 0))} p5=${f(pct(s, 5))} mediana=${f(pct(s, 50))} média=${f(mean(s))} | <1 em ${below}/${samples.length} (${f((below / samples.length) * 100, 1)}%)`);
        const profSkew = samples.filter((r) => r.sumBids !== null && r.sumBids !== undefined);
        if (profSkew.length) console.log(`  soma dos bids (amostras): mediana=${f(pct(profSkew.map((r) => r.sumBids), 50))} máx=${f(pct(profSkew.map((r) => r.sumBids), 100))}`);
    }
    if (opps.length) {
        const bestNet = opps.map((r) => Math.max(...(r.sizes || []).filter((z) => z.complete).map((z) => z.net)));
        console.log(`  oportunidades: net/share mediana=${f(pct(bestNet, 50), 4)} máx=${f(pct(bestNet, 100), 4)} | secondsLeft mediana=${f(pct(opps.map((r) => r.secondsLeft), 50), 0)}`);
        console.log(`  por moeda: ${countBy(opps, 'coin').map(([k, n]) => `${k}=${n}`).join(' ')}`);
        const bySize = new Map();
        for (const r of opps) for (const z of r.sizes || []) if (z.complete && z.net > 0) bySize.set(z.shares, (bySize.get(z.shares) ?? 0) + 1);
        console.log(`  linhas com net>0 e pernas completas por tamanho: ${[...bySize.entries()].map(([s, n]) => `${s}sh=${n}`).join(' ') || '-'}`);
        const depth = opps.map((r) => Math.min(r.depthAskUp, r.depthAskDown));
        console.log(`  profundidade no melhor ask (min das 2 pernas): mediana=${f(pct(depth, 50), 0)} shares`);
    }
    console.log('');
}

// ───────────── lag-probe.jsonl ─────────────
const lag = readJsonl('lag-probe.jsonl');
if (!lag) {
    console.log('[lag-probe] ficheiro não encontrado\n');
} else {
    const { rows, bad } = lag;
    const l = rows.filter((r) => r.type === 'lag');
    console.log(`[lag-probe] ${l.length} sondas (${bad} linhas inválidas) | ${span(l)}`);
    if (l.length) {
        console.log(`  por moeda: ${countBy(l, 'coin').map(([k, n]) => `${k}=${n}`).join(' ')} | direção: ${countBy(l, 'direction').map(([k, n]) => `${k}=${n}`).join(' ')}`);
        console.log(`  movimento Binance: |changePct| mediana=${f(pct(l.map((r) => Math.abs(r.changePct)), 50), 3)}% | feedDelayMs mediana=${f(pct(l.map((r) => r.feedDelayMs), 50), 0)} | baselineDelayMs mediana=${f(pct(l.map((r) => r.baselineDelayMs), 50), 0)}`);
        console.log(`  ask de partida: mediana=${f(pct(l.map((r) => r.baselineAsk), 50), 2)} | maxAskDelta mediana=${f(pct(l.map((r) => r.maxAskDelta), 50), 3)}`);
        const keys = Object.keys(l[0].crossedMs || {});
        for (const k of keys) {
            const v = l.map((r) => r.crossedMs?.[k]);
            const hit = v.filter((x) => typeof x === 'number');
            console.log(`  ask sobe ${k.slice(1)}: atingido em ${hit.length}/${l.length} (${f((hit.length / l.length) * 100, 0)}%) | tempo (ms) p25=${f(pct(hit, 25), 0)} mediana=${f(pct(hit, 50), 0)} p75=${f(pct(hit, 75), 0)}`);
        }
        const fast = l.filter((r) => (r.crossedMs?.['t0.05'] ?? Infinity) <= (r.baselineDelayMs ?? 0) + 600).length;
        console.log(`  sondas em que o ask já tinha reagido no 1º poll (≤ baselineDelay+600ms): ${fast}/${l.length}${fast > 0 ? ' → nestas, o atraso do mercado é inferior à resolução de medição' : ''}`);
    }
    console.log('');
}
