import { BinanceWsFeed, MoveEvent } from "./binance-ws-feed";
import { Coin, fetchBook, JsonlLogger, LOG_DIR, MarketResolver, sleep } from "./polymarket-helpers";


export interface LagProbeConfig {
    pollMs?: number;            // intervalo de polling do book durante a sonda (default 500 ms)
    durationMs?: number;        // duração máxima da sonda (default 90 s)
    thresholds?: number[];      // subidas do ask a cronometrar, em preço (default [0.02, 0.05, 0.10])
    minSecondsLeft?: number;    // não sonda se faltar menos do que isto (default 45 s)
    maxSecondsLeft?: number;    // nem se faltar mais do que isto (default 870 s: ignora o arranque da janela)
    maxBaselineAsk?: number;    // se o ask já estiver acima, o mercado está resolvido (default 0.95)
}

/**
 * Mede quanto tempo o mercado da Polymarket demora a reagir a um movimento forte da Binance.
 * SÓ LEITURA: não envia ordens.
 *
 * Quando o feed emite 'move', faz polling do book do token que deveria SUBIR (Up se o spot subiu,
 * Down se desceu) e regista quanto tempo o melhor ask demora a subir X cêntimos face ao nível inicial.
 *
 * Limitações a ter presentes:
 *  - O baseline é lido ~100-400 ms depois do gatilho (latência REST). Se o mercado reagir mais depressa
 *    do que isso, o atraso medido é um limite inferior e o baseline já terá parte do movimento.
 *  - A resolução temporal é a do polling (500 ms por defeito).
 */
export class LagProbe {
    private active = new Set<Coin>();
    private logger = new JsonlLogger(`${LOG_DIR}/lag-probe.jsonl`, 'LAGLOG');
    private pollMs: number;
    private durationMs: number;
    private thresholds: number[];
    private minSecondsLeft: number;
    private maxSecondsLeft: number;
    private maxBaselineAsk: number;

    private counters = { triggers: 0, probed: 0, skippedBusy: 0, skippedWindow: 0, skippedResolved: 0, errors: 0 };
    private lastHeartbeat = Date.now();
    private heartbeatTimer: NodeJS.Timeout | null = null;

    constructor(private feed: BinanceWsFeed, private resolver: MarketResolver, cfg: LagProbeConfig = {}) {
        this.pollMs = cfg.pollMs ?? 500;
        this.durationMs = cfg.durationMs ?? 90_000;
        this.thresholds = cfg.thresholds ?? [0.02, 0.05, 0.1];
        this.minSecondsLeft = cfg.minSecondsLeft ?? 45;
        this.maxSecondsLeft = cfg.maxSecondsLeft ?? 870;
        this.maxBaselineAsk = cfg.maxBaselineAsk ?? 0.95;
    }

    start() {
        this.feed.on('move', this.onMove);
        this.heartbeatTimer = setInterval(() => this.heartbeat(), 60_000);
        console.log('INFO', `⏱️ [lag-probe] ligada | poll ${this.pollMs}ms | duração ${this.durationMs / 1000}s | limiares ${this.thresholds.join('/')}`);
    }

    stop() {
        this.feed.off('move', this.onMove);
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
    }

    private onMove = (ev: MoveEvent) => {
        this.counters.triggers++;
        void this.probe(ev).catch((err) => {
            this.counters.errors++;
            console.log('WARN', `⚠️ [lag-probe] ${ev.coin}: ${(err as Error).message}`);
        });
    };

    private async probe(ev: MoveEvent) {
        const { coin } = ev;

        if (this.active.has(coin)) {
            this.counters.skippedBusy++;
            return;
        }

        const m = await this.resolver.get(coin);
        if (!m) return;

        const secondsLeft = (m.endMs - Date.now()) / 1000;
        if (secondsLeft < this.minSecondsLeft || secondsLeft > this.maxSecondsLeft) {
            this.counters.skippedWindow++;
            return;
        }

        this.active.add(coin);
        try {
            // O token que deveria SUBIR com este movimento
            const tokenId = ev.direction === 'up' ? m.upTokenId : m.downTokenId;

            const first = await fetchBook(tokenId);
            const baselineAsk = first.asks[0]?.price;
            if (baselineAsk === undefined || baselineAsk >= this.maxBaselineAsk) {
                this.counters.skippedResolved++;
                return;
            }
            const baselineBid = first.bids[0]?.price ?? null;
            const baselineDelayMs = Date.now() - ev.receivedAtMs;

            const crossed: Record<string, number | null> = {};
            for (const th of this.thresholds) crossed[`t${th.toFixed(2)}`] = null;

            const series: Array<[number, number | null, number | null]> = [
                [baselineDelayMs, baselineAsk, baselineBid]
            ];
            let lastAsk: number | null = baselineAsk;
            let lastBid: number | null = baselineBid;
            let maxDelta = 0;
            let finalAsk: number | null = baselineAsk;

            const deadline = ev.receivedAtMs + this.durationMs;
            const windowGuard = m.endMs - 5000;

            while (Date.now() < deadline && Date.now() < windowGuard) {
                await sleep(this.pollMs);
                let book;
                try {
                    book = await fetchBook(tokenId);
                } catch {
                    continue; // falha pontual: tenta outra vez no próximo ciclo
                }

                const dt = Date.now() - ev.receivedAtMs;
                const ask = book.asks[0]?.price ?? null;
                const bid = book.bids[0]?.price ?? null;
                finalAsk = ask;

                if (ask !== lastAsk || bid !== lastBid) {
                    series.push([dt, ask, bid]);
                    lastAsk = ask;
                    lastBid = bid;
                }

                if (ask !== null) {
                    const delta = ask - baselineAsk;
                    if (delta > maxDelta) maxDelta = delta;
                    for (const th of this.thresholds) {
                        const key = `t${th.toFixed(2)}`;
                        if (crossed[key] === null && delta >= th - 1e-9) crossed[key] = dt;
                    }
                }
            }

            this.counters.probed++;

            const row = {
                ts: new Date().toISOString(),
                type: 'lag',
                coin,
                slug: m.slug,
                direction: ev.direction,
                changePct: Number(ev.changePct.toFixed(4)),
                moveWindowMs: ev.windowMs,
                fromPrice: ev.fromPrice,
                toPrice: ev.toPrice,
                feedDelayMs: ev.receivedAtMs - ev.tradeTimeMs, // atraso Binance -> nós (inclui diferença de relógios)
                secondsLeftAtTrigger: Number(secondsLeft.toFixed(1)),
                baselineAsk,
                baselineBid,
                baselineDelayMs,
                crossedMs: crossed,   // ms desde o gatilho até o ask subir X (null = nunca subiu X)
                maxAskDelta: Number(maxDelta.toFixed(4)),
                finalAskDelta: finalAsk !== null ? Number((finalAsk - baselineAsk).toFixed(4)) : null,
                series                // [dtMs, ask, bid], só quando muda
            };

            await this.logger.write(row, true);
        } finally {
            this.active.delete(coin);
        }
    }

    private heartbeat() {
        const c = this.counters;
        console.log(
            'TREND',
            `💓 [lag-probe] gatilhos=${c.triggers} sondados=${c.probed} ocupado=${c.skippedBusy} foraJanela=${c.skippedWindow} resolvido=${c.skippedResolved} erros=${c.errors}`
        );
        this.counters = { triggers: 0, probed: 0, skippedBusy: 0, skippedWindow: 0, skippedResolved: 0, errors: 0 };
    }
}
