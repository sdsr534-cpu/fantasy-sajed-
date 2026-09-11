addEventListener("fetch", (event) => {
  event.respondWith(handleRequest(event.request));
});

const FPL_BASE = "https://fantasy.premierleague.com/api/";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept",
};

async function handleRequest(request) {
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
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "upstream fetch failed", detail: String(err) }),
      { status: 502, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }

  const body = await upstream.arrayBuffer();
  return new Response(body, {
    status: upstream.status,
    headers: {
      "Content-Type": upstream.headers.get("Content-Type") || "application/json",
      "Cache-Control": "public, max-age=60",
      ...CORS_HEADERS,
    },
  });
}
