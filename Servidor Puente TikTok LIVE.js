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

const PORT = Number(process.env.PORT || 3000);
const EULERSTREAM_API_KEY = String(process.env.EULERSTREAM_API_KEY || "").trim();
const TMDB_API_KEY = String(process.env.TMDB_API_KEY || "").trim();
const GEMINI_API_KEY = String(process.env.GEMINI_API_KEY || "").trim();
const SERPER_API_KEY = String(process.env.SERPER_API_KEY || "").trim();
const GEMINI_MODEL = String(process.env.GEMINI_MODEL || "gemini-2.5-flash").trim();

if (EULERSTREAM_API_KEY && SignConfig) {
  SignConfig.apiKey = EULERSTREAM_API_KEY;
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "6mb" }));

const BLOCKED_WORDS =
  /\b(sex|sexy|erotic|porn|nude|naked|xxx|adult|breast|boobs|fetish|playboy|penthouse|escort|stripper|orgy|hentai)\b/i;

const isReadableLatin = (text = "") =>
  /^[A-Za-zÀ-ÖØ-öø-ÿ0-9\s.'’\-&:,!()]+$/.test(String(text || "").trim());

const cleanWorkTitle = (title = "") => {
  const clean = String(title || "").trim();
  if (!clean || BLOCKED_WORDS.test(clean) || !isReadableLatin(clean)) {
    return "Cine y TV";
  }
  return clean;
};

const normalizeGender = (val = "", fallback = "male") => {
  const g = String(val || "").trim().toLowerCase();
  if (["female", "mujer", "femenino", "girl", "woman", "actriz"].includes(g)) {
    return "female";
  }
  if (["male", "hombre", "masculino", "boy", "man", "actor"].includes(g)) {
    return "male";
  }
  return fallback;
};

const normalizeLifeStage = (val = "") => {
  const s = String(val || "").trim().toLowerCase();
  if (["child", "kid", "niño", "nino", "niña", "nina", "infantil", "bebe", "bebé"].includes(s)) {
    return "child";
  }
  if (["teen", "young", "joven", "adolescente"].includes(s)) {
    return "young";
  }
  return "adult";
};

const getGenderLabel = (gender) => (gender === "female" ? "Mujer" : "Hombre");
const getRoleLabel = (gender, lifeStage) => {
  if (lifeStage === "child") {
    return gender === "female" ? "NIÑA • INFANTIL" : "NIÑO • INFANTIL";
  }
  return gender === "female" ? "ACTRIZ" : "ACTOR";
};

app.get("/", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "Puente TikTok Live activo (Género y Etapa de Vida estrictos)",
    node: process.version,
    liveReady: Boolean(EULERSTREAM_API_KEY),
    visionReady: Boolean(GEMINI_API_KEY),
    imagesReady: Boolean(SERPER_API_KEY),
    catalogReady: Boolean(TMDB_API_KEY),
    matchReady: Boolean(GEMINI_API_KEY && (SERPER_API_KEY || TMDB_API_KEY)),
  });
});

app.get("/img", async (req, res) => {
  try {
    const rawUrl = String(req.query.url || "").trim();
    if (!rawUrl.startsWith("http")) {
      return res.status(400).send("URL invalida");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6500);
    try {
      const response = await fetch(rawUrl, {
        signal: controller.signal,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
          Referer: rawUrl.includes("tiktok") ? "https://www.tiktok.com/" : "https://www.google.com/",
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
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    return res.status(502).send("Error descargando imagen");
  }
});

const hdAvatarCache = new Map();

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

const fetchImageBuffer = async (targetUrl, timeoutMs = 5000) => {
  if (!targetUrl || !targetUrl.startsWith("http")) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(targetUrl, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        Referer: targetUrl.includes("tiktok") ? "https://www.tiktok.com/" : "https://www.google.com/",
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

app.get("/hd-avatar", async (req, res) => {
  const user = String(req.query.user || "").trim().replace(/^@/, "");
  const fallback = String(req.query.fallback || "").trim();

  try {
    let quality = "thumb";
    let result = null;

    if (user) {
      const hdUrl = await resolveTikTokHdAvatar(user);
      if (hdUrl) {
        result = await fetchImageBuffer(hdUrl, 4500);
        if (result) quality = "hd";
      }
    }

    if (!result && fallback) {
      result = await fetchImageBuffer(fallback, 4500);
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

const userTop5Cache = new Map();
const serperQueryCache = new Map();
const recentGlobalActors = [];

const USER_CACHE_TTL = 45 * 60 * 1000;
const IMAGE_CACHE_TTL = 12 * 60 * 60 * 1000;

const recordGlobalActor = (name) => {
  const key = String(name || "").trim().toLowerCase();
  if (!key) return;
  const idx = recentGlobalActors.indexOf(key);
  if (idx !== -1) recentGlobalActors.splice(idx, 1);
  recentGlobalActors.unshift(key);
  if (recentGlobalActors.length > 5) recentGlobalActors.pop();
};

const extractImagePayload = async ({ imageBase64, avatarUrl, uniqueId }) => {
  if (imageBase64 && typeof imageBase64 === "string") {
    const dataUrlMatch = imageBase64.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (dataUrlMatch) {
      return { mimeType: dataUrlMatch[1], base64: dataUrlMatch[2] };
    }
    return { mimeType: "image/jpeg", base64: imageBase64.replace(/\s+/g, "") };
  }

  const cleanUser = String(uniqueId || "").trim().replace(/^@/, "");
  if (cleanUser) {
    const hdUrl = await resolveTikTokHdAvatar(cleanUser);
    if (hdUrl) {
      const hdImg = await fetchImageBuffer(hdUrl, 4000);
      if (hdImg) {
        return {
          mimeType: hdImg.contentType.split(";")[0] || "image/jpeg",
          base64: hdImg.buf.toString("base64"),
        };
      }
    }
  }

  if (avatarUrl && avatarUrl.startsWith("http")) {
    const fbImg = await fetchImageBuffer(avatarUrl, 4500);
    if (fbImg) {
      return {
        mimeType: fbImg.contentType.split(";")[0] || "image/jpeg",
        base64: fbImg.buf.toString("base64"),
      };
    }
  }

  return null;
};

const runGeminiVision = async ({ mimeType, base64 }) => {
  if (!GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY no configurada en Render");
  }

  const prompt = `Eres un analista visual de alta precisión para un juego en vivo de TikTok.
Analiza la foto del espectador y determina:
1. GÉNERO REAL ("male" o "female"):
   - Observa rostro, cejas, mandíbula, nariz, labios, cabello, estilo de vestir o manos/uñas si el rostro está parcial.
   - NUNCA asignes un actor hombre ("male") a una mujer ("female") ni una actriz mujer ("female") a un hombre ("male").
2. ETAPA DE VIDA / GENERACIÓN ("child", "young", "adult"):
   - "child": bebé, niño o niña pequeño (aprox. 0 a 12 años). Si el espectador es un niño o niña, TODOS los dobles deben ser personajes infantiles/niños o jóvenes muy acordes a su etapa, NUNCA adultos maduros.
   - "young": adolescente o joven adulto (aprox. 13 a 28 años).
   - "adult": adulto o adulto mayor (aprox. 29 años en adelante).
3. PARECIDO Y DETALLE:
   - Busca 5 dobles famosos del MISMO género ("male" o "female") y MISMA etapa de vida ("child", "young", "adult"), priorizando rasgos faciales y de generación.
   - Si el espectador es "child", incluye en "searchQuery" términos infantiles/juveniles (ej. "child actor" o personaje infantil famoso acorde a su edad y género).

Responde ÚNICAMENTE con este JSON válido:
{
  "gender": "female",
  "lifeStage": "young",
  "poseLabel": "Selfie • Rostro IA",
  "matches": [
    {
      "name": "Nombre Real o Personaje",
      "gender": "female",
      "lifeStage": "young",
      "work": "Película o Serie",
      "searchQuery": "Nombre retrato",
      "similarity": 88,
      "faceScore": 90,
      "eyesScore": 87,
      "mouthScore": 86
    }
  ]
}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7500);
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      GEMINI_MODEL
    )}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;

    const resp = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: prompt },
              { inline_data: { mime_type: mimeType || "image/jpeg", data: base64 } },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.25,
          maxOutputTokens: 900,
          responseMimeType: "application/json",
        },
      }),
    });

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => "");
      throw new Error(`Vision HTTP ${resp.status}: ${errBody.slice(0, 120)}`);
    }

    const data = await resp.json();
    const rawText =
      data?.candidates?.[0]?.content?.parts?.map((p) => p?.text || "").join("") || "";
    const cleaned = rawText.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
    const parsed = JSON.parse(cleaned);

    if (!Array.isArray(parsed?.matches) || parsed.matches.length === 0) {
      throw new Error("Respuesta de visión sin coincidencias");
    }

    const userGender = normalizeGender(parsed.gender, "male");
    const userLifeStage = normalizeLifeStage(parsed.lifeStage);

    const strictlyAlignedMatches = parsed.matches
      .map((m) => {
        const mGender = normalizeGender(m.gender, userGender);
        const mStage = normalizeLifeStage(m.lifeStage || userLifeStage);
        return {
          ...m,
          gender: userGender,
          lifeStage: mStage === "child" && userLifeStage !== "child" ? userLifeStage : userLifeStage,
          _rawGender: mGender,
          _rawStage: mStage,
        };
      })
      .filter((m) => m._rawGender === userGender);

    const finalMatches =
      strictlyAlignedMatches.length > 0
        ? strictlyAlignedMatches
        : parsed.matches.map((m) => ({
            ...m,
            gender: userGender,
            lifeStage: userLifeStage,
          }));

    return {
      gender: userGender,
      lifeStage: userLifeStage,
      poseLabel: String(parsed.poseLabel || "Rostro IA").trim(),
      matches: finalMatches,
    };
  } finally {
    clearTimeout(timer);
  }
};

const searchSerperImages = async (query) => {
  const cleanQ = String(query || "").trim();
  if (!SERPER_API_KEY || !cleanQ) return [];

  const cacheKey = cleanQ.toLowerCase();
  const cached = serperQueryCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < IMAGE_CACHE_TTL) {
    return cached.urls;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4500);
  try {
    const resp = await fetch("https://google.serper.dev/images", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "X-API-KEY": SERPER_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        q: cleanQ,
        num: 8,
        safe: "active",
      }),
    });

    if (!resp.ok) return [];
    const data = await resp.json();

    const blockedHosts = /(tiktok\.com|fbsbx\.com|instagram\.com|lookaside\.fbsbx|shutterstock|alamy|gettyimages|istockphoto|depositphotos|123rf|dreamstime)/i;

    const urls = (data?.images || [])
      .map((item) => String(item?.imageUrl || "").trim())
      .filter((u) => u.startsWith("https://") && !blockedHosts.test(u));

    serperQueryCache.set(cacheKey, { ts: Date.now(), urls });
    if (serperQueryCache.size > 600) {
      const first = serperQueryCache.keys().next().value;
      serperQueryCache.delete(first);
    }
    return urls;
  } catch (e) {
    return [];
  } finally {
    clearTimeout(timer);
  }
};

const searchTmdbPersonImage = async (name) => {
  const cleanName = String(name || "").trim();
  if (!TMDB_API_KEY || !cleanName) return "";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const resp = await fetch(
      `https://api.themoviedb.org/3/search/person?api_key=${encodeURIComponent(
        TMDB_API_KEY
      )}&include_adult=false&language=es-MX&query=${encodeURIComponent(cleanName)}`,
      { signal: controller.signal }
    );
    if (!resp.ok) return "";
    const data = await resp.json();
    const match = (data?.results || []).find((r) => !r.adult && r.profile_path);
    return match?.profile_path ? `https://image.tmdb.org/t/p/w780${match.profile_path}` : "";
  } catch (e) {
    return "";
  } finally {
    clearTimeout(timer);
  }
};

const resolveBestMatchPhoto = async (matchItem, lifeStage) => {
  const stageSuffix =
    lifeStage === "child" ? " child kid" : lifeStage === "young" ? " young" : "";
  const baseQuery = (matchItem.searchQuery || `${matchItem.name} portrait`) + stageSuffix;

  const urls = await searchSerperImages(baseQuery);
  if (urls.length > 0) {
    return urls[0];
  }

  if (matchItem.searchQuery) {
    const fallbackUrls = await searchSerperImages(matchItem.searchQuery);
    if (fallbackUrls.length > 0) return fallbackUrls[0];
  }

  const tmdbUrl = await searchTmdbPersonImage(matchItem.name);
  if (tmdbUrl) return tmdbUrl;

  return "";
};

app.post("/api/match", async (req, res) => {
  try {
    const {
      uniqueId = "invitado",
      avatarUrl = "",
      imageBase64 = "",
      forceNew = false,
    } = req.body || {};

    const userKey = String(uniqueId || "invitado").trim().toLowerCase().replace(/^@/, "");
    const avatarKey = imageBase64
      ? `b64:${imageBase64.slice(0, 64)}:${imageBase64.length}`
      : `url:${String(avatarUrl || "").trim()}`;

    let entry = userTop5Cache.get(userKey);
    const cacheValid =
      entry &&
      Date.now() - entry.ts < USER_CACHE_TTL &&
      entry.avatarKey === avatarKey &&
      Array.isArray(entry.analysis?.matches) &&
      entry.analysis.matches.length > 0;

    if (!cacheValid) {
      const payload = await extractImagePayload({ imageBase64, avatarUrl, uniqueId: userKey });
      if (!payload) {
        return res.status(400).json({ ok: false, error: "No se pudo descargar la foto del perfil" });
      }
      const analysis = await runGeminiVision(payload);
      entry = {
        ts: Date.now(),
        avatarKey,
        analysis,
        usedNames: new Set(),
      };
      userTop5Cache.set(userKey, entry);
      if (userTop5Cache.size > 500) {
        const firstKey = userTop5Cache.keys().next().value;
        userTop5Cache.delete(firstKey);
      }
    }

    const matches = entry.analysis.matches;
    if (entry.usedNames.size >= matches.length) {
      entry.usedNames.clear();
    }

    let chosenIdx = matches.findIndex((m) => {
      const nKey = String(m.name || "").trim().toLowerCase();
      return !entry.usedNames.has(nKey) && !recentGlobalActors.includes(nKey);
    });

    if (chosenIdx === -1) {
      chosenIdx = matches.findIndex(
        (m) => !entry.usedNames.has(String(m.name || "").trim().toLowerCase())
      );
    }
    if (chosenIdx === -1) chosenIdx = 0;

    const chosen = matches[chosenIdx];
    const chosenNameKey = String(chosen.name || "").trim().toLowerCase();
    entry.usedNames.add(chosenNameKey);
    recordGlobalActor(chosen.name);

    const userGender = normalizeGender(entry.analysis.gender, "male");
    const userLifeStage = normalizeLifeStage(entry.analysis.lifeStage);

    const imageUrl = await resolveBestMatchPhoto(chosen, userLifeStage);
    if (!imageUrl) {
      return res.status(502).json({
        ok: false,
        error: "No se encontró foto disponible para el doble",
      });
    }

    const clampPct = (v, fallback) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return fallback;
      return Math.max(62, Math.min(97, Math.round(n)));
    };

    const similarity = clampPct(chosen.similarity, 84);
    const faceScore = clampPct(chosen.faceScore, similarity + 2);
    const eyesScore = clampPct(chosen.eyesScore, similarity - 1);
    const mouthScore = clampPct(chosen.mouthScore, similarity - 2);

    return res.status(200).json({
      ok: true,
      gender: userGender,
      genderLabel: getGenderLabel(userGender),
      lifeStage: userLifeStage,
      roleLabel: getRoleLabel(userGender, userLifeStage),
      poseLabel: entry.analysis.poseLabel || "Rostro IA",
      repeatIndex: chosenIdx + 1,
      fromCache: Boolean(cacheValid && !forceNew),
      match: {
        name: String(chosen.name || "Estrella").trim(),
        work: cleanWorkTitle(chosen.work || ""),
        imageUrl,
        similarity,
        faceScore,
        eyesScore,
        mouthScore,
      },
    });
  } catch (err) {
    console.log("[MATCH ERROR]", err?.message || err);
    return res.status(502).json({
      ok: false,
      error: String(err?.message || "No se pudo completar la comparación"),
    });
  }
});

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

    if (msg?.action === "connect") {
      const cleanUser = String(msg.uniqueId || "").trim().replace(/^@/, "");
      if (!cleanUser) {
        sendSafe({ event: "error", data: { message: "Falta el usuario de TikTok." } });
        return;
      }
      if (!EULERSTREAM_API_KEY) {
        sendSafe({
          event: "error",
          data: { message: "Falta configurar la clave de conexión LIVE en el servidor." },
        });
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

      const onChatHandler = (data) => {
        if (tiktokConn !== conn) return;
        const uniqueId = getUniqueId(data);
        if (!uniqueId) return;
        sendSafe({
          event: "chat",
          data: {
            uniqueId,
            nickname: getNickname(data),
            profilePictureUrl: getAvatarUrl(data),
            comment: String(data?.comment || data?.content || data?.text || "").trim(),
          },
        });
      };

      const onGiftHandler = (data) => {
        if (tiktokConn !== conn) return;
        const uniqueId = getUniqueId(data);
        if (!uniqueId) return;
        sendSafe({
          event: "gift",
          data: {
            uniqueId,
            nickname: getNickname(data),
            profilePictureUrl: getAvatarUrl(data),
            giftName: String(
              data?.giftDetails?.giftName || data?.extendedGiftInfo?.name || data?.giftName || "Regalo"
            ),
          },
        });
      };

      const chatEvents = new Set([WebcastEvent?.CHAT, "chat", "WebcastChatMessage"].filter(Boolean));
      chatEvents.forEach((ev) => conn.on(ev, onChatHandler));

      const giftEvents = new Set([WebcastEvent?.GIFT, "gift", "WebcastGiftMessage"].filter(Boolean));
      giftEvents.forEach((ev) => conn.on(ev, onGiftHandler));

      conn.on(ControlEvent.ERROR, (err) => {
        if (tiktokConn !== conn) return;
        const rawErr = err?.info || err?.message || String(err || "Error de conexion");
        const errText = String(rawErr);
        if (/fetch room gifts/i.test(errText)) return;
        sendSafe({ event: "error", data: { message: errText.slice(0, 180) } });
      });

      try {
        const state = await conn.connect();
        if (tiktokConn !== conn) return;
        sendSafe({
          event: "connected",
          data: { uniqueId: cleanUser, roomId: state?.roomId || "" },
        });
      } catch (err) {
        if (tiktokConn !== conn) return;
        sendSafe({
          event: "error",
          data: { message: String(err?.message || err || "Error de conexión LIVE").slice(0, 180) },
        });
      }
    }
  });

  ws.on("close", () => {
    cleanupTikTok();
  });
});

server.listen(PORT, () => {
  console.log("Puente TikTok LIVE escuchando en puerto " + PORT);
});