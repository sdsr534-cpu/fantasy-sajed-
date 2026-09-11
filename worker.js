// Sajed Fantasy — FPL API Proxy (Cloudflare Worker)
// Fixes: FPL blocks/403s requests that don't look like a real browser,
// which is why "entry/<id>/" (connecting a team) can fail depending on
// which Cloudflare edge location handles the request. Sending proper
// browser-like headers makes the proxy work from any country.

const FPL_BASE = "https://fantasy.premierleague.com/api/";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept",
  "Access-Control-Max-Age": "86400",
};

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // Accept both /api/<path> and /<path>
    let path = url.pathname.replace(/^\/api\//, "").replace(/^\//, "");
    if (!path) {
      return json({ error: "Missing API path" }, 400);
    }
    const target = FPL_BASE + path + url.search;

    // Try live fetch first, then fall back to cache on failure.
    const cache = caches.default;
    const cacheKey = new Request(target, { method: "GET" });

    try {
      const upstream = await fetch(target, {
        method: "GET",
        headers: {
          // These headers are what make requests succeed from every region —
          // FPL's edge protection blocks bare/no-UA requests in some countries.
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          "Accept": "application/json, text/plain, */*",
          "Accept-Language": "en-US,en;q=0.9,ar;q=0.8",
          "Referer": "https://fantasy.premierleague.com/",
          "Origin": "https://fantasy.premierleague.com",
        },
        cf: {
          cacheTtl: path.startsWith("bootstrap-static") || path.startsWith("fixtures") ? 60 : 15,
          cacheEverything: true,
        },
      });

      if (!upstream.ok) {
        // Try cache before giving up
        const cached = await cache.match(cacheKey);
        if (cached) return withCors(cached);
        return json({ error: "Upstream error " + upstream.status }, upstream.status);
      }

      const body = await upstream.text();
      const res = new Response(body, {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=15",
          ...CORS_HEADERS,
        },
      });
      // Store a copy for fallback use if FPL blocks a future request.
      ctxWaitUntil(cache.put(cacheKey, res.clone()));
      return res;
    } catch (err) {
      const cached = await cache.match(cacheKey);
      if (cached) return withCors(cached);
      return json({ error: "Proxy failure: " + err.message }, 502);
    }

    function ctxWaitUntil(p) {
      // no-op helper kept simple; Workers auto-await within fetch handler scope
      p.catch(() => {});
    }
  },
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function withCors(res) {
  const headers = new Headers(res.headers);
  Object.entries(CORS_HEADERS).forEach(([k, v]) => headers.set(k, v));
  return new Response(res.body, { status: res.status, headers });
}
