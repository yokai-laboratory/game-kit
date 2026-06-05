import Redis from "ioredis";
import { env } from "./env.js";

// Redis is the fan-out backbone that makes the API tier horizontally scalable: WebSocket clients
// for one room may be connected to different replicas, so room updates are published to Redis and
// every replica relays them to its own local sockets (see core/realtime/hub.ts). It's also a handy
// place for short-lived caches and idempotency markers.
//
// A pub/sub SUBSCRIBE connection can't run normal commands, so the realtime hub gets its own
// dedicated subscriber via createRedisSubscriber(); this default client is for everything else.
export const redis = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    lazyConnect: false,
});

export function createRedisSubscriber(): Redis {
    return new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
}

export async function pingRedis(): Promise<boolean> {
    try {
        return (await redis.ping()) === "PONG";
    } catch {
        return false;
    }
}
