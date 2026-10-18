/**
 * ARAB STORE — WhatsApp Connector Worker
 * ======================================
 * يربط رقم واتساب (وضع الأجهزة المتعددة / ربط جهاز) عبر Baileys،
 * ويوصّل الرسائل الواردة إلى سيرفر Vercel، ثم يرسل الرد الجاهز.
 *
 * متغيرات البيئة المطلوبة:
 *   WA_SERVER  = https://<store>.vercel.app        (أو أي دومين للمتجر، بدون /api)
 *   WA_SECRET  = المفتاح السري الظاهر في لوحة الأدمن ← بوت واتساب
 *
 * اختيارية:
 *   WA_RUN_MINUTES = مدة التشغيل قبل الخروج (افتراضي 350) — تُستخدم في GitHub Actions.
 *   WA_CREDS_DIR   = مسار مجلد حفظ الجلسة محلياً (افتراضي ./.wa-auth)
 *   WA_LOG_LEVEL   = مستوى سجلات pino (افتراضي "info")
 */
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
  makeCacheableSignalKeyStore,
  delay,
} from "./vendor/baileys/lib/index.js";
import P from "pino";
import fs from "node:fs";
import path from "node:path";

const SERVER = (process.env.WA_SERVER || "").replace(/\/+$/, "");
const SECRET = process.env.WA_SECRET || "";
const CREDS_DIR = process.env.WA_CREDS_DIR || path.resolve(".wa-auth");
const RUN_MINUTES = parseInt(process.env.WA_RUN_MINUTES || "350", 10);
const LOG_LEVEL = process.env.WA_LOG_LEVEL || "info";

if (!SERVER || !SECRET) {
  console.error("❌ مطلوب ضبط WA_SERVER و WA_SECRET");
  process.exit(1);
}

const logger = P({ level: LOG_LEVEL });
const API = SERVER + "/api";
const log = (...a) => console.log(new Date().toISOString(), ...a);

/* ---------- عميل السيرفر ---------- */
async function api(pathname, { method = "GET", body } = {}) {
  const url = `${API}${pathname}${pathname.includes("?") ? "&" : "?"}secret=${encodeURIComponent(SECRET)}`;
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", "X-WA-Secret": SECRET },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`API ${pathname} → ${res.status}: ${(data && data.message) || ""}`);
  return data;
}

/* ---------- حفظ/استرجاع الجلسة على السيرفر ---------- */
async function restoreCreds() {
  try {
    const data = await api("/wa/session");
    const creds = data && data.creds;
    if (creds && typeof creds === "object") {
      const files = Object.entries(creds).filter(([, v]) => typeof v === "string");
      if (!files.length) return false;
      fs.mkdirSync(CREDS_DIR, { recursive: true });
      for (const [name, content] of files) {
        fs.writeFileSync(path.join(CREDS_DIR, name), content);
      }
      log("♻️ استرجعت الجلسة من السيرفر (" + files.length + " ملف)");
      return true;
    }
  } catch (e) {
    log("⚠️ لا توجد جلسة سابقة:", e.message);
  }
  return false;
}

function readCredsDir() {
  const out = {};
  try {
    for (const f of fs.readdirSync(CREDS_DIR)) {
      if (f.endsWith(".json")) out[f] = fs.readFileSync(path.join(CREDS_DIR, f), "utf8");
    }
  } catch {}
  return out;
}

/* Baileys يختار المسار حسب creds.me: بدون me → generateRegistrationNode (مسار الربط ✅)
   وبه presence me → generateLoginNode (مسار الدخول) ← يفشل 401 لأننا لسنا مسجّلين.
   لذلك نحذف me/pairingCode قبل كل اتصال وإحنا غير مسجّلين، ونعيد إعدادهما عبر requestPairingCode. */
function prepPairingCreds() {
  try {
    const p = path.join(CREDS_DIR, "creds.json");
    const c = JSON.parse(fs.readFileSync(p, "utf8"));
    if (c.registered) return;
    if (c.me || c.pairingCode) {
      delete c.me;
      delete c.pairingCode;
      fs.writeFileSync(p, JSON.stringify(c));
      log("🧹 أزلت me/pairingCode غير المسجّلة لاستخدام مسار الربط في كل اتصال");
    }
  } catch {}
}

let saveTimer = null;
async function pushCreds() {
  const creds = readCredsDir();
  try {
    await api("/wa/session", { method: "POST", body: { creds } });
    log("💾 تم رفع الجلسة (" + Object.keys(creds).length + " ملف)");
  } catch (e) {
    log("⚠️ فشل رفع الجلسة:", e.message);
  }
}
function schedulePushCreds() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    pushCreds();
  }, 1500);
}

/* ---------- الحالة ---------- */
let sock = null;
let startedAt = 0;
let wantPair = false;
let lastPairAt = 0;
let lastCfg = "";
let shuttingDown = false;

async function postStatus(partial) {
  try {
    await api("/wa/status", { method: "POST", body: partial });
  } catch (e) {
    log("⚠️ فشل تحديث الحالة:", e.message);
  }
}

/* ---------- استخراج النص من الرسالة ---------- */
function extractText(msg) {
  const m = msg.message;
  if (!m) return "";
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.buttonsResponseMessage?.selectedDisplayText ||
    m.listResponseMessage?.title ||
    m.templateButtonReplyMessage?.selectedDisplayText ||
    ""
  ).trim();
}

/* ---------- تشغيل الاتصال ---------- */
async function startSock() {
  prepPairingCreds();
  const { state, saveCreds } = await useMultiFileAuthState(CREDS_DIR);
  const { version } = await fetchLatestBaileysVersion();
  startedAt = Date.now();

  sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false,
    browser: Browsers.ubuntu("Chrome"),
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
    markOnlineOnConnect: true,
    // ابقِ نافذة الربط مفتوحة أطول: 6 مراجع × 120 ثانية ≈ 12 دقيقة بدل 2:40
    qrTimeout: 120000,
  });

  sock.ev.on("creds.update", async () => {
    await saveCreds();
    schedulePushCreds();
  });

  sock.ev.on("connection.update", async (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr) {
      log("📱 QR متاح (يمكن استخدامه بدل الكود)");
      postStatus({ qr, linked: false });
    }
    if (connection === "open") {
      const me = sock?.user?.id ? sock.user.id.split(":")[0].split("@")[0] : "";
      wantPair = false;
      try { await api("/wa/pair", { method: "POST", body: { done: true } }); } catch {}
      log("✅ تم الاتصال بواتساب. الرقم:", me);
      await postStatus({ linked: true, code: "", qr: "", me, platform: "android", error: "", since: "" });
      schedulePushCreds();
    } else if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      const wasRegistered = !!state.creds.registered;
      log("🔌 انقطع الاتصال. code=" + code + (loggedOut ? " (تسجيل خروج)" : ""));
      if (loggedOut && wasRegistered) {
        try { await api("/wa/session", { method: "POST", body: { clear: true } }); } catch {}
        await postStatus({ linked: false, me: "", error: "تم فصل الجهاز من واتساب", updated: "" });
        sock = null;
        return;
      }
      // 401 أثناء مرحلة الربط (غير مسجّل) أمر طبيعي — أعد المحاولة بلا مسح الجلسة
      await postStatus({ error: "انقطع الاتصال، إعادة المحاولة…" });
      if (!shuttingDown) setTimeout(() => startSock().catch((e) => log("إعادة الاتصال فشلت:", e.message)), 3000);
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      try {
        if (!msg.message || msg.key.fromMe) continue;
        const jid = msg.key.remoteJid || "";
        const text = extractText(msg);
        log("📩 وارد (كل الأنواع) jid=" + jid, "fromMe=" + msg.key.fromMe, ":", (text || "").slice(0, 60));
        if (!jid.endsWith("@s.whatsapp.net")) continue; // تجاهل المجموعات
        if (!text) continue;
        const number = jid.split("@")[0];
        const name = msg.pushName || "";
        await postStatus({ last_in_number: number, last_in_name: name, last_in_text: text.slice(0, 200) }).catch(() => {});
        log("📩 وارد من", number, ":", text.slice(0, 80));
        const r = await api("/wa/incoming", { method: "POST", body: { number, name, text } });
        const reply = (r && r.reply) || "";
        if (!reply || (r && r.disabled)) { log("⏭️ لا رد"); continue; }
        await sock.sendMessage(jid, { text: reply }, { quoted: msg }).catch(async () => {
          await sock.sendMessage(jid, { text: reply });
        });
        log("📤 صادر →", number, ":", reply.slice(0, 80));
      } catch (e) {
        log("⚠️ خطأ في معالجة رسالة:", e.message);
      }
    }
  });

  /* إذا طُلب الربط ولم يكن مسجّل الدخول → اطلب كود الربط (مرة واحدة فقط) */
  if (!state.creds.registered) {
    const got = await maybeRequestPair(true);
    if (!got) {
      log("⏳ الجهاز غير مرتبط. بانتظار طلب الربط من لوحة الأدمن…");
      await postStatus({ linked: false });
    }
  }

  return sock;
}

let pairInFlight = false;
async function maybeRequestPair(resend = false) {
  if (!sock || pairInFlight) return "";
  if (sock.authState?.creds?.registered) return "";
  let st;
  try {
    st = await api("/wa/status");
  } catch {
    return "";
  }
  if (!st.pair_requested || !st.phone) return "";
  const existing = (st.status && st.status.code) || "";
  if (existing) {
    // كود صادر مسبقاً: نبقيه كما هو، ونعيد إرساله على السوكت الجديد حتى يبقى حيّاً
    if (resend) await resendPair(st.phone, existing);
    return existing;
  }
  return await requestPair(st.phone);
}

async function resendPair(phone, code) {
  if (pairInFlight || Date.now() - lastPairAt < 8000) return "";
  pairInFlight = true;
  try {
    await delay(2500);
    lastPairAt = Date.now();
    const c = await sock.requestPairingCode(phone, code);
    log("🔁 أعدت إرسال كود الربط:", c);
    return c;
  } catch (e) {
    log("⚠️ إعادة إرسال الكود فشلت:", e.message);
    return "";
  } finally {
    pairInFlight = false;
  }
}

async function requestPair(phone) {
  if (Date.now() - lastPairAt < 30000) return ""; // لا تكرر الكود بسرعة
  pairInFlight = true;
  try {
    await delay(3000);
    lastPairAt = Date.now();
    const code = await sock.requestPairingCode(phone);
    log("🔑 كود الربط:", code);
    await postStatus({ linked: false, code: code || "", error: "" });
    return code;
  } catch (e) {
    log("❌ فشل طلب كود الربط:", e.message);
    await postStatus({ error: "فشل توليد كود الربط: " + e.message });
    return "";
  } finally {
    pairInFlight = false;
  }
}

/* ---------- نبضة الحالة: مزامنة مع لوحة الأدمن كل 5 ثوان ---------- */
async function heartbeat() {
  try {
    const st = await api("/wa/status");
    if (st.force_logout) {
      log("🚪 طُلب فصل الجهاز — إغلاق الجلسة");
      try { await sock?.logout(); } catch {}
      try { await api("/wa/session", { method: "POST", body: { clear: true } }); } catch {}
      try { fs.rmSync(CREDS_DIR, { recursive: true, force: true }); } catch {}
      await postStatus({ linked: false, code: "", qr: "", me: "", since: "", error: "", updated: "" });
      log("♻️ سيتوقف الموصل الآن. شغّله من جديد أو انتظر الدورة القادمة ثم اطلب الربط.");
      shutdown(0);
      return;
    }
    const cfgV = String(st.cfg_version || "");
    if (cfgV !== lastCfg) lastCfg = cfgV;

    if (!sock) {
      if (st.pair_requested && st.phone) await startSock();
    } else if (!sock.authState?.creds?.registered) {
      // الافتراضي: لا تنشيط دوري (منع rate-overlimit) — التنشيط فقط عند إعادة الاتصال
      const rehelloMs = process.env.WA_REHELLO_MS ? +process.env.WA_REHELLO_MS : 0;
      await maybeRequestPair(rehelloMs > 0 && Date.now() - lastPairAt > rehelloMs);
    }
  } catch (e) {
    log("⚠️ heartbeat:", e.message);
  } finally {
    if (!shuttingDown) setTimeout(heartbeat, 5000);
  }
}

/* ---------- إيقاف نظيف ---------- */
function shutdown(code = 0) {
  shuttingDown = true;
  try { sock?.end(undefined); } catch {}
  log("👋 إيقاف الموصل. المدة (ث):", Math.round((Date.now() - startedAt) / 1000));
  setTimeout(() => process.exit(code), 800);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

/* ---------- main ---------- */
(async () => {
  log("🚀 تشغيل موصل واتساب — السيرفر:", SERVER);
  await restoreCreds();
  await startSock();
  heartbeat();
  if (RUN_MINUTES > 0) {
    const ms = RUN_MINUTES * 60 * 1000;
    log(`⏰ سيعمل الموصل لمدة ${RUN_MINUTES} دقيقة ثم يخرج (لدورة جديدة).`);
    setTimeout(() => shutdown(0), ms);
  }
})();
