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

const PORT = process.env.PORT || 3000;
const EULERSTREAM_API_KEY = (process.env.EULERSTREAM_API_KEY || "").trim();

// Configurar la API Key gratuita de EulerStream (requerida por tiktok-live-connector v2.5+)
if (EULERSTREAM_API_KEY && SignConfig) {
  SignConfig.apiKey = EULERSTREAM_API_KEY;
}

const app = express();
app.use(cors());

// Ruta principal de salud para despertar Render y verificar configuración
app.get("/", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "Puente TikTok Live v2.5 activo",
    node: process.version,
    eulerKeyConfigured: Boolean(EULERSTREAM_API_KEY),
  });
});

// Proxy seguro de fotos de perfil de TikTok para que face-api.js pueda escanearlas sin bloqueo CORS
app.get("/img", async (req, res) => {
  try {
    const rawUrl = String(req.query.url || "").trim();
    if (!rawUrl || !/^https?:\/\//i.test(rawUrl)) {
      return res.status(400).send("URL inválida");
    }

    const response = await fetch(rawUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        Referer: "https://www.tiktok.com/",
      },
    });

    if (!response.ok) {
      return res.status(response.status).send("No se pudo descargar la imagen");
    }

    const contentType = response.headers.get("content-type") || "image/jpeg";
    const arrayBuffer = await response.arrayBuffer();

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=3600");
    return res.send(Buffer.from(arrayBuffer));
  } catch (err) {
    return res.status(502).send("Error descargando imagen de TikTok");
  }
});

// Funciones auxiliares para extraer datos en formato v2 y legacy
const getAvatarUrl = (data) => {
  const candidates = [
    data?.user?.profilePicture?.url?.[0],
    data?.user?.profilePicture?.urls?.[0],
    data?.user?.profilePictureUrl,
    data?.user?.avatarThumb?.urlList?.[0],
    data?.profilePictureUrl,
    data?.avatarUrl,
  ];
  return candidates.find((u) => typeof u === "string" && u.startsWith("http")) || "";
};

const getUniqueId = (data) => {
  return String(data?.user?.uniqueId || data?.uniqueId || "").trim();
};

const getNickname = (data) => {
  return String(
    data?.user?.nickname || data?.nickname || getUniqueId(data)
  ).trim();
};

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
      const cleanUser = String(msg.uniqueId || "")
        .trim()
        .replace(/^@/, "");

      if (!cleanUser) {
        sendSafe({
          event: "error",
          data: { message: "Falta el nombre de usuario de TikTok." },
        });
        return;
      }

      if (!EULERSTREAM_API_KEY) {
        sendSafe({
          event: "error",
          data: {
            message:
              "Falta configurar EULERSTREAM_API_KEY en Render (Variables de entorno). Crea tu clave gratis en eulerstream.com.",
          },
        });
        return;
      }

      cleanupTikTok();
      currentUser = cleanUser;

      const options = {
        signApiKey: EULERSTREAM_API_KEY,
        processInitialData: false,
        enableExtendedGiftInfo: true,
        fetchRoomInfoOnConnect: true,
      };

      const conn = new TikTokLiveConnection(cleanUser, options);
      tiktokConn = conn;

      // Comentarios del LIVE en tiempo real
      conn.on(WebcastEvent.CHAT, (data) => {
        if (tiktokConn !== conn) return;
        const uniqueId = getUniqueId(data);
        if (!uniqueId) return;

        sendSafe({
          event: "chat",
          data: {
            uniqueId,
            nickname: getNickname(data),
            profilePictureUrl: getAvatarUrl(data),
            comment: String(data?.comment || "").trim(),
          },
        });
      });

      // Regalos del LIVE en tiempo real
      conn.on(WebcastEvent.GIFT, (data) => {
        if (tiktokConn !== conn) return;
        const uniqueId = getUniqueId(data);
        if (!uniqueId) return;

        const giftName =
          data?.giftDetails?.giftName ||
          data?.extendedGiftInfo?.name ||
          data?.giftName ||
          "Regalo";

        const diamondCount = Number(
          data?.giftDetails?.diamondCount ||
            data?.extendedGiftInfo?.diamond_count ||
            data?.diamondCount ||
            1
        );

        const giftPictureUrl =
          data?.giftDetails?.giftImage?.url?.[0] ||
          data?.extendedGiftInfo?.image?.url_list?.[0] ||
          data?.giftPictureUrl ||
          "";

        sendSafe({
          event: "gift",
          data: {
            uniqueId,
            nickname: getNickname(data),
            profilePictureUrl: getAvatarUrl(data),
            giftId: data?.giftId || 0,
            giftName,
            giftPictureUrl,
            diamondCount,
            repeatCount: Number(data?.repeatCount || 1),
            repeatEnd: Boolean(data?.repeatEnd),
            groupId: data?.groupId ? String(data.groupId) : "",
          },
        });
      });

      // Fin de transmisión
      conn.on(ControlEvent.STREAM_END, () => {
        if (tiktokConn !== conn) return;
        sendSafe({ event: "streamEnd", data: { uniqueId: currentUser } });
      });

      // Desconexión inesperada
      conn.on(ControlEvent.DISCONNECTED, () => {
        if (tiktokConn !== conn) return;
        sendSafe({
          event: "disconnected",
          data: { message: "TikTok cerró la conexión del LIVE." },
        });
      });

      // Errores en tiempo real
      conn.on(ControlEvent.ERROR, (err) => {
        if (tiktokConn !== conn) return;
        const rawErr = err?.info || err?.message || String(err || "Error de conexión");
        sendSafe({
          event: "error",
          data: { message: String(rawErr).slice(0, 180) },
        });
      });

      try {
        const state = await conn.connect();
        if (tiktokConn !== conn) return;
        sendSafe({
          event: "connected",
          data: {
            uniqueId: cleanUser,
            roomId: state?.roomId || "",
          },
        });
      } catch (err) {
        if (tiktokConn !== conn) return;
        const errName = String(err?.name || "");
        const errMsg = String(err?.message || err || "Error desconocido");
        const isOffline =
          errName.includes("UserOffline") ||
          /offline|isn't online|not live/i.test(errMsg);

        sendSafe({
          event: "error",
          data: {
            message: isOffline
              ? `@${cleanUser} no está en LIVE en este momento.`
              : `Error TikTok/EulerStream: ${errMsg.slice(0, 180)}`,
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
  console.log(`Puente TikTok LIVE v2.5 escuchando en puerto ${PORT}`);
  console.log(`EulerStream API Key configurada: ${Boolean(EULERSTREAM_API_KEY)}`);
});
