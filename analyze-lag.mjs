#!/usr/bin/env node
// Uso: node analyze-lag.mjs [pasta-dos-logs] [--latency 500] [--fee 0.0156] [--outcomes]
//
//  --latency  ms entre o gatilho (movimento da Binance) e a execução simulada da compra (default 500)
//  --fee      fee estimada como fração do valor de cada perna (default 0.0156, PLACEHOLDER: confirma a real)
//  --outcomes vai buscar à Binance o resultado de cada janela (precisa de rede) e testa "comprar e esperar"
//
// Lê lag-probe.jsonl (criado pelo LagProbe). NÃO envia ordens.
import { readFileSync, existsSync } from 'fs';
import path from 'path';

// ───────────── argumentos ─────────────
const args = process.argv.slice(2);
const opts = { latency: 500, fee: 0.0156, outcomes: false };
let dirArg = null;
for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--latency') opts.latency = Number(args[++i]);
    else if (a === '--fee') opts.fee = Number(args[++i]);
    else if (a === '--outcomes') opts.outcomes = true;
    else if (!a.startsWith('--') && dirArg === null) dirArg = a;
}
const dir = dirArg || process.env.LOG_DIR || 'logs';

// ───────────── utilitários ─────────────
const f = (x, d = 3) => (x === null || x === undefined || !isFinite(x) ? '-' : Number(x).toFixed(d));
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const median = (a) => {
    if (!a.length) return null;
    const v = [...a].sort((x, y) => x - y);
    return v[Math.floor(v.length / 2)];
};
const sd = (a) => {
    if (a.length < 2) return null;
    const m = mean(a);
    return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};
const ci = (a) => (a.length >= 2 ? 1.96 * (sd(a) / Math.sqrt(a.length)) : null); // 95% (ingénuo)

/** Valor da coluna (1 = ask, 2 = bid) no instante t (ms desde o gatilho). A série só tem mudanças. */
function stepAt(series, t, col) {
    let val = series[0][col];
    for (const p of series) {
        if (p[0] <= t) val = p[col];
        else break;
    }
    return val;
}

// ───────────── leitura ─────────────
const file = path.join(dir, 'lag-probe.jsonl');
if (!existsSync(file)) {
    console.log(`Ficheiro não encontrado: ${file}`);
    process.exit(1);
}
const probes = [];
for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
        const r = JSON.parse(line);
        if (r.type === 'lag' && Array.isArray(r.series) && r.series.length) probes.push(r);
    } catch {
        /* linha inválida */
    }
}
console.log(`Sondas: ${probes.length} | latência assumida ${opts.latency} ms | fee ${f(opts.fee * 100, 2)}% por perna (placeholder)\n`);
if (!probes.length) process.exit(0);

// ───────────── 1) Controlo: o ask também desce? ─────────────
console.log('1) CONTROLO: frequência com que o ask do token "certo" SOBE vs DESCE (em qualquer momento da sonda)');
for (const th of [0.02, 0.05, 0.1]) {
    let up = 0, down = 0, both = 0;
    for (const p of probes) {
        const base = p.baselineAsk;
        const asks = p.series.map((s) => s[1]).filter((x) => typeof x === 'number');
        const rose = Math.max(...asks) - base >= th - 1e-9;
        const fell = base - Math.min(...asks) >= th - 1e-9;
        if (rose) up++;
        if (fell) down++;
        if (rose && fell) both++;
    }
    console.log(`   ±${f(th, 2)}: sobe em ${up}/${probes.length} (${f((up / probes.length) * 100, 0)}%) | desce em ${down}/${probes.length} (${f((down / probes.length) * 100, 0)}%) | ambos ${both}`);
}
console.log('   → se "desce" for quase tão frequente como "sobe", as subidas são em boa parte ruído do book.\n');

// ───────────── 2) Round trip simulado: compra ao ask, vende ao bid ─────────────
console.log(`2) ROUND TRIP SIMULADO: compra ao ask em t=${opts.latency}ms, vende ao bid X s depois (PnL por share, depois de fees)`);
const HOLDS = [3, 5, 10, 20, 30, 60];

function roundTrips(hold, subset = probes) {
    const out = [];
    for (const p of subset) {
        const maxT = Math.min(90_000, ((p.secondsLeftAtTrigger ?? 0) - 5) * 1000);
        const tIn = opts.latency;
        const tOut = tIn + hold * 1000;
        if (tOut > maxT) continue; // a sonda não cobre este horizonte
        const askIn = stepAt(p.series, tIn, 1);
        const bidOut = stepAt(p.series, tOut, 2);
        if (typeof askIn !== 'number' || typeof bidOut !== 'number') continue;
        const pnl = bidOut - askIn - opts.fee * (askIn + bidOut);
        out.push({ pnl, askIn, p });
    }
    return out;
}

console.log('   hold |    n | PnL médio/share (±IC95) | mediana | acerta (pnl>0) | ask entrada médio');
for (const h of HOLDS) {
    const r = roundTrips(h);
    if (!r.length) {
        console.log(`   ${String(h).padStart(3)}s |    0 |`);
        continue;
    }
    const v = r.map((x) => x.pnl);
    console.log(
        `   ${String(h).padStart(3)}s | ${String(r.length).padStart(4)} | ${f(mean(v), 4).padStart(8)} (±${f(ci(v), 4)})      | ${f(median(v), 4).padStart(7)} | ${f((v.filter((x) => x > 0).length / v.length) * 100, 0).padStart(4)}%          | ${f(mean(r.map((x) => x.askIn)), 3)}`
    );
}
console.log('   → só conta se o PnL médio for positivo E o intervalo não incluir 0. As sondas estão correlacionadas entre moedas:');
console.log('     o intervalo real é mais largo do que o mostrado.\n');

// Quebras para o horizonte de 10 s
const H = 10;
const base10 = roundTrips(H);
if (base10.length >= 20) {
    console.log(`   Quebras (hold ${H}s):`);
    const groups = [
        ['moeda', (x) => x.p.coin],
        ['direção', (x) => x.p.direction],
        ['tempo restante', (x) => (x.p.secondsLeftAtTrigger < 300 ? '<300s' : x.p.secondsLeftAtTrigger < 600 ? '300-600s' : '>600s')],
        ['ask partida', (x) => (x.p.baselineAsk < 0.4 ? '<0.40' : x.p.baselineAsk < 0.6 ? '0.40-0.60' : '>0.60')],
        ['|movimento|', (x) => (Math.abs(x.p.changePct) < 0.08 ? '<0.08%' : Math.abs(x.p.changePct) < 0.15 ? '0.08-0.15%' : '>0.15%')]
    ];
    for (const [name, key] of groups) {
        const m = new Map();
        for (const x of base10) {
            const k = key(x);
            if (!m.has(k)) m.set(k, []);
            m.get(k).push(x.pnl);
        }
        const parts = [...m.entries()]
            .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
            .map(([k, v]) => `${k}: n=${v.length} ${f(mean(v), 4)}`);
        console.log(`     ${name}: ${parts.join(' | ')}`);
    }
    console.log('');
}

// ───────────── 3) Hold até à resolução (opcional) ─────────────
if (opts.outcomes) {
    console.log('3) HOLD ATÉ À RESOLUÇÃO (resultado de cada janela via Binance klines de 15 min: close >= open => Up)');
    console.log('   Atenção: usa a Binance como proxy da fonte de resolução do mercado, que pode ser outra.');

    const SYMBOL = { BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT' };
    const cache = new Map();

    async function outcomeUp(coin, startMs) {
        const key = `${coin}:${startMs}`;
        if (cache.has(key)) return cache.get(key);
        if (startMs + 15 * 60 * 1000 > Date.now()) return null; // janela ainda por fechar
        const url = `https://api.binance.com/api/v3/klines?symbol=${SYMBOL[coin]}&interval=15m&startTime=${startMs}&limit=1`;
        let res = null;
        try {
            const r = await fetch(url);
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const k = await r.json();
            if (Array.isArray(k) && k[0] && Number(k[0][0]) === startMs) {
                res = Number(k[0][4]) >= Number(k[0][1]); // close >= open
            }
        } catch (e) {
            if (!cache.has('__warned')) {
                console.log(`   ⚠️ falha a obter klines: ${e.message}`);
                cache.set('__warned', true);
            }
        }
        cache.set(key, res);
        return res;
    }

    const rows = [];
    for (const p of probes) {
        const parts = String(p.slug || '').split('-');
        const ts = Number(parts[parts.length - 1]);
        if (!isFinite(ts) || ts < 1.7e9) continue;
        const up = await outcomeUp(p.coin, ts * 1000);
        if (up === null) continue;
        const askIn = stepAt(p.series, opts.latency, 1);
        if (typeof askIn !== 'number') continue;
        const won = (p.direction === 'up') === up;
        rows.push({ p, askIn, won, pnl: (won ? 1 : 0) - askIn - opts.fee * askIn });
    }

    if (!rows.length) {
        console.log('   sem resultados (sem rede, janelas por fechar ou slugs sem timestamp).');
    } else {
        const v = rows.map((r) => r.pnl);
        const winRate = rows.filter((r) => r.won).length / rows.length;
        console.log(`   n=${rows.length} | taxa de acerto=${f(winRate * 100, 1)}% | ask de entrada médio=${f(mean(rows.map((r) => r.askIn)), 3)} | PnL médio/share=${f(mean(v), 4)} (±${f(ci(v), 4)})`);
        console.log('   Edge bruto = taxa de acerto − preço médio pago. Só faz sentido se for claramente positivo depois da fee.');
        const buckets = [
            ['ask partida <0.45', (r) => r.askIn < 0.45],
            ['0.45-0.55', (r) => r.askIn >= 0.45 && r.askIn < 0.55],
            ['>0.55', (r) => r.askIn >= 0.55]
        ];
        for (const [name, fn] of buckets) {
            const s = rows.filter(fn);
            if (s.length < 10) continue;
            console.log(`     ${name}: n=${s.length} acerto=${f((s.filter((r) => r.won).length / s.length) * 100, 1)}% ask médio=${f(mean(s.map((r) => r.askIn)), 3)} PnL=${f(mean(s.map((r) => r.pnl)), 4)}`);
        }
    }
    console.log('');
}
