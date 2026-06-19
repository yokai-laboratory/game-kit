import { TronNodeClient } from "@metatron/sdk/node";

import { env } from "../env.js";

// The single Metatron SDK client for the whole API. `TronNodeClient` carries the full server
// surface: user-bearer payment reads (limits / price / status), app-authority value moves (payout /
// distribute) which mint a `client_credentials` token internally, the OAuth code-exchange / refresh /
// userinfo back-channels, the presence handshake, and the `/oauth/payments/events` subscriber.
// `clientSecret` lives here only -- it never reaches the browser.
export const tronClient = new TronNodeClient({
    issuer: env.TRON_API_ORIGIN,
    clientId: env.OAUTH_CLIENT_ID,
    clientSecret: env.OAUTH_CLIENT_SECRET,
});
