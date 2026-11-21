import http from "http";
import { WebSocketServer } from "ws";
import { TikTokLiveConnection, WebcastEvent, ControlEvent } from "tiktok-live-connector";

const PORT = process.env.PORT || 3000;

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.url && req.url.startsWith("/img?url=")) {
    try {
      const targetUrl = decodeURIComponent(req.url.slice("/img?url=".length));
      const imgRes = await fetch(targetUrl, {
        headers: { "User-Agent": "Mozilla/5.0" }
      });
      const buf = Buffer.from(await imgRes.arrayBuffer());
      res.writeHead(200, {
        "Content-Type": imgRes.headers.get("content-type") || "image/jpeg",
        "Cache-Control": "public, max-age=3600"
      });
      return res.end(buf);
    } catch (e) {
      res.writeHead(502);
      return res.end("Error cargando imagen");
    }
  }

  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Puente TikTok Live activo");
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  let tiktokConn = null;

  const cleanup = () => {
    if (tiktokConn) {
      try { tiktokConn.disconnect(); } catch (e) {}
      tiktokConn = null;
    }
  };

  ws.on("message", async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.action === "connect" && msg.uniqueId) {
        cleanup();
        const uniqueId = String(msg.uniqueId).replace(/^@/, "").trim();
        tiktokConn = new TikTokLiveConnection(uniqueId, {
          processInitialData: false,
          enableExtendedGiftInfo: true
        });

        tiktokConn.on(WebcastEvent.GIFT, (data) => {
          if (ws.readyState !== 1) return;
          const user = data.user || {};
          const giftInfo = data.extendedGiftInfo || data.giftDetails || {};
          const profilePic =
            data.profilePictureUrl ||
            user.profilePictureUrl ||
            user.profilePicture?.url?.[0] ||
            "";
          const giftPic =
            data.giftPictureUrl ||
            giftInfo.giftPictureUrl ||
            giftInfo.icon?.url?.[0] ||
            giftInfo.image?.url?.[0] ||
            "";

          ws.send(JSON.stringify({
            event: "gift",
            data: {
              uniqueId: data.uniqueId || user.uniqueId || "",
              nickname: data.nickname || user.nickname || data.uniqueId || user.uniqueId || "",
              profilePictureUrl: profilePic,
              giftId: data.giftId || giftInfo.id || "",
              giftName: data.giftName || giftInfo.name || giftInfo.giftName || "Regalo",
              giftPictureUrl: giftPic,
              diamondCount: data.diamondCount || giftInfo.diamond_count || giftInfo.diamondCount || 1,
              repeatCount: data.repeatCount || 1,
              repeatEnd: Boolean(data.repeatEnd),
              groupId: String(data.groupId || "")
            }
          }));
        });

        tiktokConn.on(ControlEvent.STREAM_END, () => {
          if (ws.readyState === 1) ws.send(JSON.stringify({ event: "streamEnd" }));
        });

        await tiktokConn.connect();
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ event: "connected", data: { uniqueId } }));
        }
      }
    } catch (err) {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({
          event: "error",
          message: "Esperando a que inicies el LIVE en TikTok..."
        }));
      }
    }
  });

  ws.on("close", cleanup);
});

server.listen(PORT, () => console.log(`Puente TikTok Live listo en puerto ${PORT}`));
