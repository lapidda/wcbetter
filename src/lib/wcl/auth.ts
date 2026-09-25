const TOKEN_URL = "https://www.warcraftlogs.com/oauth/token";

interface TokenResponse {
  access_token: string;
  expires_in: number;
}

let cachedToken: { value: string; expiresAt: number } | null = null;

/**
 * Client-credentials flow. The token is process-wide and lives ~1 year, but we
 * refresh a minute early anyway rather than trusting the clock.
 */
export async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.value;

  const id = process.env.WCL_CLIENT_ID;
  const secret = process.env.WCL_CLIENT_SECRET;
  if (!id || !secret) {
    throw new Error(
      "WCL_CLIENT_ID / WCL_CLIENT_SECRET are not set. Create a client at " +
        "https://www.warcraftlogs.com/api/clients/ and copy .env.example to .env.local.",
    );
  }

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
    },
    body: new URLSearchParams({ grant_type: "client_credentials" }),
  });

  if (!res.ok) {
    throw new Error(`WCL token request failed (${res.status}): ${await res.text()}`);
  }

  const json = (await res.json()) as TokenResponse;
  cachedToken = {
    value: json.access_token,
    expiresAt: Date.now() + (json.expires_in - 60) * 1000,
  };
  return cachedToken.value;
}
