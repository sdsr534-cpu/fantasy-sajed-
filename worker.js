const FPL_BASE = "https://fantasy.premierleague.com/api/";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders,
    },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

    if (request.method !== "GET") {
      return json({ error: "Method not allowed" }, 405);
    }

    let path = url.pathname;

    if (path.startsWith("/api/")) {
      path = path.slice(5);
    } else {
      path = path.replace(/^\/+/, "");
    }

    if (!path) {
      return json({
        ok: true,
        service: "FPL API Proxy",
        message: "Worker is running",
      });
    }

    if (path.includes("://") || path.includes("..")) {
      return json({ error: "Invalid API path" }, 400);
    }

    const targetUrl = FPL_BASE + path + url.search;

    try {
      const response = await fetch(targetUrl, {
        method: "GET",
        headers: {
          "Accept": "application/json",
          "User-Agent": "Mozilla/5.0",
          "Accept-Language": "en-US,en;q=0.9",
          "Referer": "https://fantasy.premierleague.com/",
        },
      });

      const body = await response.text();

      if (!response.ok) {
        return json({
          error: "FPL upstream error",
          status: response.status,
          statusText: response.statusText,
          path: path,
          detail: body.slice(0, 1000),
        }, response.status);
      }

      return new Response(body, {
        status: 200,
        headers: {
          "Content-Type":
            response.headers.get("Content-Type") ||
            "application/json; charset=utf-8",
          ...corsHeaders,
        },
      });

    } catch (error) {
      return json({
        error: "upstream fetch failed",
        path: path,
        detail: error instanceof Error
          ? error.message
          : String(error),
      }, 502);
    }
  },
};
