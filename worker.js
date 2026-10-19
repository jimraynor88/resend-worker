// Cloudflare Worker · Proxy Resend para Tienda
// Variables de entorno (Secrets) en Cloudflare:
//   RESEND_API_KEY  → re_xxxxxxxxxxxxxxxx
//   FROM_EMAIL      → remitente verificado en Resend
//   SHARED_SECRET   → cadena larga aleatoria (32+ chars)
//   ALLOWED_ORIGIN  → dominio de la tienda (o * en pruebas)
// Sin KV, sin D1, sin R2. Rate limiting con Cache API nativa.

export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (request.method !== "POST") return j({ error: "Method not allowed" }, 405, cors);

    let body;
    try { body = await request.json(); }
    catch (e) { return j({ error: "JSON invalido" }, 400, cors); }

    if (!body.secret || body.secret !== env.SHARED_SECRET) {
      return j({ error: "Forbidden" }, 403, cors);
    }
    if (!body.to || !body.subject || !body.html) {
      return j({ error: "Faltan campos: to, subject, html" }, 400, cors);
    }

    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const dest = String(body.to).toLowerCase().slice(0, 200);
    const type = String(body.type || "default");
    const L = limits(type);

    if (!(await rateOk("ip:" + ip + ":" + type, L.ipMax, L.windowSec))) {
      return j({ error: "Demasiadas peticiones desde esta IP" }, 429, cors);
    }
    if (!(await rateOk("to:" + dest + ":" + type, L.destMax, L.windowSec))) {
      return j({ error: "Cooldown activo para ese email. Intenta mas tarde." }, 429, cors);
    }

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + env.RESEND_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: env.FROM_EMAIL,
        to: [dest],
        subject: String(body.subject).slice(0, 200),
        html: body.html,
      }),
    });

    const data = await res.json().catch(function(){ return {}; });
    if (!res.ok) return j({ error: data.message || "Error de Resend" }, 502, cors);
    return j({ ok: true, id: data.id }, 200, cors);
  }
};

function limits(type) {
  if (type === "order")    return { windowSec: 86400, destMax: 3,  ipMax: 10 };
  if (type === "recovery") return { windowSec: 3600,  destMax: 1,  ipMax: 5  };
  if (type === "welcome")  return { windowSec: 86400, destMax: 1,  ipMax: 5  };
  if (type === "composer") return { windowSec: 3600,  destMax: 3,  ipMax: 10 };
  if (type === "test")     return { windowSec: 3600,  destMax: 5,  ipMax: 10 };
  return { windowSec: 3600, destMax: 3, ipMax: 10 };
}

async function rateOk(key, max, windowSec) {
  try {
    const cache = caches.default;
    const bucket = Math.floor(Date.now() / 1000 / windowSec);
    const url = "https://rl.internal/" + encodeURIComponent(key) + "/" + bucket;
    const req = new Request(url);
    const cached = await cache.match(req);
    const n = cached ? parseInt(await cached.text()) || 0 : 0;
    if (n >= max) return false;
    await cache.put(req, new Response(String(n + 1), {
      headers: { "Cache-Control": "max-age=" + (windowSec * 2) }
    }));
    return true;
  } catch (e) {
    console.warn("rateOk fail-open:", e && e.message);
    return true;
  }
}

function j(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status: status,
    headers: Object.assign({}, cors, { "Content-Type": "application/json" })
  });
}