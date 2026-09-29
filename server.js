const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.get('/', (req, res) => {
    res.send('Hooshi AI Backend Server is Running!');
});

wss.on('connection', (ws) => {
    console.log('گوشی با موفقیت متصل شد.');

    ws.on('message', (message) => {
        try {
            // اگر داده متنی (JSON) باشد
            if (typeof message === 'string' || message instanceof String) {
                const parsed = JSON.parse(message);
                if (parsed.event === 'wake_word_detected') {
                    console.log('کلمه "هوشی" شنیده شد!');
                    ws.send(JSON.stringify({
                        event: 'assistant_response',
                        text: 'جانم؟ در خدمت شما هستم.',
                        should_speak: true
                    }));
                }
            } else {
                // داده صوتی جلسه (Binary Audio Buffer)
                console.log('بافر صوتی جلسه دریافت شد.');
            }
        } catch (e) {
            console.error('خطا در دریافت پیام:', e);
        }
    });

    ws.on('close', () => console.log('ارتباط گوشی قطع شد.'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server started on port ${PORT}`);
});


import http from "node:http";
import { loadConfig } from "./config.js";
import { createRouter } from "./api/router.js";
import { InMemorySessionRepository, JsonFileSessionRepository } from "./storage/session-repository.js";
import { SessionService } from "./application/session-service.js";
import { ConversationService } from "./application/conversation-service.js";
import { InMemoryConversationRepository, JsonFileConversationRepository } from "./storage/conversation-repository.js";
import { AIService } from "./application/ai-service.js";
import { IntelligenceService } from "./application/intelligence-service.js";
import { KnowledgeService } from "./application/knowledge-service.js";
import { ContextService } from "./application/context-service.js";
import { createAIProvider, createIntelligenceProvider, createSearchProvider } from "./providers/provider-factory.js";
import { createASRProvider } from "./providers/asr-factory.js";
import { ASRService } from "./application/asr-service.js";
import { TTSService } from "./application/tts-service.js";
import { createTTSProvider } from "./providers/tts-factory.js";

export function createApplication(overrides = {}) {
  const config = loadConfig(overrides);
  const repository = createSessionRepository(config);
  const conversationRepository = createConversationRepository(config);
  const providers = {
    ai: createAIProvider(config.aiProvider, { delayMs: Number(overrides.aiDelayMs || 0), apiKey: config.openaiApiKey, model: config.openaiModel, baseUrl: config.openaiBaseUrl }),
    intelligence: createIntelligenceProvider(config.intelligenceProvider, { delayMs: Number(overrides.intelligenceDelayMs || 0), apiKey: config.openaiApiKey, model: config.openaiIntelligenceModel || config.openaiModel, baseUrl: config.openaiBaseUrl }),
    search: createSearchProvider(config.searchProvider, { apiKey: config.openaiApiKey, model: config.openaiSearchModel || config.openaiModel, baseUrl: config.openaiBaseUrl }),
    asr: createASRProvider(config.asrProvider, { delayMs: Number(overrides.asrDelayMs || 0), apiKey: config.openaiApiKey, model: config.openaiASRModel, baseUrl: config.openaiBaseUrl }),
    tts: createTTSProvider(config.ttsProvider, { delayMs: Number(overrides.ttsDelayMs || 0), apiKey: config.openaiApiKey, model: config.openaiTTSModel, voice: config.openaiTTSVoice, format: config.openaiTTSFormat, baseUrl: config.openaiBaseUrl })
  };
  const services = {
    session: new SessionService(repository),
    conversation: new ConversationService(conversationRepository),
    ai: new AIService(providers.ai),
    intelligence: new IntelligenceService(providers.intelligence),
    knowledge: new KnowledgeService(providers.search),
    asr: new ASRService(providers.asr),
    tts: new TTSService(providers.tts)
  };
  const context = new ContextService({ sessionService: services.session, conversationService: services.conversation, maxUtterances: config.contextMaxUtterances });
  services.context = context;
  const router = createRouter({ config, asrService: services.asr, ttsService: services.tts, contextService: context, sessionService: services.session, aiService: services.ai, intelligenceService: services.intelligence, knowledgeService: services.knowledge, conversationService: services.conversation, logger: entry => console.error(JSON.stringify({ level: "error", ...entry })) });
  return { config, repository, providers, services, router };
}

function createConversationRepository(config) {
  if (config.sessionStore === "memory") return new InMemoryConversationRepository();
  if (config.sessionStore === "json") return new JsonFileConversationRepository({ filePath: config.conversationStorePath });
  throw Object.assign(new Error("Unsupported conversation store."), { code: "INVALID_REQUEST" });
}

function createSessionRepository(config) {
  if (config.sessionStore === "memory") return new InMemorySessionRepository();
  if (config.sessionStore === "json") return new JsonFileSessionRepository({ filePath: config.sessionStorePath });
  throw Object.assign(new Error("Unsupported session store."), { code: "INVALID_REQUEST" });
}

export function createServer(app = createApplication()) {
  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const headers = lowerHeaders(req.headers);
    const origin = headers.origin;
    const allowedOrigin = app.config.corsOrigin;
    if (origin && allowedOrigin !== "*" && origin !== allowedOrigin) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "CORS origin denied" }));
      return;
    }
    if (req.method === "OPTIONS") {
      applyCors(res, origin, allowedOrigin);
      res.writeHead(204);
      res.end();
      return;
    }

    const controller = new AbortController();
    let aborted = false;
    req.on("aborted", () => { aborted = true; controller.abort("cancelled"); });
    req.on("close", () => {
      if (!res.writableEnded && req.complete === false) {
        aborted = true;
        controller.abort("cancelled");
      }
    });

    try {
      const bodyInfo = await readRequestBody(req, {
        maxBytes: app.config.maxBodyBytes,
        requiresJson: req.method === "POST"
      });
      if (aborted || controller.signal.aborted) return;
      const body = bodyInfo.body;
      const result = await app.router({ method: req.method || "GET", path: url.pathname, headers, body, signal: controller.signal });
      if (aborted || controller.signal.aborted) return;
      applyCors(res, origin, allowedOrigin);
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("X-HOSHI-Request-Id", result.body.requestId);
      res.setHeader("X-HOSHI-Correlation-Id", result.body.correlationId);
      res.writeHead(result.status);
      res.end(JSON.stringify(result.body));
      console.log(JSON.stringify({ requestId: result.body.requestId, correlationId: result.body.correlationId, method: req.method, path: url.pathname, status: result.status, duration: Date.now() - started }));
    } catch (error) {
      if (aborted || controller.signal.aborted) return;
      const result = error?.httpResponse;
      if (!result) throw error;
      applyCors(res, origin, allowedOrigin);
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.writeHead(result.status, result.headers || {});
      res.end(JSON.stringify(result.body), () => { if (result.destroyRequest) req.destroy(); });
      console.log(JSON.stringify({ requestId: result.body.requestId, correlationId: result.body.correlationId, method: req.method, path: url.pathname, status: result.status, duration: Date.now() - started }));
    }
  });
  return server;
}

function readRequestBody(req, { maxBytes, requiresJson }) {
  const contentLength = Number(req.headers["content-length"] || 0);
  const hasBody = contentLength > 0 || Boolean(req.headers["transfer-encoding"]);
  if (requiresJson && hasBody && !isJsonContentType(req.headers["content-type"])) {
    return rejectHttp(415, "INVALID_REQUEST", "Content-Type must be application/json.");
  }
  if (!hasBody) return Promise.resolve({ body: null });
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    req.pause();
    const response = buildHttpError(413, "INVALID_REQUEST", "Request body exceeds the configured size limit.");
    return rejectHttpAfterPause(req, response);
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const fail = response => {
      if (settled) return;
      settled = true;
      req.pause();
      req.removeAllListeners("data");
      reject(Object.assign(new Error(response.body.error.message), { httpResponse: { ...response, destroyRequest: true } }));
    };
    req.on("data", chunk => {
      total += chunk.length;
      if (total > maxBytes) {
        fail(buildHttpError(413, "INVALID_REQUEST", "Request body exceeds the configured size limit."));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks, total).toString("utf8");
      if (!raw) return resolve({ body: null });
      try { resolve({ body: JSON.parse(raw) }); }
      catch { reject(Object.assign(new Error("Malformed JSON."), { httpResponse: buildHttpError(400, "INVALID_REQUEST", "Invalid JSON request body.") })); }
    });
    req.on("error", error => { if (!settled) { settled = true; reject(error); } });
  });
}

function rejectHttp(status, code, message) {
  return Promise.reject(Object.assign(new Error(message), { httpResponse: buildHttpError(status, code, message) }));
}
function rejectHttpAfterPause(req, response) {
  return new Promise((_, reject) => {
    reject(Object.assign(new Error(response.body.error.message), { httpResponse: { ...response, destroyRequest: true } }));
  });
}
function buildHttpError(status, code, message) {
  const requestId = `req-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return { status, headers: {}, body: { requestId, correlationId: requestId, timestamp: new Date().toISOString(), success: false, data: null, error: { code, message, retryable: false } } };
}
function isJsonContentType(value) {
  return typeof value === "string" && /^application\/json(?:\s*;\s*charset=[^;]+)?$/i.test(value.trim());
}

function lowerHeaders(headers) { return Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])); }
function applyCors(res, origin, allowed) { if (origin && (allowed === "*" || origin === allowed)) res.setHeader("Access-Control-Allow-Origin", origin); else if (!origin && allowed !== "*") res.setHeader("Access-Control-Allow-Origin", allowed); res.setHeader("Vary", "Origin"); res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS"); res.setHeader("Access-Control-Allow-Headers", "Content-Type,X-HOSHI-Request-Id,X-HOSHI-Correlation-Id,X-Request-ID,X-Correlation-ID"); }

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = createApplication();
  const server = createServer(app);
  server.listen(app.config.port, app.config.host, () => console.log(`HOSHI Backend v0.9.2 listening on http://${app.config.host}:${app.config.port}${app.config.apiBasePath}`));
  const shutdown = signal => { console.log(JSON.stringify({ event: "shutdown", signal })); server.close(() => process.exit(0)); setTimeout(() => process.exit(1), 5000).unref(); };
  process.on("SIGINT", () => shutdown("SIGINT")); process.on("SIGTERM", () => shutdown("SIGTERM"));
}

