const FPL_BASE = "https://fantasy.premierleague.com/api/";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept",
  "Access-Control-Max-Age": "86400",
};

const BOOTSTRAP_TTL = 60;
const DEFAULT_TTL = 15;

export async function onRequest(context) {
  const { request, params, waitUntil } = context;
  const method = request.method.toUpperCase();

  if (method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: CORS_HEADERS,
    });
  }

  if (method !== "GET" && method !== "HEAD") {
    return json({ error: "Method not allowed" }, 405);
  }

  const parts = Array.isArray(params.path)
    ? params.path
    : (params.path ? [params.path] : []);

  const path = parts.join("/").replace(/^\/+|\/+$/g, "");

  if (!path) {
    return json({
      ok: true,
      service: "SAJED Fantasy FPL API"
    });
  }

  const incomingUrl = new URL(request.url);
  const target = FPL_BASE + path + incomingUrl.search;

  const cache = caches.default;
  const cacheKey = new Request(target, {
    method: "GET"
  });

  const ttl =
    path.startsWith("bootstrap-static") ||
    path.startsWith("fixtures")
      ? BOOTSTRAP_TTL
      : DEFAULT_TTL;

  try {
    const upstream = await fetch(target, {
      method: "GET",

      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",

        "Accept":
          "application/json, text/plain, */*",

        "Accept-Language":
          "en-US,en;q=0.9,ar;q=0.8",

        "Referer":
          "https://fantasy.premierleague.com/",

        "Origin":
          "https://fantasy.premierleague.com",
      },

      cf: {
        cacheTtl: ttl,
        cacheEverything: true,
      },
    });

    if (!upstream.ok) {
      const cached = await cache.match(cacheKey);

      if (cached) {
        return withCors(cached, {
          "X-SAJED-API": "cache-fallback",
        });
      }

      return json(
        {
          error: "FPL upstream error",
          status: upstream.status,
          message:
            "The Fantasy Premier League API did not return a successful response.",
        },
        upstream.status
      );
    }

    const body = await upstream.text();

    const response = new Response(body, {
      status: 200,

      headers: {
        "Content-Type":
          "application/json; charset=UTF-8",

        "Cache-Control":
          `public, max-age=${ttl}, s-maxage=${ttl}`,

        ...CORS_HEADERS,

        "X-SAJED-API": "live",
      },
    });

    waitUntil(
      cache.put(cacheKey, response.clone())
    );

    return response;

  } catch (error) {

    try {
      const cached = await cache.match(cacheKey);

      if (cached) {
        return withCors(cached, {
          "X-SAJED-API": "cache-fallback",
        });
      }

    } catch (_) {}

    return json(
      {
        error: "Proxy failure",
        message:
          "Could not reach the Fantasy Premier League API from Cloudflare.",
      },
      502
    );
  }
}

function json(data, status = 200) {
  return new Response(
    JSON.stringify(data),
    {
      status,

      headers: {
        "Content-Type":
          "application/json; charset=UTF-8",

        ...CORS_HEADERS,
      },
    }
  );
}

function withCors(response, extraHeaders = {}) {

  const headers =
    new Headers(response.headers);

  for (
    const [key, value]
    of Object.entries(CORS_HEADERS)
  ) {
    headers.set(key, value);
  }

  for (
    const [key, value]
    of Object.entries(extraHeaders)
  ) {
    headers.set(key, value);
  }

  return new Response(
    response.body,
    {
      status: response.status,
      statusText: response.statusText,
      headers,
    }
  );
      }
