import { SmartMoneyTrade } from '../index.js';
import { BinanceService } from './binance-service.js';
import { MarketService } from './market-service.js';
import { TradingService } from './trading-service.js';

export interface DirectTradingServiceConfig {
    enabled: boolean;
    interval: string;         // ex: '15m'
    trendThreshold: number;   // ex: 0.3
    amount: number;           // ex: 5 (USDC)
    dryRun?: boolean;         // Flag para saber se simula ou executa a sério
    checkIntervalMs?: number; // ex: 5 * 60 * 1000
}

export type DirectTradingCallback = (trade: any, result: any) => Promise<void> | void;

export class DirectTradingService {
    private marketService: MarketService;
    private tradingService: TradingService;
    private binanceService: BinanceService;
    private timer: NodeJS.Timeout | null = null;

    constructor(
        tradingService: TradingService,
        marketService: MarketService,
        binanceService: BinanceService
    ) {
        this.tradingService = tradingService;
        this.marketService = marketService;
        this.binanceService = binanceService;
    }


    /**
     * Inicia o serviço de Direct Trading aceitando parâmetros de execução e o callback de sinal
     */
    public async startTradingLoop(
        config: DirectTradingServiceConfig,
        options: {
            onTrade: DirectTradingCallback;
        }
    ) {
        if (!config.enabled) {
            console.log('TREND', 'Serviço de Direct Trading está desativado na configuração.');
            return;
        }

        console.log('TREND', '🚀 A iniciar Direct Trading Service (Binance + Polymarket)...');

        const executeCheck = async () => {
            const coins: Array<'BTC' | 'ETH' | 'SOL'> = ['BTC', 'ETH', 'SOL'];

            for (const coin of coins) {
                try {
                    await this.analyzeAndExecuteCoin(coin, config, options.onTrade);
                } catch (err) {
                    console.log('ERROR', `❌ Erro no ciclo de tendência para ${coin}: ${(err as Error).message}`);
                }
            }
        };

        // Executa imediatamente e depois periodicamente
        await executeCheck();
        const intervalMs = config.checkIntervalMs || 5 * 60 * 1000;
        this.timer = setInterval(executeCheck, intervalMs);

        // Retorna o objeto com o método unsubscribe para destruir/parar a subscrição
        return {
            unsubscribe: () => {
                if (this.timer) {
                    clearInterval(this.timer);
                    this.timer = null;
                    console.log('TREND', '🛑 Direct Trading Service cancelado via unsubscribe.');
                }
            }
        };
    }

    public stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        console.log('TREND', '🛑 Direct Trading Service parado.');
    }

    private async analyzeAndExecuteCoin(
        coin: 'BTC' | 'ETH' | 'SOL',
        config: DirectTradingServiceConfig,
        onTrade: DirectTradingCallback
    ) {
        const symbolMap: Record<'BTC' | 'ETH' | 'SOL', any> = {
            BTC: 'BTCUSDT',
            ETH: 'ETHUSDT',
            SOL: 'SOLUSDT'
        };
        const symbol = symbolMap[coin];

        // 1. Obter klines da Binance
        const klines = await this.binanceService.getKLines(symbol, config.interval as any, { limit: 20 });
        if (!klines || klines.length < 10) {
            console.log('WARN', `⚠️ Klines insuficientes para ${symbol}: ${klines?.length ?? 0}`);
            return;
        }

        const recent = klines.slice(-5);
        const older = klines.slice(-10, -5);
        const recentAvg = recent.reduce((s, k) => s + k.close, 0) / recent.length;
        const olderAvg = older.reduce((s, k) => s + k.close, 0) / older.length;

        const changePercent = ((recentAvg - olderAvg) / olderAvg) * 100;
        const threshold = config.trendThreshold;

        let trend: 'up' | 'down' | 'neutral' = 'neutral';
        if (changePercent > threshold) trend = 'up';
        else if (changePercent < -threshold) trend = 'down';

        console.log('KLINE', `📊 [${symbol}] Variação: ${changePercent.toFixed(4)}% | Limiar: ±${threshold}% | Tendência: ${trend.toUpperCase()}`);

        if (trend === 'neutral') return;

        // 2. Encontrar mercado de curto prazo na Polymarket
        const markets = await this.marketService.scanCryptoShortTermMarkets({
            coin: coin,
            duration: '15m',
            minMinutesUntilEnd: 2,
            maxMinutesUntilEnd: 60,
            limit: 1,
            sortBy: 'endDate'
        });

        if (!markets || markets.length === 0) {
            console.log('WARN', `⚠️ Nenhum mercado de curto prazo encontrado na Polymarket para ${coin}`);
            return;
        }

        const market = markets[0];
        if (!market.conditionId) return;

        const fullMarket = await this.marketService.getMarket(market.conditionId);
        const yesToken = fullMarket.tokens.find((t: any) => t.outcome === 'Up' || t.outcome === 'Yes');
        const noToken = fullMarket.tokens.find((t: any) => t.outcome === 'Down' || t.outcome === 'No');
        const targetToken = trend === 'up' ? yesToken : noToken;

        if (!targetToken) {
            console.log('WARN', `⚠️ Token de destino ('${trend === 'up' ? 'Up/Yes' : 'Down/No'}') não encontrado para ${coin}`);
            return;
        }

        const amountUsdc = config.amount || 5;
        const execShares = amountUsdc / targetToken.price;

        const syntheticTrade: SmartMoneyTrade = {
            traderAddress: `TrendFollowing-${coin}`,
            marketSlug: market.slug,
            side: 'BUY',
            size: execShares,
            price: targetToken.price,
            tokenId: targetToken.tokenId,
            conditionId: market.conditionId,
            traderName: `Trend Bot (${coin})`,
            timestamp: Date.now(),
            isSmartMoney: false
        };

        const isDryRun = config.dryRun ?? false;

        if (isDryRun) {
            console.log('SIGNAL', `🧪 [DRY RUN] Direct Trade (${coin}): ${trend.toUpperCase()} em ${market.question?.slice(0, 30)}...`);
            await onTrade(syntheticTrade, { success: true });
        } else {
            console.log('SIGNAL', `🔴 Executando Direct Trade Real (${coin}): ${trend.toUpperCase()} em ${market.question?.slice(0, 30)}...`);

            try {
                const res = await this.tradingService.createMarketOrder({
                    tokenId: targetToken.tokenId,
                    side: 'BUY',
                    amount: amountUsdc
                });

                await onTrade(syntheticTrade, res);

                if (res && res.success) {
                    console.log('TRADE', `✅ Direct Trade Executado (${coin}): Compra de $${amountUsdc} em ${targetToken.outcome}`);
                } else {
                    console.log('WARN', `❌ Direct Trade falhou: ${res?.errorMsg || 'Erro desconhecido'}`);
                }
            } catch (orderErr) {
                console.log('ERROR', `❌ Erro crítico ao submeter ordem de Direct Trade: ${(orderErr as Error).message}`);
            }
        }
    }
}