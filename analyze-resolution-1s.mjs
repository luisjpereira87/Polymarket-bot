#!/usr/bin/env node
// Uso: node analyze-resolution-1s.mjs [--coin BTC] [--windows 200]
//
// Versão PRECISA do analyze-resolution.mjs: usa klines de 1 SEGUNDO da Binance para calcular os TWAP de 60 s
// (média dos 60 preços de 1 s) no início e no fim de cada janela de 15 min, em vez da aproximação por klines de 1 min.
// Compara depois cada regra candidata com o resultado OFICIAL (API Gamma).
//
//   A : close da janela >= open
//   C : TWAP60 no fim >= open
//   D : TWAP60 no fim >= TWAP60 dos 60 s ANTES do início   [ws-60s, ws)   <- o que os testes anteriores apontaram
//   D2: TWAP60 no fim >= TWAP60 centrado no início          [ws-30s, ws+30s)
//   E : TWAP60 no fim >= TWAP60 dos primeiros 60 s          [ws, ws+60s)
//
// Também mede quanto difere o "preço de referência" (TWAP60 antes do início) do open da janela, em pontos-base,
// e, nas janelas em que as regras A e D dão resposta diferente, qual delas coincide com o resultado oficial.
// Precisa de rede e Node 18+. NÃO envia ordens.
const args = process.argv.slice(2);
const opt = { coin: 'BTC', windows: 200 };
for (let i = 0; i < args.length; i++) {
    if (args[i] === '--coin') opt.coin = String(args[++i]).toUpperCase();
    else if (args[i] === '--windows') opt.windows = Number(args[++i]);
}
const SYMBOL = { BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT' };
if (!SYMBOL[opt.coin]) { console.log('--coin tem de ser BTC, ETH ou SOL'); process.exit(1); }
const WIN = 15 * 60_000, SEC = 1000, MIN = 60_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const f = (x, d = 1) => (x === null || x === undefined || !isFinite(x) ? '-' : Number(x).toFixed(d));

async function getJson(url, tries = 4) {
    for (let a = 0; a < tries; a++) {
        try {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 10_000);
            const r = await fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(timer));
            if (r.status === 429 || r.status >= 500) { await sleep(1500 * (a + 1)); continue; }
            if (!r.ok) return { error: `HTTP ${r.status}` };
            return { data: await r.json() };
        } catch (e) { await sleep(1000 * (a + 1)); }
    }
    return { error: 'falha de rede' };
}

// preços de 1 s entre [fromMs, fromMs + count s): devolve array de {t,o,c}
async function secondKlines(symbol, fromMs, count) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1s&startTime=${fromMs}&limit=${count}`;
    const r = await getJson(url);
    if (r.error || !Array.isArray(r.data)) return null;
    return r.data.map((x) => ({ t: Number(x[0]), o: Number(x[1]), c: Number(x[4]) }));
}
// TWAP de ~60 s = média de (open+close)/2 dos segundos disponíveis; exige pelo menos 55 dos 60
const twap = (ks) => (ks && ks.length >= 55 ? ks.reduce((s, k) => s + (k.o + k.c) / 2, 0) / ks.length : null);

let ruleText = null;
async function officialOutcome(coin, wsMs) {
    const slug = `${coin.toLowerCase()}-updown-15m-${wsMs / 1000}`;
    const r = await getJson(`https://gamma-api.polymarket.com/markets?slug=${slug}&closed=true`);
    if (r.error) return { error: r.error };
    const m = Array.isArray(r.data) ? r.data[0] : r.data;
    if (!m) return { error: 'sem mercado' };
    if (!ruleText && m.description) ruleText = String(m.description);
    try {
        const outcomes = typeof m.outcomes === 'string' ? JSON.parse(m.outcomes) : m.outcomes;
        const prices = (typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : m.outcomePrices).map(Number);
        const iUp = outcomes.findIndex((x) => /^(up|yes)$/i.test(String(x)));
        if (iUp < 0) return { error: 'sem outcome Up' };
        if (prices[iUp] >= 0.99 && prices[1 - iUp] <= 0.01) return { upWon: true };
        if (prices[iUp] <= 0.01 && prices[1 - iUp] >= 0.99) return { upWon: false };
        return { error: 'não resolvido' };
    } catch { return { error: 'formato inesperado' }; }
}

const lastWs = Math.floor((Date.now() - 45 * MIN) / WIN) * WIN;
const wsList = Array.from({ length: opt.windows }, (_, i) => lastWs - i * WIN);
console.log(`A processar ${wsList.length} janelas de ${opt.coin} (Gamma + klines de 1 s; 4 em paralelo)...`);

const samples = [];
const errs = new Map();
const addErr = (k) => errs.set(k, (errs.get(k) ?? 0) + 1);
const queue = [...wsList];
let done = 0;

await Promise.all(Array.from({ length: 4 }, async () => {
    while (queue.length) {
        const ws = queue.shift();
        try {
            const off = await officialOutcome(opt.coin, ws);
            if (off.error) { addErr(off.error); continue; }
            const end = ws + WIN;
            const [kStartPre, kStartCtr, kStartPost, kEnd] = await Promise.all([
                secondKlines(SYMBOL[opt.coin], ws - 60 * SEC, 60),
                secondKlines(SYMBOL[opt.coin], ws - 30 * SEC, 60),
                secondKlines(SYMBOL[opt.coin], ws, 60),
                secondKlines(SYMBOL[opt.coin], end - 60 * SEC, 60),
            ]);
            const open0 = kStartPost?.[0]?.o;
            const close15 = kEnd?.[kEnd.length - 1]?.c;
            const tPre = twap(kStartPre), tCtr = twap(kStartCtr), tPost = twap(kStartPost), tEnd = twap(kEnd);
            if (!open0 || !close15 || tPre === null || tCtr === null || tPost === null || tEnd === null) { addErr('sem klines de 1 s'); continue; }
            samples.push({
                ws, upWon: off.upWon,
                rules: {
                    'A : close da janela >= open': close15 >= open0,
                    'C : TWAP60 fim >= open': tEnd >= open0,
                    'D : TWAP60 fim >= TWAP60 antes do início': tEnd >= tPre,
                    'D2: TWAP60 fim >= TWAP60 centrado no início': tEnd >= tCtr,
                    'E : TWAP60 fim >= TWAP60 dos 1.os 60 s': tEnd >= tPost
                },
                refGapBps: ((tPre - open0) / open0) * 1e4
            });
        } catch (e) { addErr('erro'); }
        if (++done % 25 === 0 || done === wsList.length) console.log(`  ... ${done}/${wsList.length}`);
    }
}));

console.log(`\nJanelas comparáveis: ${samples.length} de ${wsList.length}` + (errs.size ? ` | descartadas: ${[...errs.entries()].map(([k, v]) => `${k}=${v}`).join(', ')}` : ''));
if (samples.length < 30) { console.log('Poucas janelas para tirar conclusões.'); process.exit(0); }
if (ruleText) console.log(`\nTexto das regras (1.º mercado):\n${ruleText.slice(0, 600)}\n`);

const names = Object.keys(samples[0].rules);
const stat = names.map((n) => {
    const ok = samples.filter((s) => s.rules[n] === s.upWon).length;
    return { n, ok, agree: ok / samples.length };
}).sort((a, b) => b.agree - a.agree);
console.log('Concordância com o resultado OFICIAL (TWAP de 60 s calculado com preços de 1 s):');
for (const s of stat) console.log(`   ${s.n.padEnd(46)} | ${f(s.agree * 100).padStart(5)}%  (${s.ok}/${samples.length})`);

// janelas em que A e D discordam: qual delas coincide com o oficial?
const kA = names.find((n) => n.startsWith('A')), kD = names.find((n) => n.startsWith('D :'));
const kC = names.find((n) => n.startsWith('C'));
function head2head(k1, k2, l1, l2) {
    const d = samples.filter((s) => s.rules[k1] !== s.rules[k2]);
    if (!d.length) return console.log(`   ${l1} vs ${l2}: as duas regras nunca discordaram.`);
    const w2 = d.filter((s) => s.rules[k2] === s.upWon).length;
    console.log(`   ${l1} vs ${l2}: discordam em ${d.length} janelas; o oficial deu razão a ${l2} em ${w2} (${f((w2 / d.length) * 100, 0)}%) e a ${l1} em ${d.length - w2}.`);
}
console.log('\nJanelas em que as regras dão resposta DIFERENTE (é aqui que se vê qual é a certa):');
head2head(kA, kD, 'A', 'D');
head2head(kC, kD, 'C', 'D');

const gaps = samples.map((s) => Math.abs(s.refGapBps)).sort((a, b) => a - b);
const q = (p) => gaps[Math.min(gaps.length - 1, Math.floor(p * gaps.length))];
console.log(`\nDiferença entre o preço de referência (TWAP60 antes do início) e o open da janela, em bps: mediana ${f(q(0.5), 2)} | p90 ${f(q(0.9), 2)} | máx ${f(gaps[gaps.length - 1], 2)}`);
console.log('Leitura:');
console.log(' - se D ficar claramente à frente (e ganhar os confrontos diretos com A e C), a referência do mercado é o TWAP dos 60 s anteriores ao início;');
console.log(' - a diferença referência − open é o erro que os modelos "close >= open" cometem no ponto de partida;');
console.log(' - nenhuma regra chega a 100%: a Binance (USDT) não é a Chainlink (USD).');
