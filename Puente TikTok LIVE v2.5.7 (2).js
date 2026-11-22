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

// Configuración de puerto y clave de EulerStream desde variables de entorno en Render
const PORT = Number(process.env.PORT || 3000);
const EULERSTREAM_API_KEY = String(process.env.EULERSTREAM_API_KEY || "").trim();
if (EULERSTREAM_API_KEY && SignConfig) {
  SignConfig.apiKey = EULERSTREAM_API_KEY;
}

const app = express();
app.use(cors());

// Ruta de verificación de estado para "PROBAR RENDER"
app.get("/", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "Puente TikTok Live v2.5.7 activo",
    node: process.version,
    eulerKeyConfigured: Boolean(EULERSTREAM_API_KEY),
    webcastEvents: WebcastEvent || {},
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
        sendSafe({ event: "error", data: { message: "Falta EULERSTREAM_API_KEY en Render." } });
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
              : "Error TikTok/EulerStream: " + errMsg.slice(0, 180),
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
  console.log("Puente TikTok LIVE v2.5.7 escuchando en puerto " + PORT);
  console.log("EulerStream API Key configurada: " + Boolean(EULERSTREAM_API_KEY));
  console.log("WebcastEvent keys: " + Object.keys(WebcastEvent || {}).join(", "));
});