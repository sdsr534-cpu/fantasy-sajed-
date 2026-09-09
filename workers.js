const FPL_API = "https://fantasy.premierleague.com/api/";

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // CORS
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Accept"
        }
      });
    }

    // GET فقط
    if (request.method !== "GET") {
      return new Response(
        JSON.stringify({ error: "Method not allowed" }),
        {
          status: 405,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*"
          }
        }
      );
    }

    // اختبار الـWorker
    if (url.pathname === "/") {
      return new Response(
        "SAJED FPL API Proxy is running ✅",
        {
          status: 200,
          headers: {
            "Content-Type": "text/plain; charset=UTF-8",
            "Access-Control-Allow-Origin": "*"
          }
        }
      );
    }

    // لازم يبدأ المسار بـ /api/
    if (!url.pathname.startsWith("/api/")) {
      return new Response(
        JSON.stringify({ error: "Route not found" }),
        {
          status: 404,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*"
          }
        }
      );
    }

    // إزالة /api/
    const path = url.pathname.slice("/api/".length);

    // إنشاء رابط FPL API
    const targetUrl = FPL_API + path + url.search;

    try {
      const response = await fetch(targetUrl, {
        method: "GET",
        headers: {
          "Accept": "application/json",
          "User-Agent": "SAJED-Fantasy/1.0"
        }
      });

      const body = await response.text();

      return new Response(body, {
        status: response.status,
        headers: {
          "Content-Type":
            response.headers.get("content-type") ||
            "application/json",

          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Accept",

          "Cache-Control": "no-store"
        }
      });

    } catch (error) {
      return new Response(
        JSON.stringify({
          error: true,
          message: "Could not connect to the FPL API"
        }),
        {
          status: 502,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*"
          }
        }
      );
    }
  }
};
