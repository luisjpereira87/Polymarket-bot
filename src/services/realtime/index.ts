/**
 * Realtime Module
 *
 * Custom WebSocket client for Polymarket real-time data.
 * Replaces @polymarket/real-time-data-client.
 *
 * @see https://docs.polymarket.com/developers/CLOB/websocket/wss-overview
 * @see https://docs.polymarket.com/developers/CLOB/websocket/market-channel
 * @see https://docs.polymarket.com/developers/CLOB/websocket/user-channel
 */

export { RealTimeDataClient } from './realtime-data-client.js';

// Connection & Configuration
export {
    ConnectionStatus,
    WS_ENDPOINTS,
    type ChannelType,
    type ClobApiKeyCreds,
    type RealTimeDataClientConfig,
    type RealTimeDataClientInterface
} from './types.js';

// Subscription Messages
export {
    type DynamicSubscription,
    type MarketSubscription,
    type SubscriptionMessage,
    type UserSubscription
} from './types.js';

// Message Wrapper
export {
    type CryptoPriceEventType, type MarketEventType, type Message, type UserEventType
} from './types.js';

// Market Channel Event Payloads
export {
    type BestBidAskEventPayload, type BookEventPayload, type LastTradePriceEventPayload, type MarketResolvedEventPayload, type NewMarketEventPayload, type PriceChangeEntry,
    type PriceChangeEventPayload, type RawOrderbookLevel, type TickSizeChangeEventPayload
} from './types.js';

// User Channel Event Payloads
export {
    type AssociatedTrade, type MakerOrder, type OrderEventPayload, type OrderEventType, type TradeEventPayload, type TradeStatus
} from './types.js';

// Crypto Price Event Payloads
export {
    type CryptoPriceEventPayload
} from './types.js';
