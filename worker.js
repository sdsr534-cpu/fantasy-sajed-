const FPL_BASE = "https://fantasy.premierleague.com/api/";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept",
};

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    let path = url.pathname.replace(/^\/api\//, "").replace(/^\//, "");
    if (!path) {
      return new Response(
        JSON.stringify({ error: "missing path" }),
        { status: 400, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
      );
    }

    const targetUrl = FPL_BASE + path + url.search;

    const cache = caches.default;
    const cacheKey = new Request(targetUrl, request);
    let cached = await cache.match(cacheKey);
    if (cached) return cached;

    let upstream;
    try {
      upstream = await fetch(targetUrl, {
        headers: {
          "Accept": "application/json",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          "Accept-Language": "en-US,en;q=0.9",
          "Referer": "https://fantasy.premierleague.com/",
        },
        cf: {
          cacheTtl: 60,
          cacheEverything: true,
        },
      });
    } catch (err) {
      return new Response(
        JSON.stringify({ error: "upstream fetch failed", detail: String(err) }),
        { status: 502, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
      );
    }

    const body = await upstream.arrayBuffer();
    const response = new Response(body, {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("Content-Type") || "application/json",
        "Cache-Control": "public, max-age=60",
        ...CORS_HEADERS,
      },
    });

    if (upstream.status === 200) {
      await cache.put(cacheKey, response.clone());
    }

    return response;
  },
};
