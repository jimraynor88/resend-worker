# Worker Resend · Tienda

Proxy ligero en Cloudflare Workers que reenvía los emails transaccionales de tu tienda a Resend.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/TU_USUARIO/TU_REPO)

## Despliegue en 1 clic

Pulsa el botón de arriba. Cloudflare clonará este repositorio en tu cuenta, creará el Worker y te pedirá que configures las variables de entorno.

## Configuración manual (solo si el botón falla)

1.  Crea una cuenta gratuita en [Cloudflare](https://dash.cloudflare.com/sign-up).
2.  Ve a **Workers & Pages** → **Create** → **Create Worker**.
3.  Ponle un nombre (ej. `tienda-emails`) y pulsa **Deploy**.
4.  Pulsa **Edit code**. Borra todo y pega el contenido de `worker.js` (abajo).
5.  Vuelve a pulsar **Deploy**.

## Variables de entorno

En el panel del Worker, ve a **Settings** → **Variables and Secrets**. Añade estas cuatro:

| Nombre | Tipo | Valor | Obligatorio |
| :--- | :--- | :--- | :--- |
| `RESEND_API_KEY` | Secret | Tu API Key de Resend (`re_...`). | Sí |
| `FROM_EMAIL` | Text | Remitente verificado en Resend (ej. `tienda@tudominio.com`). | Sí |
| `SHARED_SECRET` | Secret | Cadena larga y aleatoria (mín. 32 caracteres). | Sí |
| `ALLOWED_ORIGIN` | Text | El dominio de tu tienda (ej. `https://tudominio.com`). | Sí |

> **Cómo generar `SHARED_SECRET`:** abre la consola del navegador (F12) y ejecuta

```javascript
crypto.randomUUID() + crypto.randomUUID()
```
Copia el resultado.

## Código del Worker (`worker.js`)

```javascript
// Cloudflare Worker · Proxy Resend para Tienda
// Variables de entorno requeridas: RESEND_API_KEY, FROM_EMAIL, SHARED_SECRET, ALLOWED_ORIGIN

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
```
## Problemas comunes

| Síntoma | Causa probable | Solución |
| :--- | :--- | :--- |
| `403 Forbidden` | El `SHARED_SECRET` no coincide. | Revisa que sea idéntico en Cloudflare y en el editor. |
| `502 Error de Resend` | `FROM_EMAIL` no está verificado. | Verifica el dominio en el panel de Resend. |
| `429 Cooldown activo` | Ya se envió un email a ese destinatario hace poco. | Espera o usa otro email de prueba. |
| No llega ningún email. | Los registros DNS (SPF/DKIM) están incompletos. | Revisa la configuración del dominio en Resend. |
