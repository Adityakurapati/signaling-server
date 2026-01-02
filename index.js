const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const axios = require("axios");

const app = express();
app.use(cors());

const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

/* ================= SOCKET.IO ================= */

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  transports: ["websocket"]
});

/* ================= HEALTH ================= */

app.get("/health", (_, res) => {
  res.json({
    status: "OK",
    connections: io.engine.clientsCount
  });
});

app.get("/", (_, res) => {
  res.send("Voice Translation Server Running");
});

/* ================= TRANSLATION PIPELINE ================= */

// 👉 STT (placeholder – replace later with Vosk / Whisper)
async function speechToText(base64Audio, lang) {
  // TEMP: Replace with real streaming STT
  return "hello how are you";
}

// 👉 Translation (LibreTranslate)
async function translateText(text, source, target) {
  const res = await axios.post("https://libretranslate.com/translate", {
    q: text,
    source,
    target,
    format: "text"
  });

  return res.data.translatedText;
}

// 👉 TTS (VoiceRSS)
async function textToSpeech(text, lang) {
  const response = await axios.get("https://api.voicerss.org", {
    params: {
      key: process.env.VOICERSS_KEY, // SET IN RENDER ENV
      hl: lang,
      src: text,
      c: "MP3",
      f: "8khz_8bit_mono"
    },
    responseType: "arraybuffer"
  });

  return Buffer.from(response.data).toString("base64");
}

/* ================= SOCKET EVENTS ================= */

io.on("connection", socket => {
  console.log("🔌 Client connected:", socket.id);

  socket.on("audio-chunk", async payload => {
    try {
      const { audioBase64, sourceLang, targetLang } = payload;

      // 1️⃣ STT
      const text = await speechToText(audioBase64, sourceLang);

      // 2️⃣ Translate
      const translated = await translateText(text, sourceLang, targetLang);

      // 3️⃣ TTS
      const ttsAudio = await textToSpeech(translated, targetLang);

      // 4️⃣ Send back
      socket.emit("translated-audio", {
        text,
        translated,
        audioBase64: ttsAudio
      });

    } catch (err) {
      console.error("❌ Pipeline error:", err.message);
      socket.emit("pipeline-error", { message: err.message });
    }
  });

  socket.on("disconnect", () => {
    console.log("❌ Client disconnected:", socket.id);
  });
});

/* ================= START SERVER ================= */

server.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
