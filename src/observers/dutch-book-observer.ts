import {
    Coin,
    COINS,
    JsonlLogger,
    LOG_DIR,
    MarketResolver,
    fetchBook,
    vwapForShares
} from './polymarket-helpers.js';

export interface DutchBookConfig {
    pollMs?: number;          // intervalo entre ciclos (default 3000)
    sizes?: number[];         // tamanhos (em shares) a simular (default [5, 20, 50])
    feePct?: number;          // fee estimada sobre o valor de cada perna (default 0.0156, PLACEHOLDER)
    sampleEveryMs?: number;   // amostragem das linhas "normais" por moeda (default 30 s)
    minSecondsLeft?: number;  // ignora os últimos segundos da janela (default 10)
    oppThrottleMs?: number;   // máx. 1 linha de "opportunity" por moeda neste intervalo (default 5 s)
    spot?: (coin: Coin) => number | null; // opcional: preço spot atual (Binance) para contexto
    /** opcional: preço de abertura da janela (Binance). Permite registar o deslocamento da vela em bps. */
    open?: (coin: Coin, startMs: number) => number | null | Promise<number | null>;
}

interface SizeResult {
    shares: number;
    vwapUp: number;
    vwapDown: number;
    complete: boolean;
    sum: number;
    gross: number;
    net: number;
}

/**
 * Observa se askUp + askDown < 1 (Dutch book). SÓ LEITURA: não envia ordens.
 *
 * Comprar 1 share Up e 1 share Down custa (askUp + askDown) e paga sempre 1 na resolução.
 * Se o custo (incluindo fees) for < 1 e as duas pernas encherem, o lucro é independente da direção.
 * Atenção: no mundo real as duas pernas não enchem em simultâneo, e é aí que está o risco.
 */
export class DutchBookObserver {
    private timer: NodeJS.Timeout | null = null;
    private running = false;
    private stopped = true;
    private logger = new JsonlLogger(`${LOG_DIR}/dutch-book.jsonl`, 'DUTCHLOG');
    private lastSample = new Map<Coin, number>();
    private lastOpp = new Map<Coin, number>();
    private oppThrottleMs: number;

    private pollMs: number;
    private sizes: number[];
    private feePct: number;
    private sampleEveryMs: number;
    private minSecondsLeft: number;

    // contadores desde o último heartbeat
    private stats = this.freshStats();
    private lastHeartbeat = Date.now();

    constructor(private resolver: MarketResolver, private cfg: DutchBookConfig = {}) {
        this.pollMs = cfg.pollMs ?? 3000;
        this.sizes = cfg.sizes ?? [5, 20, 50];
        this.feePct = cfg.feePct ?? 0.0156;
        this.sampleEveryMs = cfg.sampleEveryMs ?? 30_000;
        this.minSecondsLeft = cfg.minSecondsLeft ?? 10;
        this.oppThrottleMs = cfg.oppThrottleMs ?? 5000;
    }

    private freshStats() {
        return {
            polls: 0,
            noMarket: 0,
            noAsks: 0,
            errors: 0,
            sumAsksMin: Infinity,
            sumAsksTotal: 0,
            sumBelowOne: 0,       // soma dos melhores asks < 1 (sem fees, sem profundidade)
            netPositive: new Map<number, number>() // tamanho -> nº de vezes com net > 0 e perna completa
        };
    }

    start() {
        if (!this.stopped) return;
        this.stopped = false;
        console.log(
            'INFO',
            `🔎 [dutch-book] observador ligado | poll ${this.pollMs}ms | tamanhos ${this.sizes.join('/')} shares | fee estimada ${(this.feePct * 100).toFixed(2)}% (CONFIRMA)`
        );
        const tick = async () => {
            if (this.stopped) return;
            if (!this.running) {
                this.running = true;
                try {
                    await Promise.all(COINS.map((c) => this.evaluate(c).catch((e) => this.onError(c, e))));
                    this.heartbeat();
                } finally {
                    this.running = false;
                }
            }
            if (!this.stopped) this.timer = setTimeout(tick, this.pollMs);
        };
        this.timer = setTimeout(tick, 0);
    }

    stop() {
        this.stopped = true;
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
    }

    private onError(coin: Coin, err: unknown) {
        this.stats.errors++;
        // Mostra só o primeiro erro de cada tipo por heartbeat, para não encher a consola
        if (this.stats.errors <= 3) {
            console.log('WARN', `⚠️ [dutch-book] ${coin}: ${(err as Error).message}`);
        }
    }

    private async evaluate(coin: Coin) {
        const now = Date.now();
        const m = await this.resolver.get(coin);
        if (!m) {
            this.stats.noMarket++;
            return;
        }

        const secondsLeft = (m.endMs - now) / 1000;
        if (secondsLeft < this.minSecondsLeft) return;

        const [up, down] = await Promise.all([fetchBook(m.upTokenId), fetchBook(m.downTokenId)]);
        this.stats.polls++;

        const bestAskUp = up.asks[0];
        const bestAskDown = down.asks[0];
        if (!bestAskUp || !bestAskDown) {
            this.stats.noAsks++;
            return;
        }

        const sumAsks = bestAskUp.price + bestAskDown.price;
        this.stats.sumAsksMin = Math.min(this.stats.sumAsksMin, sumAsks);
        this.stats.sumAsksTotal += sumAsks;
        if (sumAsks < 1) this.stats.sumBelowOne++;

        const results: SizeResult[] = this.sizes.map((shares) => {
            const vu = vwapForShares(up.asks, shares);
            const vd = vwapForShares(down.asks, shares);
            const complete = vu.complete && vd.complete;
            const sum = vu.avgPrice + vd.avgPrice;
            const gross = 1 - sum;
            const net = gross - this.feePct * sum; // fee conservadora: % do valor de cada perna
            return {
                shares,
                vwapUp: Number(vu.avgPrice.toFixed(4)),
                vwapDown: Number(vd.avgPrice.toFixed(4)),
                complete,
                sum: Number(sum.toFixed(4)),
                gross: Number(gross.toFixed(4)),
                net: Number(net.toFixed(4))
            };
        });

        const opportunity = results.filter((r) => r.complete && r.net > 0);
        for (const r of opportunity) {
            this.stats.netPositive.set(r.shares, (this.stats.netPositive.get(r.shares) ?? 0) + 1);
        }

        const spotNow = this.cfg.spot ? this.cfg.spot(coin) : null;
        let openPx: number | null = null;
        try {
            openPx = this.cfg.open ? await this.cfg.open(coin, m.startMs) : null;
        } catch {
            openPx = null;
        }
        const dispBps = spotNow !== null && openPx ? ((spotNow - openPx) / openPx) * 1e4 : null;

        const bidUp = up.bids[0]?.price ?? null;
        const bidDown = down.bids[0]?.price ?? null;

        const row = {
            ts: new Date(now).toISOString(),
            type: opportunity.length > 0 ? 'opportunity' : 'sample',
            coin,
            slug: m.slug,
            secondsLeft: Number(secondsLeft.toFixed(1)),
            askUp: bestAskUp.price,
            askDown: bestAskDown.price,
            sumAsks: Number(sumAsks.toFixed(4)),
            depthAskUp: bestAskUp.size,
            depthAskDown: bestAskDown.size,
            bidUp,
            bidDown,
            sumBids: bidUp !== null && bidDown !== null ? Number((bidUp + bidDown).toFixed(4)) : null,
            sizes: results,
            spot: spotNow,
            open: openPx,
            dispBps: dispBps !== null ? Number(dispBps.toFixed(3)) : null,
            bookLatencyMs: Math.max(up.latencyMs, down.latencyMs)
        };

        if (opportunity.length > 0) {
            // Oportunidades (net > 0 com as duas pernas completas): registadas + stdout,
            // mas no máximo 1 linha por moeda a cada oppThrottleMs (uma oportunidade persistente
            // não deve encher os logs). Os contadores do heartbeat contam todas.
            if (now - (this.lastOpp.get(coin) ?? 0) >= this.oppThrottleMs) {
                this.lastOpp.set(coin, now);
                await this.logger.write(row, true);
                console.log(
                    'SIGNAL',
                    `💡 [dutch-book] ${coin} soma=${sumAsks.toFixed(3)} | melhor net=${Math.max(...opportunity.map((o) => o.net)).toFixed(4)}/share | faltam ${secondsLeft.toFixed(0)}s`
                );
            }
        } else if (now - (this.lastSample.get(coin) ?? 0) >= this.sampleEveryMs) {
            this.lastSample.set(coin, now);
            await this.logger.write(row, false);
        }
    }

    private heartbeat() {
        const now = Date.now();
        if (now - this.lastHeartbeat < 60_000) return;
        this.lastHeartbeat = now;

        const s = this.stats;
        const avg = s.polls - s.noAsks > 0 ? s.sumAsksTotal / (s.polls - s.noAsks) : NaN;
        const net = this.sizes.map((z) => `${z}sh=${s.netPositive.get(z) ?? 0}`).join(' ');
        console.log(
            'TREND',
            `💓 [dutch-book] polls=${s.polls} semMercado=${s.noMarket} semAsks=${s.noAsks} erros=${s.errors} | soma asks: min=${isFinite(s.sumAsksMin) ? s.sumAsksMin.toFixed(3) : '-'} média=${isFinite(avg) ? avg.toFixed(3) : '-'} | <1: ${s.sumBelowOne} | net>0 (perna completa): ${net}`
        );
        this.stats = this.freshStats();
    }
}
