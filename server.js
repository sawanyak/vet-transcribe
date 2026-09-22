import http from "http";
import express from "express";
import { WebSocketServer } from "ws";
import { GoogleGenAI, Modality, Type } from "@google/genai";
import dotenv from "dotenv";
import * as db from "./db.js";

dotenv.config();

const PORT = process.env.PORT || 8080;
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const ANALYSIS_MODEL = "gemini-flash-latest"; // fast + cheap for rolling calls
const MODEL = "gemini-3.5-transcribe-live";

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static("public"));

app.get("/api/consultations", (req, res) => {
  res.json(db.listConsultations());
});

app.get("/api/consultations/:id", (req, res) => {
  const row = db.getConsultation(req.params.id);
  if (!row) return res.status(404).json({ error: "not_found" });
  res.json(row);
});

app.post("/api/consultations", (req, res) => {
  const { started_at, ended_at, duration_seconds, transcript, differentials, suggested_questions, red_flags } = req.body || {};
  if (!started_at || !ended_at || typeof duration_seconds !== "number" || !Array.isArray(transcript)) {
    return res.status(400).json({ error: "invalid_payload" });
  }
  const id = db.insertConsultation({
    started_at,
    ended_at,
    duration_seconds,
    transcript,
    differentials,
    suggested_questions,
    red_flags,
  });
  res.json({ id });
});

app.delete("/api/consultations/:id", (req, res) => {
  const deleted = db.deleteConsultation(req.params.id);
  if (!deleted) return res.status(404).json({ error: "not_found" });
  res.json({ ok: true });
});

const httpServer = http.createServer(app);
const wss = new WebSocketServer({ server: httpServer });

const analysisSchema = {
  type: Type.OBJECT,
  properties: {
    summary: { type: Type.STRING },
    differentials: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          disease: { type: Type.STRING },
          confidence: { type: Type.STRING, enum: ["high", "medium", "low"] },
          reasoning: { type: Type.STRING },
        },
        required: ["disease", "confidence", "reasoning"],
      },
    },
    suggested_questions: { type: Type.ARRAY, items: { type: Type.STRING } },
    red_flags: { type: Type.ARRAY, items: { type: Type.STRING } },
  },
  required: ["summary", "differentials", "suggested_questions", "red_flags"],
};

const SYSTEM_INSTRUCTION = `You are a veterinary clinical decision-support assistant.
Instead of the full conversation, you are given a running summary of the consultation so
far plus only the newest transcript text since that summary was last updated. The
transcript may be in English, Sinhala, or a mix of both (code-switching) — read it in
whichever language(s) it appears in, but always respond in English regardless of the
transcript's language.
Based on the summary and the new transcript combined:
- Update the running summary to capture everything clinically relevant said so far
  (symptoms, history, exam findings, owner statements) in a few concise sentences. This
  summary replaces the old one and will be your only memory of earlier turns next time —
  do not drop details you'll still need.
- List possible differential diagnoses, ranked, each with a confidence level and brief reasoning.
- Suggest follow-up questions the vet has NOT yet asked that would help narrow the diagnosis.
- Flag any urgent/emergency signs.
If there is too little information, return short lists rather than speculating.
You assist the clinician; you do not diagnose. The vet confirms all findings.`;

const EMPTY_ANALYSIS = { differentials: [], suggested_questions: [], red_flags: [] };

// Gemini occasionally returns 503 "high demand" on structured-output calls.
// It's transient, so retry a few times with backoff before giving up.
const RETRYABLE_STATUS = new Set([429, 503]);

async function withRetry(fn, { retries = 3, baseDelayMs = 1000 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = err?.status;
      if (!RETRYABLE_STATUS.has(status) || attempt >= retries) throw err;
      const delay = baseDelayMs * 2 ** attempt;
      console.warn(`Gemini call failed (${status}), retrying in ${delay}ms (attempt ${attempt + 1}/${retries})`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

async function analyze(summary, newText) {
  const prompt = `Running summary of the consultation so far:
${summary || "(none yet — this is the start of the consultation)"}

Newest transcript since that summary was last updated:
${newText}`;
  const result = await withRetry(() =>
    ai.models.generateContent({
      model: ANALYSIS_MODEL,
      contents: prompt,
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        responseMimeType: "application/json",
        responseSchema: analysisSchema,
      },
    })
  );
  return JSON.parse(result.text);
}

wss.on("connection", async (ws) => {
  console.log("Browser connected");
  let session = null;
  const transcript = []; // finalized turns for this conversation
  let lastAnalysis = EMPTY_ANALYSIS;

  // Rolling-summary state: instead of resending the whole transcript on every
  // analysis call, we keep a compact summary of everything up to
  // `summarizedUpTo` and only send the turns after that each time. The model
  // returns an updated summary which replaces the old one.
  let summary = "";
  let summarizedUpTo = 0;

  let analysisTimer = null;
  let analysisPending = false;
  let dirty = false;              // new text arrived since last analysis
  const DEBOUNCE_MS = 20000;

  const runAnalysis = async () => {
    const newTurns = transcript.slice(summarizedUpTo);
    if (analysisPending || newTurns.length === 0) return;
    analysisPending = true;
    dirty = false;                // we're about to consume current state
    try {
      const newText = newTurns.map((t) => t.text).join(" ");
      const result = await analyze(summary, newText);
      summary = result.summary || summary;
      summarizedUpTo = transcript.length;
      lastAnalysis = {
        differentials: result.differentials,
        suggested_questions: result.suggested_questions,
        red_flags: result.red_flags,
      };
      ws.send(JSON.stringify({ type: "analysis", data: lastAnalysis }));
    } catch (err) {
      console.error("Analysis failed:", err.message);
      ws.send(JSON.stringify({ type: "error", message: "analysis_failed" }));
    } finally {
      analysisPending = false;
      if (dirty) runAnalysis();   // trailing run for text that arrived mid-call
    }
  };

  const scheduleAnalysis = () => {
    dirty = true;
    if (analysisTimer) return;
    analysisTimer = setTimeout(() => {
      analysisTimer = null;
      runAnalysis();
    }, DEBOUNCE_MS);
  };

  // Open a Gemini live transcription session for this browser
  try {
    session = await ai.live.connect({
      model: MODEL,
      config: {
        responseModalities: [Modality.TEXT],
        inputAudioTranscription: {
          // Hint both languages so code-switching (English medical terms
          // inside Sinhala speech, or vice versa) is picked up reliably.
          languageCodes: ["en-US", "si-LK"],
        },
      },
      callbacks: {
        onopen: () => {
          console.log("Gemini session open");
          ws.send(JSON.stringify({ type: "status", message: "gemini_ready" }));
        },
        onmessage: (message) => {
          const content = message.serverContent;
          if (!content) return;

          // Interim (still being spoken) — send as partial
          if (content.interimInputTranscription?.text) {
            ws.send(JSON.stringify({
              type: "transcript",
              final: false,
              text: content.interimInputTranscription.text,
            }));
          }
          // Finalized segment
          if (content.inputTranscription?.text) {
            const text = content.inputTranscription.text.trim();
            if (text) {
              const turn = { text, ts: Date.now() };
              transcript.push(turn);
              console.log(`Buffer size: ${transcript.length} | latest: "${text}"`);
              ws.send(JSON.stringify({
                type: "transcript",
                final: true,
                text,
              }));
              scheduleAnalysis();
            }
          }
        },
        onerror: (e) => {
          console.error("Gemini error:", e.message);
          ws.send(JSON.stringify({ type: "error", message: e.message }));
        },
        onclose: (e) => console.log("Gemini session closed:", e.reason),
      },
    });
  } catch (err) {
    console.error("Failed to open Gemini session:", err);
    ws.send(JSON.stringify({ type: "error", message: "gemini_connect_failed" }));
  }

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      // Audio chunk from the browser → forward to Gemini as raw PCM
      if (session) {
        session.sendRealtimeInput({
          audio: {
            data: data.toString("base64"),
            mimeType: "audio/pcm;rate=16000",
          },
        });
      }
    } else {
      const msg = data.toString();
      console.log("Control message:", msg);
      try {
        const parsed = JSON.parse(msg);
        if (parsed.type === "clear") {
          transcript.length = 0;
          summary = "";
          summarizedUpTo = 0;
          console.log("Transcript buffer cleared");
        } else if (parsed.type === "end") {
          // Run one last analysis pass on whatever came in since the last
          // debounced call, then hand the final transcript + analysis back
          // so the client can persist it.
          if (analysisTimer) {
            clearTimeout(analysisTimer);
            analysisTimer = null;
          }
          const finalize = async () => {
            const newTurns = transcript.slice(summarizedUpTo);
            if (newTurns.length > 0) {
              try {
                const newText = newTurns.map((t) => t.text).join(" ");
                const result = await analyze(summary, newText);
                summary = result.summary || summary;
                summarizedUpTo = transcript.length;
                lastAnalysis = {
                  differentials: result.differentials,
                  suggested_questions: result.suggested_questions,
                  red_flags: result.red_flags,
                };
              } catch (err) {
                console.error("Final analysis failed:", err.message);
              }
            }
            ws.send(JSON.stringify({
              type: "final",
              transcript,
              analysis: lastAnalysis,
            }));
          };
          finalize();
        }
      } catch {
        // non-JSON control message, ignore
      }
    }
  });

  ws.on("close", () => {
    console.log("Browser disconnected");
    if (analysisTimer) clearTimeout(analysisTimer);
    session?.close();
  });
  ws.on("error", (err) => console.error("WS error:", err));
});

httpServer.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
