import { BinanceWsFeed, BinanceWsFeedOptions } from "./binance-ws-feed";
import { DutchBookConfig, DutchBookObserver } from "./dutch-book-observer";
import { LagProbe, LagProbeConfig } from "./lag-probe";
import { MarketLike, MarketResolver } from "./polymarket-helpers";


export interface ObserversOptions {
    feed?: BinanceWsFeedOptions;
    dutchBook?: DutchBookConfig;
    lagProbe?: LagProbeConfig;
    enableDutchBook?: boolean; // default true
    enableLagProbe?: boolean;  // default true
}

/**
 * Liga os observadores (só leitura). Chama uma vez no arranque do bot:
 *
 *   const observers = startObservers(marketService);
 *   // ...
 *   observers.stop(); // no shutdown
 */
export function startObservers(marketService: MarketLike, opts: ObserversOptions = {}) {
    const feed = new BinanceWsFeed(opts.feed);
    const resolver = new MarketResolver(marketService);

    const dutch =
        opts.enableDutchBook === false
            ? null
            : new DutchBookObserver(resolver, {
                  spot: (coin) => feed.getPrice(coin),
                  ...(opts.dutchBook ?? {})
              });

    const lag = opts.enableLagProbe === false ? null : new LagProbe(feed, resolver, opts.lagProbe);

    feed.start();
    dutch?.start();
    lag?.start();

    return {
        feed,
        stop() {
            lag?.stop();
            dutch?.stop();
            feed.stop();
        }
    };
}
