import express from "express";
import cors from "cors";
import http from "http";
import { WebSocketServer } from "ws";
import {
  TikTokLiveConnection,
  WebcastEvent,
  ControlEvent,
  SignConfig,
} from "tiktok-live-connector";

// Configuración privada desde variables de entorno en Render (nunca se expone al navegador)
const PORT = Number(process.env.PORT || 3000);
const EULERSTREAM_API_KEY = String(process.env.EULERSTREAM_API_KEY || "").trim();
const TMDB_API_KEY = String(process.env.TMDB_API_KEY || "").trim();
const GEMINI_API_KEY = String(process.env.GEMINI_API_KEY || "").trim();
const SERPER_API_KEY = String(process.env.SERPER_API_KEY || "").trim();

if (EULERSTREAM_API_KEY && SignConfig) {
  SignConfig.apiKey = EULERSTREAM_API_KEY;
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// Filtro estricto para mantener títulos y perfiles 100% aptos para TikTok LIVE
const BLOCKED_WORDS =
  /\b(sex|sexy|erotic|porn|nude|naked|xxx|adult|breast|boobs|fetish|playboy|penthouse|escort|stripper|orgy|hentai)\b/i;

const isReadableLatin = (text = "") =>
  /^[A-Za-zÀ-ÖØ-öø-ÿ0-9\s.'’\-&:,!]+$/.test(String(text || "").trim());

const cleanWorkTitle = (title = "") => {
  const clean = String(title || "").trim();
  if (!clean || BLOCKED_WORDS.test(clean) || !isReadableLatin(clean)) {
    return "Cine y Televisión";
  }
  return clean;
};

// Ruta de verificación de estado sin exponer nombres ni claves internas
app.get("/", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "Puente TikTok Live v2.7.0 activo",
    node: process.version,
    liveReady: Boolean(EULERSTREAM_API_KEY),
    catalogReady: Boolean(TMDB_API_KEY),
    visionReady: Boolean(GEMINI_API_KEY),
    searchReady: Boolean(SERPER_API_KEY),
  });
});

// Proxy de imágenes con cabeceras compatibles con el CDN de TikTok
app.get("/img", async (req, res) => {
  try {
    const rawUrl = String(req.query.url || "").trim();
    if (!rawUrl.startsWith("http")) {
      return res.status(400).send("URL invalida");
    }
    const response = await fetch(rawUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        Referer: "https://www.tiktok.com/",
      },
    });
    if (!response.ok) {
      return res.status(response.status).send("Error imagen");
    }
    const contentType = response.headers.get("content-type") || "image/jpeg";
    const arrayBuffer = await response.arrayBuffer();
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=3600");
    return res.send(Buffer.from(arrayBuffer));
  } catch (err) {
    return res.status(502).send("Error descargando imagen");
  }
});

// Caché en memoria para avatares HD (evita repetir peticiones al mismo usuario)
const hdAvatarCache = new Map();

/**
 * Intenta resolver la URL del avatar en alta definición (720px / 1080px)
 * leyendo los metadatos públicos del perfil de TikTok.
 */
const resolveTikTokHdAvatar = async (uniqueId) => {
  const clean = String(uniqueId || "").trim().replace(/^@/, "");
  if (!clean) return "";

  const cached = hdAvatarCache.get(clean);
  if (cached && Date.now() - cached.ts < 30 * 60 * 1000) {
    return cached.url;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2400);
  try {
    const res = await fetch(`https://www.tiktok.com/@${encodeURIComponent(clean)}`, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
      },
    });
    if (!res.ok) throw new Error("status " + res.status);
    const html = await res.text();

    // Extraer avatarLarger (720x720 / 1080x1080) o avatarMedium del JSON embebido del perfil
    const match =
      html.match(/"avatarLarger"\s*:\s*"(https?:[^"]+)"/) ||
      html.match(/"avatarMedium"\s*:\s*"(https?:[^"]+)"/);

    const foundUrl = match
      ? match[1].replace(/\\u002F/gi, "/").replace(/\\u0026/gi, "&").replace(/\\\//g, "/")
      : "";

    hdAvatarCache.set(clean, { url: foundUrl, ts: Date.now() });
    if (hdAvatarCache.size > 300) {
      const firstKey = hdAvatarCache.keys().next().value;
      hdAvatarCache.delete(firstKey);
    }
    return foundUrl;
  } catch (e) {
    hdAvatarCache.set(clean, { url: "", ts: Date.now() });
    return "";
  } finally {
    clearTimeout(timer);
  }
};

// Endpoint que intenta descargar la foto HD real del usuario y, si no está disponible, usa la miniatura normal
app.get("/hd-avatar", async (req, res) => {
  const user = String(req.query.user || "").trim().replace(/^@/, "");
  const fallback = String(req.query.fallback || "").trim();

  const tryFetchImage = async (targetUrl) => {
    if (!targetUrl || !targetUrl.startsWith("http")) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(targetUrl, {
        signal: controller.signal,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
          Referer: "https://www.tiktok.com/",
        },
      });
      if (!response.ok) return null;
      const contentType = response.headers.get("content-type") || "image/jpeg";
      const buf = Buffer.from(await response.arrayBuffer());
      if (buf.length < 400) return null;
      return { contentType, buf };
    } catch (e) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    let quality = "thumb";
    let result = null;

    if (user) {
      const hdUrl = await resolveTikTokHdAvatar(user);
      if (hdUrl) {
        result = await tryFetchImage(hdUrl);
        if (result) quality = "hd";
      }
    }

    if (!result && fallback) {
      result = await tryFetchImage(fallback);
    }

    if (!result) {
      return res.status(502).send("No se pudo descargar el avatar");
    }

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Expose-Headers", "X-Avatar-Quality");
    res.setHeader("X-Avatar-Quality", quality);
    res.setHeader("Content-Type", result.contentType);
    res.setHeader("Cache-Control", "public, max-age=3600");
    return res.send(result.buf);
  } catch (err) {
    return res.status(502).send("Error descargando avatar");
  }
});

// =========================================================================
// GEMINI VISIÓN + SERPER IMÁGENES (100% PRIVADO EN RENDER)
// =========================================================================

// Analiza una foto (por base64 o URL) con Gemini Vision
app.post("/api/vision", async (req, res) => {
  if (!GEMINI_API_KEY) {
    return res.status(500).json({ ok: false, error: "GEMINI_API_KEY no configurada" });
  }

  try {
    let {
      imageBase64 = "",
      imageUrl = "",
      mimeType = "image/jpeg",
      prompt = "Analiza la foto y describe de forma breve: género aparente, pose, expresión, si usa lentes, celular u otros objetos o animales visibles.",
    } = req.body || {};

    if (!imageBase64 && imageUrl && String(imageUrl).startsWith("http")) {
      const imgResp = await fetch(imageUrl, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
          Referer: "https://www.tiktok.com/",
        },
      });
      if (!imgResp.ok) {
        return res.status(400).json({ ok: false, error: "No se pudo descargar imageUrl" });
      }
      mimeType = imgResp.headers.get("content-type") || mimeType;
      const buf = Buffer.from(await imgResp.arrayBuffer());
      imageBase64 = buf.toString("base64");
    }

    const cleanBase64 = String(imageBase64 || "").replace(/^data:image\/\w+;base64,/, "");
    if (!cleanBase64) {
      return res.status(400).json({ ok: false, error: "Falta imageBase64 o imageUrl" });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const gResp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(
          GEMINI_API_KEY
        )}`,
        {
          method: "POST",
          signal: controller.signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [
              {
                parts: [
                  { text: String(prompt) },
                  { inline_data: { mime_type: mimeType, data: cleanBase64 } },
                ],
              },
            ],
          }),
        }
      );

      const gData = await gResp.json();
      if (!gResp.ok) {
        return res.status(gResp.status).json({
          ok: false,
          error: gData?.error?.message || "Error consultando Gemini",
        });
      }

      const text = gData?.candidates?.[0]?.content?.parts?.[0]?.text || "";
      return res.status(200).json({ ok: true, result: text });
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// Busca fotos reales en Serper por pose, lentes, celular, objetos o animales
app.post("/api/serper-images", async (req, res) => {
  if (!SERPER_API_KEY) {
    return res.status(500).json({ ok: false, error: "SERPER_API_KEY no configurada" });
  }

  try {
    const query = String(req.body?.query || req.body?.q || "").trim();
    const num = Math.max(1, Math.min(20, Number(req.body?.num || 10)));
    if (!query) {
      return res.status(400).json({ ok: false, error: "Falta query" });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const sResp = await fetch("https://google.serper.dev/images", {
        method: "POST",
        signal: controller.signal,
        headers: {
          "X-API-KEY": SERPER_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ q: query, gl: "pe", hl: "es", num }),
      });

      const sData = await sResp.json();
      if (!sResp.ok) {
        return res.status(sResp.status).json({
          ok: false,
          error: sData?.message || "Error consultando Serper",
        });
      }

      const images = (sData?.images || [])
        .filter((img) => {
          const title = String(img?.title || "");
          const url = String(img?.imageUrl || "");
          return url.startsWith("http") && !BLOCKED_WORDS.test(title) && !BLOCKED_WORDS.test(url);
        })
        .map((img) => ({
          title: String(img.title || ""),
          imageUrl: String(img.imageUrl || ""),
          thumbnailUrl: String(img.thumbnailUrl || img.imageUrl || ""),
          source: String(img.source || ""),
          link: String(img.link || ""),
        }));

      return res.status(200).json({ ok: true, images });
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// =========================================================================
// CATÁLOGO PRIVADO Y GALERÍA DE POSES (SE EJECUTA 100% EN SERVIDOR RENDER)
// =========================================================================
let catalogStarsCache = { ts: 0, items: [] };
const catalogPhotosCache = new Map();
const CATALOG_CACHE_TTL = 6 * 60 * 60 * 1000; // 6 horas

// Obtiene el catálogo principal de actores y actrices filtrados (sin exponer credenciales)
app.get("/catalog/stars", async (req, res) => {
  if (!TMDB_API_KEY) {
    return res.status(200).json({ ok: false, items: [] });
  }

  const maxPages = Math.max(1, Math.min(10, Number(req.query.pages || 8)));
  if (
    catalogStarsCache.items.length > 0 &&
    Date.now() - catalogStarsCache.ts < CATALOG_CACHE_TTL
  ) {
    return res.status(200).json({ ok: true, items: catalogStarsCache.items });
  }

  try {
    const seen = new Set();
    const items = [];

    for (let page = 1; page <= maxPages; page++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 6000);
      try {
        const resp = await fetch(
          `https://api.themoviedb.org/3/person/popular?api_key=${encodeURIComponent(
            TMDB_API_KEY
          )}&language=es-MX&page=${page}`,
          { signal: controller.signal }
        );
        if (!resp.ok) break;
        const data = await resp.json();

        for (const p of data?.results || []) {
          if (!p?.id || !p?.profile_path || !p?.name || p.adult) continue;
          if (p.known_for_department && p.known_for_department !== "Acting") continue;
          if (p.gender !== 1 && p.gender !== 2) continue;

          const cleanName = String(p.name).trim();
          if (!isReadableLatin(cleanName) || BLOCKED_WORDS.test(cleanName)) continue;
          if (seen.has(p.id)) continue;

          const works = Array.isArray(p.known_for) ? p.known_for : [];
          if (works.some((w) => w?.adult)) continue;
          const mainWork = works.find((w) => w?.title || w?.name);

          seen.add(p.id);
          items.push({
            id: `cat-${p.id}`,
            catalogId: p.id,
            name: cleanName,
            movie: cleanWorkTitle(mainWork?.title || mainWork?.name || ""),
            gender: p.gender === 1 ? "female" : "male",
            thumb: `https://image.tmdb.org/t/p/w300${p.profile_path}`,
            img: `https://image.tmdb.org/t/p/w780${p.profile_path}`,
          });
        }
      } catch (e) {
        break;
      } finally {
        clearTimeout(timer);
      }
    }

    if (items.length > 0) {
      catalogStarsCache = { ts: Date.now(), items };
    }
    return res.status(200).json({ ok: items.length > 0, items });
  } catch (err) {
    return res.status(200).json({ ok: false, items: [] });
  }
});

// Obtiene múltiples fotos reales de un actor/actriz para elegir la pose y encuadre más parecidos
app.get("/catalog/photos", async (req, res) => {
  if (!TMDB_API_KEY) {
    return res.status(200).json({ ok: false, photos: [] });
  }

  let personId = Number(req.query.id || 0);
  const starName = String(req.query.name || "").trim();
  const cacheKey = personId > 0 ? `id:${personId}` : `name:${starName.toLowerCase()}`;

  const cached = catalogPhotosCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CATALOG_CACHE_TTL) {
    return res.status(200).json({ ok: true, photos: cached.photos });
  }

  try {
    // Si vino del catálogo secundario por nombre, resolvemos su ficha privada para traer su galería
    if (!personId && starName) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4500);
      try {
        const sResp = await fetch(
          `https://api.themoviedb.org/3/search/person?api_key=${encodeURIComponent(
            TMDB_API_KEY
          )}&include_adult=false&language=es-MX&query=${encodeURIComponent(starName)}`,
          { signal: controller.signal }
        );
        if (sResp.ok) {
          const sData = await sResp.json();
          const match = (sData?.results || []).find(
            (r) => !r.adult && r.profile_path && (!r.known_for_department || r.known_for_department === "Acting")
          );
          if (match?.id) personId = Number(match.id);
        }
      } catch (e) {
      } finally {
        clearTimeout(timer);
      }
    }

    if (!personId) {
      catalogPhotosCache.set(cacheKey, { ts: Date.now(), photos: [] });
      return res.status(200).json({ ok: false, photos: [] });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    let photos = [];
    try {
      const imgResp = await fetch(
        `https://api.themoviedb.org/3/person/${personId}/images?api_key=${encodeURIComponent(
          TMDB_API_KEY
        )}`,
        { signal: controller.signal }
      );
      if (imgResp.ok) {
        const imgData = await imgResp.json();
        photos = (imgData?.profiles || [])
          .filter((p) => p?.file_path)
          .slice(0, 12)
          .map((p) => ({
            url: `https://image.tmdb.org/t/p/w780${p.file_path}`,
            width: Number(p.width || 0),
            height: Number(p.height || 0),
          }));
      }
    } catch (e) {
    } finally {
      clearTimeout(timer);
    }

    catalogPhotosCache.set(cacheKey, { ts: Date.now(), photos });
    if (catalogPhotosCache.size > 400) {
      const firstKey = catalogPhotosCache.keys().next().value;
      catalogPhotosCache.delete(firstKey);
    }

    return res.status(200).json({ ok: photos.length > 0, photos });
  } catch (err) {
    return res.status(200).json({ ok: false, photos: [] });
  }
});

// Funciones auxiliares para normalizar campos de eventos de TikTok LIVE
const getAvatarUrl = (data) => {
  const candidates = [
    data?.user?.avatarLarger?.url?.[0],
    data?.user?.avatarLarger?.urlList?.[0],
    data?.user?.avatarMedium?.url?.[0],
    data?.user?.avatarMedium?.urlList?.[0],
    data?.user?.profilePicture?.url?.[0],
    data?.user?.profilePicture?.urls?.[0],
    data?.user?.profilePictureUrl,
    data?.user?.avatarThumb?.url?.[0],
    data?.user?.avatarThumb?.urlList?.[0],
    data?.userDetails?.profilePictureUrls?.[0],
    data?.profilePicture?.url?.[0],
    data?.profilePicture?.urls?.[0],
    data?.profilePictureUrl,
    data?.avatarUrl,
  ];
  for (const u of candidates) {
    if (typeof u === "string" && u.startsWith("http")) {
      return u;
    }
  }
  return "";
};

const getUniqueId = (data) => {
  const val =
    data?.user?.uniqueId ||
    data?.user?.displayId ||
    data?.uniqueId ||
    data?.user?.username ||
    data?.username ||
    "";
  return String(val).trim();
};

const getNickname = (data) => {
  const val =
    data?.user?.nickname ||
    data?.nickname ||
    data?.userDetails?.nickname ||
    getUniqueId(data);
  return String(val).trim();
};

// Servidor HTTP + WebSocket para transmitir comentarios y regalos al frontend
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  let tiktokConn = null;
  let currentUser = "";

  const sendSafe = (payload) => {
    if (ws.readyState === ws.OPEN) {
      try {
        ws.send(JSON.stringify(payload));
      } catch (e) {}
    }
  };

  const cleanupTikTok = () => {
    if (tiktokConn) {
      try {
        tiktokConn.removeAllListeners();
        tiktokConn.disconnect();
      } catch (e) {}
      tiktokConn = null;
    }
  };

  ws.on("message", async (rawMsg) => {
    let msg;
    try {
      msg = JSON.parse(rawMsg.toString());
    } catch (e) {
      return;
    }

    if (msg?.action === "ping") {
      sendSafe({ event: "pong" });
      return;
    }

    if (msg?.action === "connect") {
      const cleanUser = String(msg.uniqueId || "").trim().replace(/^@/, "");
      if (!cleanUser) {
        sendSafe({ event: "error", data: { message: "Falta el usuario de TikTok." } });
        return;
      }
      if (!EULERSTREAM_API_KEY) {
        sendSafe({ event: "error", data: { message: "Falta configurar la clave de conexión LIVE en el servidor." } });
        return;
      }

      cleanupTikTok();
      currentUser = cleanUser;

      const conn = new TikTokLiveConnection(cleanUser, {
        signApiKey: EULERSTREAM_API_KEY,
        processInitialData: true,
        enableExtendedGiftInfo: false,
        fetchRoomInfoOnConnect: true,
        requestOptions: { timeout: 15000 },
      });
      tiktokConn = conn;

      const seenEventIds = new Set();
      const isDuplicate = (data) => {
        const msgId = data?.common?.msgId || data?.msgId;
        if (!msgId) return false;
        const key = String(msgId);
        if (seenEventIds.has(key)) return true;
        seenEventIds.add(key);
        if (seenEventIds.size > 500) {
          const first = seenEventIds.values().next().value;
          seenEventIds.delete(first);
        }
        return false;
      };

      const onChatHandler = (data) => {
        if (tiktokConn !== conn) return;
        if (isDuplicate(data)) return;
        const uniqueId = getUniqueId(data);
        if (!uniqueId) return;
        const avatar = getAvatarUrl(data);
        const commentText = String(data?.comment || data?.content || data?.text || "").trim();
        console.log("[CHAT @" + cleanUser + "] @" + uniqueId + ": " + commentText + " | avatar=" + Boolean(avatar));
        sendSafe({
          event: "chat",
          data: {
            uniqueId,
            nickname: getNickname(data),
            profilePictureUrl: avatar,
            comment: commentText,
          },
        });
      };

      const onGiftHandler = (data) => {
        if (tiktokConn !== conn) return;
        if (isDuplicate(data)) return;
        const uniqueId = getUniqueId(data);
        if (!uniqueId) return;
        const avatar = getAvatarUrl(data);
        const giftName = String(
          data?.giftDetails?.giftName || data?.extendedGiftInfo?.name || data?.giftName || "Regalo"
        );
        const diamondCount = Number(
          data?.giftDetails?.diamondCount || data?.extendedGiftInfo?.diamond_count || data?.diamondCount || 1
        );
        const giftPictureUrl = String(
          data?.giftDetails?.giftImage?.url?.[0] ||
            data?.extendedGiftInfo?.image?.url_list?.[0] ||
            data?.giftPictureUrl ||
            ""
        );
        console.log("[GIFT @" + cleanUser + "] @" + uniqueId + " -> " + giftName + " x" + (data?.repeatCount || 1));
        sendSafe({
          event: "gift",
          data: {
            uniqueId,
            nickname: getNickname(data),
            profilePictureUrl: avatar,
            giftId: data?.giftId || 0,
            giftName,
            giftPictureUrl,
            diamondCount,
            repeatCount: Number(data?.repeatCount || 1),
            repeatEnd: Boolean(data?.repeatEnd),
            groupId: data?.groupId ? String(data.groupId) : "",
          },
        });
      };

      const chatEvents = new Set([WebcastEvent?.CHAT, "chat", "WebcastChatMessage"].filter(Boolean));
      chatEvents.forEach((ev) => conn.on(ev, onChatHandler));

      const giftEvents = new Set([WebcastEvent?.GIFT, "gift", "WebcastGiftMessage"].filter(Boolean));
      giftEvents.forEach((ev) => conn.on(ev, onGiftHandler));

      let debugPacketsSent = 0;
      const rawEventNames = new Set([WebcastEvent?.RAW_DATA, "rawData", "websocketMessage"].filter(Boolean));
      rawEventNames.forEach((ev) => {
        conn.on(ev, (packet) => {
          if (tiktokConn !== conn) return;
          const type = String(packet?.type || packet?.method || packet?.messageType || "unknown");
          const payload = packet?.data || packet?.decodedData || packet;
          if (debugPacketsSent < 6) {
            debugPacketsSent += 1;
            const keys = payload && typeof payload === "object" ? Object.keys(payload).slice(0, 8).join(",") : "";
            console.log("[RAW @" + cleanUser + "] type=" + type + " keys=" + keys);
            sendSafe({ event: "debug", data: { message: "RAW: " + type + " (" + keys + ")" } });
          }
          if (/ChatMessage/i.test(type) && payload) {
            onChatHandler(payload);
          } else if (/GiftMessage/i.test(type) && payload) {
            onGiftHandler(payload);
          }
        });
      });

      conn.on(ControlEvent.STREAM_END, () => {
        if (tiktokConn !== conn) return;
        sendSafe({ event: "streamEnd", data: { uniqueId: currentUser } });
      });

      conn.on(ControlEvent.DISCONNECTED, () => {
        if (tiktokConn !== conn) return;
        sendSafe({ event: "disconnected", data: { message: "TikTok cerro la conexion del LIVE." } });
      });

      conn.on(ControlEvent.ERROR, (err) => {
        if (tiktokConn !== conn) return;
        const rawErr = err?.info || err?.message || String(err || "Error de conexion");
        const errText = String(rawErr);
        if (/fetch room gifts/i.test(errText)) return;
        console.log("[ERROR @" + cleanUser + "] " + errText);
        sendSafe({ event: "error", data: { message: errText.slice(0, 180) } });
      });

      try {
        console.log("[CONNECT] Intentando conectar a @" + cleanUser + "...");
        const state = await conn.connect();
        if (tiktokConn !== conn) return;
        console.log("[CONNECTED] @" + cleanUser + " roomId=" + (state?.roomId || "?"));
        sendSafe({
          event: "connected",
          data: { uniqueId: cleanUser, roomId: state?.roomId || "" },
        });
      } catch (err) {
        if (tiktokConn !== conn) return;
        const errName = String(err?.name || "");
        const errMsg = String(err?.message || err || "Error desconocido");
        console.log("[CONNECT FAIL @" + cleanUser + "] " + errName + ": " + errMsg);
        const isOffline = errName.includes("UserOffline") || /offline|isn't online|not live/i.test(errMsg);
        sendSafe({
          event: "error",
          data: {
            message: isOffline
              ? "@" + cleanUser + " no esta en LIVE en este momento."
              : "Error de conexión LIVE: " + errMsg.slice(0, 180),
          },
        });
      }
    }
  });

  ws.on("close", () => {
    cleanupTikTok();
  });
});

server.listen(PORT, () => {
  console.log("Puente TikTok LIVE v2.7.0 escuchando en puerto " + PORT);
  console.log("Conexión LIVE configurada: " + Boolean(EULERSTREAM_API_KEY));
  console.log("Catálogo extendido privado configurado: " + Boolean(TMDB_API_KEY));
  console.log("Gemini Visión configurada: " + Boolean(GEMINI_API_KEY));
  console.log("Serper Imágenes configurado: " + Boolean(SERPER_API_KEY));
});