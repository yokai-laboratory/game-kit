import { TtgNodeClient } from "@titanium-games/sdk/node";

import { env } from "../env.js";

// The single Titanium Games SDK client for the whole API. `TtgNodeClient` carries the full server
// surface: user-bearer payment reads (limits / price / status), app-authority value moves (payout /
// distribute) which mint a `client_credentials` token internally, the OAuth code-exchange / refresh /
// userinfo back-channels, the presence handshake, and the `/oauth/payments/events` subscriber.
// `clientSecret` lives here only -- it never reaches the browser.
export const ttgClient = new TtgNodeClient({
    issuer: env.TTG_API_ORIGIN,
    clientId: env.OAUTH_CLIENT_ID,
    clientSecret: env.OAUTH_CLIENT_SECRET,
});
