/* =========================================================
   ARAB STORE — app.js
   أدوات مشتركة بين كل صفحات الموقع
   ⚠️ API_BASE حالياً عنوان مؤقت — رح نربطه بالـ backend الحقيقي
   لما نبني سيرفر الـ API (المرحلة الجاية).
   ========================================================= */
const API_BASE = "/api"; // TODO: استبدلها بعنوان السيرفر الحقيقي بعد نشر الـ backend

const Store = {
  token(){ return localStorage.getItem("token"); },
  setToken(t){ localStorage.setItem("token", t); },
  clearToken(){ localStorage.removeItem("token"); },
  user(){ try{ return JSON.parse(localStorage.getItem("user")||"null"); }catch(e){ return null; } },
  setUser(u){ localStorage.setItem("user", JSON.stringify(u)); },
};

/* ===== العملة المعروضة (USD / SYP) — متزامنة بكل صفحات الموقع ===== */
const Currency = {
  get(){ return localStorage.getItem("displayCurrency") || "USD"; },
  set(c){ localStorage.setItem("displayCurrency", c); },
  async save(c){
    this.set(c);
    if(Store.token()) await apiFetch("/auth/currency", { method:"POST", body:JSON.stringify({ currency:c }) });
  },
  toggle(){ this.set(this.get() === "USD" ? "SYP" : "USD"); return this.get(); },
  rate(){ return parseFloat(localStorage.getItem("exchangeRate") || "0") || 0; },
  setRate(r){ if(r) localStorage.setItem("exchangeRate", r); },
  /* يحوّل سعر بالدولار لنص جاهز للعرض حسب العملة المختارة حالياً */
  format(usd){
    usd = Number(usd) || 0;
    if(this.get() === "SYP"){
      const syp = usd * this.rate();
      return Math.round(syp).toLocaleString() + " ل.س";
    }
    return "$" + usd.toFixed(2);
  }
};

/* ===== اللغة (عربي / إنكليزي) ===== */
const Lang = {
  get(){ return localStorage.getItem("lang") || "ar"; },
  set(l){ localStorage.setItem("lang", l); },
};
function applyTranslations(){
  const lang = Lang.get();
  document.documentElement.lang = lang === "en" ? "en" : "ar";
  document.documentElement.dir = lang === "en" ? "ltr" : "rtl";
  document.querySelectorAll("[data-ar]").forEach(el=>{
    const text = lang === "en" ? (el.dataset.en || el.dataset.ar) : el.dataset.ar;
    if(el.hasAttribute("data-attr-placeholder")) el.setAttribute("placeholder", text);
    else el.textContent = text;
  });
}
function toggleLanguage(){
  Lang.set(Lang.get() === "en" ? "ar" : "en");
  applyTranslations();
}
(function initTheme(){
  const saved = localStorage.getItem("theme");
  if(saved) document.documentElement.dataset.theme = saved;
})();
function toggleTheme(){
  const html = document.documentElement;
  html.dataset.theme = html.dataset.theme === "light" ? "dark" : "light";
  localStorage.setItem("theme", html.dataset.theme);
}

/* ===== Drawer ===== */
function toggleDrawer(open){
  const d = document.getElementById("drawer");
  const o = document.getElementById("overlay");
  if(!d || !o) return;
  d.classList.toggle("open", open);
  o.classList.toggle("show", open);
  document.body.style.overflow = open ? "hidden" : "";
}
document.addEventListener("click", (e)=>{
  if(!e.target.closest(".drawer") && !e.target.closest(".menu-btn")){
    toggleDrawer(false);
  }
});

/* ===== صور تقاوم النت الضعيف: إعادة محاولة تلقائية ثم أيقونة بديلة ===== */
document.addEventListener("error", function(e){
  const t = e.target;
  if(!t || t.tagName !== "IMG") return;
  if(!t.dataset.imgRetried){
    // المحاولة 1: إعادة تحميل بعد ثانية (كسر الكاش)
    t.dataset.imgRetried = "1";
    const clean = t.src.split("?")[0];
    setTimeout(()=>{ try{ t.src = clean + "?r=1"; }catch(_){} }, 900);
  }else if(!t.dataset.imgFallback){
    // المحاولة 2 فشلت: استبدال بأيقونة أنيقة بدل الصورة المكسورة
    t.dataset.imgFallback = "1";
    const i = document.createElement("i");
    i.className = "fa-solid fa-gamepad";
    try{ t.replaceWith(i); }catch(_){}
  }
}, true);

/* ===== شارات البلاطات: عرض + غير متوفر ===== */
function tileBadges(t){
  t = t || {};
  let h = "";
  if(t.offer) h += `<span class="tile-offer">${String(t.offer).slice(0, 24)}</span>`;
  if(t.available === false) h += `<span class="tile-unavail-ribbon">غير متوفر</span>`;
  return h;
}
function tileCls(t){
  return (t && t.available === false) ? " tile-unavail" : "";
}

/* ===== Toast ===== */
function toast(msg, type="success"){
  let el = document.getElementById("appToast");
  if(!el){
    el = document.createElement("div");
    el.id = "appToast";
    el.className = "toast";
    document.body.appendChild(el);
  }
  const icon = type === "error" ? "fa-circle-xmark" : "fa-circle-check";
  el.className = `toast show ${type}`;
  el.innerHTML = `<i class="fa-solid ${icon}"></i><span>${msg}</span>`;
  clearTimeout(el._t);
  el._t = setTimeout(()=> el.classList.remove("show"), 2600);
}

/* ===== API helper (جاهز للربط مع backend لاحقاً) ===== */
async function apiFetch(path, opts={}){
  const headers = Object.assign({ "Accept":"application/json" }, opts.headers || {});
  const token = Store.token();
  if(token) headers["Authorization"] = "Bearer " + token;
  if(opts.body && !(opts.body instanceof FormData)){
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(API_BASE + path, Object.assign({}, opts, { headers }));
  let data = null;
  try{ data = await res.json(); }catch(e){ /* لا يوجد body */ }
  if(!res.ok){
    const err = new Error((data && (data.message||data.error)) || "حدث خطأ، حاول مرة ثانية");
    err.status = res.status; err.data = data;
    throw err;
  }
  return data;
}

/* ===== الدرج: تحديث حالة المستخدم (زائر / مسجل) ===== */
function renderAuthState(){
  const user = Store.user();
  const nameEl = document.getElementById("drawerUserName");
  const emailEl = document.getElementById("drawerUserEmail");
  const authButtons = document.getElementById("drawerAuthButtons");
  const logoutBox = document.getElementById("logoutBox");
  const balancePill = document.getElementById("balancePillValue");
  const guestOnlyEls = document.querySelectorAll(".guest-hide");
  const apiMenuItem = document.getElementById("apiMenuItem");

  if(!user){
    if(nameEl) nameEl.textContent = "زائر";
    if(emailEl) emailEl.textContent = "سجّل دخولك للاستفادة من المحفظة والطلبات";
    if(authButtons) authButtons.style.display = "flex";
    if(logoutBox) logoutBox.style.display = "none";
    if(balancePill) balancePill.textContent = "$0.00";
    guestOnlyEls.forEach(el => el.style.display = "none");
    if(apiMenuItem) apiMenuItem.style.display = "none";
    // الزائر الذي معه جلسة أدمن (admin_token) يرى رابط لوحة الأدمن فقط
    const ownerAdminItemG = document.getElementById("ownerAdminMenuItem");
    if(ownerAdminItemG) ownerAdminItemG.style.display = localStorage.getItem("admin_token") ? "" : "none";
    return;
  }
  if(nameEl){
    if(user.discount_tier_name){
      nameEl.innerHTML = `<span class="badge-vip"><i class="fa-solid fa-crown"></i> ${user.discount_tier_name}</span> ${user.name || "مستخدم"}`;
    } else {
      nameEl.textContent = user.name || "مستخدم";
    }
  }
  if(emailEl) emailEl.textContent = user.email || "";
  if(authButtons) authButtons.style.display = "none";
  if(logoutBox) logoutBox.style.display = "block";
  if(balancePill) balancePill.textContent = Currency.format(user.balance||0);
  guestOnlyEls.forEach(el => el.style.display = "");
  if(apiMenuItem) apiMenuItem.style.display = user.api_enabled ? "" : "none";
  const ownerAdminItem = document.getElementById("ownerAdminMenuItem");
  // إظهار لوحة الأدمن لأي حساب صلاحياته أدمن (المالك أو أي بريد مضاف من لوحة الأدمن)
  // وأيضاً لمن سجّل دخول الأدمن بكلمة السر (admin_token) حتى بدون حساب مستخدم
  const hasAdminToken = !!localStorage.getItem("admin_token");
  if(ownerAdminItem) ownerAdminItem.style.display = (user && user.is_admin) || hasAdminToken ? "" : "none";
}

function logoutUser(e){
  if(e) e.stopPropagation();
  Store.clearToken();
  localStorage.removeItem("user");
  toggleDrawer(false);
  setTimeout(()=>{ window.location.href = "/store.html"; }, 150);
}

function goLogin(e){ if(e) e.stopPropagation(); toggleDrawer(false); setTimeout(()=> window.location.href="/login.html", 120); }
function goRegister(e){ if(e) e.stopPropagation(); toggleDrawer(false); setTimeout(()=> window.location.href="/register.html", 120); }

/* ===== الفاب العائم ===== */
function setupFab(){
  const fab = document.getElementById("fabMainBtn");
  const opts = document.getElementById("fabOptions");
  if(!fab || !opts) return;
  // الضغط على الدائرة يفتح قائمة كل الأزرار: الوكيل 🤖 + الدعم (تيليجرام/واتساب/القنوات)
  fab.addEventListener("click", (e)=>{
    e.stopPropagation();
    ensureAgentOption();
    opts.classList.toggle("open");
  });
  document.addEventListener("click", (e)=>{
    if(!e.target.closest(".fab-stack")) opts.classList.remove("open");
  });
  initAiAgent(fab);
}

/* ===== المساعد الذكي 🤖 — يعرف المتجر كاملاً ويوجّه المستخدمين ===== */
const AI_AGENT = { enabled:false, name:"مساعد ARAB", welcome:"", loaded:false };
const AI_CHIPS = ["🔍 ابحث عن منتج", "💎 أسعار الشحن", "💳 كيف أشحن رصيدي؟", "📦 تتبع طلبي", "📞 التواصل مع الإدارة"];

async function initAiAgent(fab){
  try{
    const r = await fetch(API_BASE + "/ai-agent/config");
    const cfg = await r.json();
    AI_AGENT.enabled = !!cfg.enabled;
    AI_AGENT.name = cfg.name || "مساعد ARAB";
    AI_AGENT.welcome = cfg.welcome || "أهلاً فيك! أنا مساعد المتجر 🤖 اسألني عن أي منتج أو سعر أو طريقة شحن.";
  }catch(e){ return; }
  AI_AGENT.loaded = true;
  if(!AI_AGENT.enabled || !fab) return;
  fab.classList.add("ai-on");
  const icon = fab.querySelector("i");
  if(icon) icon.className = "fa-solid fa-robot";
  fab.title = AI_AGENT.name;
  buildAiChatPanel();
  ensureAgentOption();
}

/* زر الوكيل داخل قائمة الدائرة — أول زر فوق أزرار الدعم */
function ensureAgentOption(){
  const opts = document.getElementById("fabOptions");
  if(!opts || !AI_AGENT.enabled) return;
  if(document.getElementById("fabAgentBtn")) return;
  const b = document.createElement("button");
  b.id = "fabAgentBtn";
  b.className = "fab-option ai-agent-opt";
  b.title = AI_AGENT.name;
  b.setAttribute("aria-label", AI_AGENT.name);
  b.innerHTML = '<i class="fa-solid fa-robot"></i>';
  b.addEventListener("click", (e)=>{ e.stopPropagation(); opts.classList.remove("open"); toggleAiChat(true); });
  opts.prepend(b);
}

function buildAiChatPanel(){
  if(document.getElementById("aiChatPanel")) return;
  const panel = document.createElement("div");
  panel.id = "aiChatPanel";
  panel.className = "ai-chat";
  panel.innerHTML = `
    <div class="ai-chat-head">
      <div class="ai-avatar"><i class="fa-solid fa-robot"></i></div>
      <div><div class="ai-name">${AI_AGENT.name}</div><div class="ai-online"><span class="dot"></span> متصل الآن — يرد فوراً</div></div>
      <button class="ai-close" onclick="toggleAiChat(false)" title="إغلاق"><i class="fa-solid fa-xmark"></i></button>
    </div>
    <div class="ai-chat-body" id="aiChatBody"></div>
    <div class="ai-chips">${AI_CHIPS.map(c=>`<button class="ai-chip" onclick="aiChipAsk(this)">${c}</button>`).join("")}</div>
    <div class="ai-chat-input">
      <input type="text" id="aiChatInput" placeholder="اكتب سؤالك..." maxlength="1000" onkeydown="if(event.key==='Enter') aiSend();">
      <button id="aiChatMic" onclick="aiMic()" title="تحدث صوتياً 🎙️"><i class="fa-solid fa-microphone"></i></button>
      <button id="aiChatSend" onclick="aiSend()" title="إرسال"><i class="fa-solid fa-paper-plane"></i></button>
    </div>`;
  document.body.appendChild(panel);
  renderAiHistory();
}

function toggleAiChat(force){
  const panel = document.getElementById("aiChatPanel");
  if(!panel) return;
  const open = force !== undefined ? force : !panel.classList.contains("open");
  panel.classList.toggle("open", open);
  if(open){
    const body = document.getElementById("aiChatBody");
    if(!aiGetHistory().length) aiPushMsg("assistant", AI_AGENT.welcome);
    renderAiHistory();
    body.scrollTop = body.scrollHeight;
    setTimeout(()=> document.getElementById("aiChatInput")?.focus(), 250);
  }
}

/* تنسيق جميل: عريض + قوائم + روابط + أسطر */
function aiRender(text){
  let h = String(text || "")
    .replace(/<\s*\/?\s*(think|thinking|thought|reasoning)[^>]*>/gi, "") // إخفاء بقايا التفكير بالسجلات القديمة
    .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  h = h.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  const lines = h.split("\n");
  let out = "", inList = false;
  for(const ln of lines){
    const t = ln.trim();
    if(/^([-*•]\s+)/.test(t)){
      if(!inList){ out += "<ul>"; inList = true; }
      out += "<li>" + t.replace(/^([-*•]\s+)/, "") + "</li>";
    }else{
      if(inList){ out += "</ul>"; inList = false; }
      out += t ? t + "<br>" : "<br>";
    }
  }
  if(inList) out += "</ul>";
  out = out.replace(/(https?:\/\/[^\s<]+|\/product\.html\?id=\d+)/g, '<a href="$1" target="_blank">$1</a>');
  return out;
}

function aiGetHistory(){
  try{ return JSON.parse(localStorage.getItem("aiChatHistory") || "[]"); }catch(e){ return []; }
}
function aiSetHistory(h){ localStorage.setItem("aiChatHistory", JSON.stringify(h.slice(-30))); }
function aiPushMsg(role, content, cards){
  const h = aiGetHistory(); h.push({ role, content, cards: cards || [] }); aiSetHistory(h);
}
function aiCardsHTML(cards){
  if(!cards || !cards.length) return "";
  return `<div class="ai-cards">` + cards.map(c=>{
    const nm = String(c.product_name || "").replace(/&/g,"&amp;").replace(/</g,"&lt;");
    const price = Number(c.price || 0);
    const priceTxt = price > 0 ? " — $" + price.toFixed(2) : "";
    const sku = String(c.sku_name || "").replace(/&/g,"&amp;").replace(/</g,"&lt;");
    const mode = c.mode || "both";
    const viewBtn = `<a href="/product.html?id=${c.product_id}" class="ai-btn view"><i class="fa-solid fa-eye"></i> عرض المنتج</a>`;
    const buyBtn = c.sku_id ? `<a href="/product.html?id=${c.product_id}&buy=${encodeURIComponent(c.sku_id)}" class="ai-btn buy"><i class="fa-solid fa-cart-shopping"></i> شراء</a>` : "";
    const btns = mode === "view" ? viewBtn : (mode === "buy" ? (buyBtn + viewBtn) : (viewBtn + buyBtn));
    return `<div class="ai-card">
      <div class="ai-card-info"><i class="fa-solid fa-box-open"></i><div><b>${nm}</b>${sku ? `<small>${sku}${priceTxt}</small>` : ""}</div></div>
      <div class="ai-card-btns">${btns}</div>
    </div>`;
  }).join("") + `</div>`;
}
function renderAiHistory(){
  const body = document.getElementById("aiChatBody");
  if(!body) return;
  const h = aiGetHistory();
  body.innerHTML = h.map(m=>`<div class="ai-msg ${m.role === "user" ? "user" : "agent"}">${m.role === "user" ? m.content.replace(/&/g,"&amp;").replace(/</g,"&lt;") : aiRender(m.content)}</div>${m.role === "assistant" ? aiCardsHTML(m.cards) : ""}`).join("");
  body.scrollTop = body.scrollHeight;
}
function aiChipAsk(btn){ const inp = document.getElementById("aiChatInput"); if(inp){ inp.value = btn.textContent; aiSend(); } }

/* تحدث صوتياً 🎙️ — Web Speech API (كروم/أندرويد) */
let _aiRecog = null;
function aiMic(){
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if(!SR){ toast("المتصفح لا يدعم الإدخال الصوتي — جرّب كروم", "error"); return; }
  const btn = document.getElementById("aiChatMic");
  if(_aiRecog){ try{ _aiRecog.stop(); }catch(e){} return; }
  try{
    const rec = new SR();
    rec.lang = "ar-SA";
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    _aiRecog = rec;
    if(btn) btn.classList.add("rec");
    toast("🎙️ تحدث الآن...");
    rec.onresult = (ev)=>{
      const txt = ev.results && ev.results[0] && ev.results[0][0] ? ev.results[0][0].transcript : "";
      if(txt.trim()){
        const inp = document.getElementById("aiChatInput");
        if(inp) inp.value = txt.trim();
        aiSend();
      }
    };
    rec.onerror = ()=>{ toast("تعذّر السماع — حاول مجدداً", "error"); };
    rec.onend = ()=>{ _aiRecog = null; if(btn) btn.classList.remove("rec"); };
    rec.start();
  }catch(err){ _aiRecog = null; if(btn) btn.classList.remove("rec"); toast("تعذّر تشغيل المايك", "error"); }
}

async function aiSend(){
  const inp = document.getElementById("aiChatInput");
  const btn = document.getElementById("aiChatSend");
  const body = document.getElementById("aiChatBody");
  const text = (inp.value || "").trim();
  if(!text || btn.disabled) return;
  inp.value = "";
  aiPushMsg("user", text);
  renderAiHistory();
  btn.disabled = true;
  const tp = document.createElement("div");
  tp.className = "ai-typing"; tp.id = "aiTyping";
  tp.innerHTML = "<span></span><span></span><span></span>";
  body.appendChild(tp); body.scrollTop = body.scrollHeight;
  try{
    const headers = { "Content-Type":"application/json" };
    if(Store.token()) headers["Authorization"] = "Bearer " + Store.token();
    const hist = aiGetHistory().slice(-8).map(m=>({ role: m.role, content: m.content }));
    const res = await fetch(API_BASE + "/ai-agent/chat", {
      method:"POST", headers, body: JSON.stringify({ message: text, history: hist })
    });
    const data = await res.json().catch(()=>null);
    let reply, cards = [];
    if(!res.ok){ reply = (data && (data.message || data.reply)) || "عذراً، حاول مجدداً ⏳"; }
    else{ reply = data.reply || "لم أفهم — جرّب صياغة أخرى 🤖"; cards = data.cards || []; }
    document.getElementById("aiTyping")?.remove();
    aiPushMsg("assistant", reply, cards);
    renderAiHistory();
  }catch(err){
    document.getElementById("aiTyping")?.remove();
    aiPushMsg("assistant", "انقطع الاتصال ⏳ تحقق من الإنترنت وحاول مجدداً.");
    renderAiHistory();
  }
  finally{ btn.disabled = false; inp.focus(); }
}

/* ===== إعدادات الموقع العامة (لوغو المطوّر + روابط التواصل) ===== */
let SITE_SETTINGS = null;

async function loadSiteBranding(){
  try{
    const res = await fetch(API_BASE + "/store/settings");
    SITE_SETTINGS = await res.json();
  }catch(e){ return; }
  applyDevLogo();
  applyContactLinks();
}

function applyDevLogo(){
  const url = SITE_SETTINGS && SITE_SETTINGS.dev_logo;
  if(!url) return;
  document.querySelectorAll(".dev-logo").forEach(img=>{
    img.src = url;
    img.onerror = ()=>{ img.style.display = "none"; };
    img.style.display = "";
  });
}

function applyContactLinks(){
  const opts = document.getElementById("fabOptions");
  const c = (SITE_SETTINGS && SITE_SETTINGS.contact) || {};
  if(!opts) return;
  const links = [
    { url: c.telegram_url, icon: "fa-brands fa-telegram", title: "الدعم على تيليجرام" },
    { url: c.whatsapp_url, icon: "fa-brands fa-whatsapp", title: "الدعم على واتساب" },
    { url: c.whatsapp_channel_url, icon: "fa-solid fa-bullhorn", title: "قناة أخبار واتساب" },
    { url: c.telegram_channel_url, icon: "fa-solid fa-tower-broadcast", title: "قناة أخبار تيليجرام" },
  ].filter(l => l.url);
  if(!links.length){ ensureAgentOption(); return; } // نخلي الروابط الافتراضية بالصفحة
  opts.innerHTML = links.map(l =>
    `<a href="${l.url}" target="_blank" rel="noopener" class="fab-option" title="${l.title}"><i class="${l.icon}"></i></a>`
  ).join("");
  ensureAgentOption();
}

/* ===== إشعارات فعلية بالخلفية مع صوت رنين ===== */
const NOTIF_SEEN_KEY = "lastNotifId";
let _notifBootstrapped = false;

function playNotifSound(){
  try{
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if(!Ctx) return;
    const ctx = new Ctx();
    const now = ctx.currentTime;
    [880, 1174].forEach((freq, i)=>{
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, now + i*0.18);
      gain.gain.exponentialRampToValueAtTime(0.25, now + i*0.18 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + i*0.18 + 0.16);
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(now + i*0.18); osc.stop(now + i*0.18 + 0.2);
    });
    setTimeout(()=>{ try{ ctx.close(); }catch(e){} }, 900);
  }catch(e){}
}

function askNotifPermission(){
  if(!("Notification" in window)) return;
  if(Notification.permission === "default"){
    const ask = ()=>{
      Notification.requestPermission().then((permission)=>{ if(permission === "granted") enableWebPush(); }).catch(()=>{});
      document.removeEventListener("click", ask);
    };
    document.addEventListener("click", ask, { once:true });
  } else if(Notification.permission === "granted") {
    enableWebPush();
  }
}

function pushKeyBytes(base64){
  const padding = "=".repeat((4 - base64.length % 4) % 4);
  const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from([...raw].map(ch => ch.charCodeAt(0)));
}

async function enableWebPush(){
  // يعمل للمستخدم والضيف معاً — الضيف يُسجَّل كـ user_id=0 ليصله جديد المنتجات والعروض
  if(!("serviceWorker" in navigator) || !("PushManager" in window)) return false;
  try{
    if(!("Notification" in window) || Notification.permission !== "granted") return false;
    const keyRes = await fetch(API_BASE + "/push/public-key");
    const keyData = await keyRes.json();
    if(!keyData.enabled || !keyData.public_key) return false;
    if(localStorage.getItem("pushSubscribed") === "1") return true;
    const registration = await navigator.serviceWorker.register("/sw.js");
    let subscription = await registration.pushManager.getSubscription();
    if(!subscription){
      subscription = await registration.pushManager.subscribe({ userVisibleOnly:true, applicationServerKey:pushKeyBytes(keyData.public_key) });
    }
    await apiFetch("/push/subscribe", { method:"POST", body:JSON.stringify(subscription.toJSON()) });
    localStorage.setItem("pushSubscribed", "1");
    return true;
  }catch(err){ /* إشعارات الخلفية اختيارية ولا تعطل الموقع */ return false; }
}

function showSystemNotification(n){
  try{
    if(!("Notification" in window) || Notification.permission !== "granted") return;
    const note = new Notification(n.title || "إشعار جديد", {
      body: n.message || "",
      icon: "/site-icon",
      tag: "arab-store-" + n.id,
    });
    note.onclick = ()=>{ window.focus(); location.href = "/activity.html"; };
  }catch(e){}
}

function handleIncomingNotifications(items){
  if(!items || !items.length) return;
  const ids = items.map(n => Number(n.id) || 0);
  const maxId = Math.max.apply(null, ids);
  const lastSeen = Number(localStorage.getItem(NOTIF_SEEN_KEY) || 0);
  if(!_notifBootstrapped && !lastSeen){
    localStorage.setItem(NOTIF_SEEN_KEY, String(maxId));
    _notifBootstrapped = true;
    return;
  }
  _notifBootstrapped = true;
  const fresh = items.filter(n => Number(n.id) > lastSeen);
  if(!fresh.length) return;
  localStorage.setItem(NOTIF_SEEN_KEY, String(maxId));
  playNotifSound();
  fresh.slice(0, 3).forEach(showSystemNotification);
  if(typeof toast === "function") toast("🔔 " + (fresh[0].title || "لديك إشعار جديد"));
}

/* ===== تفعيل عنصر التنقل السفلي الحالي ===== */
function setActiveNav(){
  const path = location.pathname;
  document.querySelectorAll(".nav-item").forEach(item=>{
    const href = item.getAttribute("href");
    if(href && path.includes(href)) item.classList.add("active");
  });
}

/* ===== مزامنة بيانات المستخدم مع السيرفر (لو الأدمن غيّر شي مثل تفعيل API) ===== */
async function syncUserState(){
  if(!Store.token()) return;
  try{
    const data = await apiFetch("/auth/me");
    Store.setUser(Object.assign(data.user, { balance: data.user.balance_usd }));
    if(data.user.preferred_currency) Currency.set(data.user.preferred_currency);
    renderAuthState();
  }catch(err){
    if(err.status === 401){ Store.clearToken(); localStorage.removeItem("user"); renderAuthState(); }
  }
}

/* ===== جرس الإشعارات (موحّد بكل الصفحات) ===== */
const NOTIF_ICONS = { success:"fa-circle-check", danger:"fa-circle-xmark", info:"fa-circle-info" };

function ensureNotifPanel(){
  let panel = document.getElementById("notifPanel");
  if(panel) return panel;
  panel = document.createElement("div");
  panel.id = "notifPanel";
  panel.className = "notif-panel";
  panel.innerHTML = `<div class="notif-panel-head">الإشعارات</div><div id="notifPanelBody"></div>`;
  document.body.appendChild(panel);
  document.addEventListener("click", (e)=>{
    if(!e.target.closest("#notifPanel") && !e.target.closest("#notifBellBtn")){
      panel.classList.remove("show");
    }
  });
  return panel;
}

function timeAgo(iso){
  try{
    const diffMs = Date.now() - new Date(iso.replace(" ","T")+"Z").getTime();
    const mins = Math.floor(diffMs/60000);
    if(mins < 1) return "الآن";
    if(mins < 60) return `منذ ${mins} د`;
    const hrs = Math.floor(mins/60);
    if(hrs < 24) return `منذ ${hrs} س`;
    const days = Math.floor(hrs/24);
    return `منذ ${days} يوم`;
  }catch(e){ return ""; }
}

async function loadNotifications(){
  const badge = document.getElementById("notifBadge");
  if(!Store.token()){ if(badge) badge.style.display = "none"; return; }
  try{
    const data = await apiFetch("/notifications");
    if(badge){
      if(data.unread > 0){ badge.textContent = data.unread > 9 ? "9+" : data.unread; badge.style.display = "flex"; }
      else{ badge.style.display = "none"; }
    }
    handleIncomingNotifications(data.items);
    const body = document.getElementById("notifPanelBody");
    if(body){
      if(!data.items.length){
        body.innerHTML = `<div class="notif-empty"><i class="fa-solid fa-bell-slash" style="font-size:20px; margin-bottom:8px; display:block;"></i>ما في إشعارات بعد</div>`;
      } else {
        body.innerHTML = data.items.map(n => `
          <div class="notif-item ${n.kind}">
            <i class="fa-solid ${NOTIF_ICONS[n.kind] || 'fa-circle-info'}"></i>
            <div style="flex:1;">
              <div class="t">${n.title}</div>
              <div class="m">${n.message || ""}</div>
              <div class="d">${timeAgo(n.created_at)}</div>
            </div>
          </div>`).join("");
      }
    }
  }catch(err){ /* تجاهل بهدوء */ }
}

function setupNotifBell(){
  const btn = document.getElementById("notifBellBtn");
  if(!btn) return;
  const panel = ensureNotifPanel();
  btn.addEventListener("click", async (e)=>{
    e.stopPropagation();
    panel.classList.toggle("show");
    if(panel.classList.contains("show")){
      await loadNotifications();
      const badge = document.getElementById("notifBadge");
      if(badge && badge.style.display !== "none"){
        try{ await apiFetch("/notifications/mark-read", { method:"POST" }); badge.style.display = "none"; }catch(e){}
      }
    }
  });
}

/* ===== وضع الصيانة ===== */
let _maintenanceInterval = null;

function formatMaintenanceCountdown(sec){
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return [h, m, s].map(n => String(n).padStart(2, "0")).join(" / ");
}

function showMaintenanceScreen(secondsLeft, info){
  const escHtml = (s)=> String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  if(document.getElementById("maintenanceOverlay")) return;
  const overlay = document.createElement("div");
  overlay.id = "maintenanceOverlay";
  overlay.style.cssText = "position:fixed; inset:0; z-index:99999; background:var(--bg,#0b0d14); display:flex; flex-direction:column; align-items:center; justify-content:center; gap:14px; text-align:center; padding:24px;";
  const reason = (info && info.reason) || "";
  const note = (info && info.note) || "";
  overlay.innerHTML = `
    <i class="fa-solid fa-screwdriver-wrench" style="font-size:42px; color:var(--accent,#e63946);"></i>
    <div style="font-size:16px; font-weight:800; color:var(--text,#fff); max-width:320px; line-height:1.6;">
      ${reason ? escHtml(reason) : "عذراً الموقع في فترة الصيانة<br>نعمل على تحديثات أفضل"}
    </div>
    ${note ? `<div style="font-size:12px; color:var(--muted); max-width:320px; line-height:1.8;">${escHtml(note)}</div>` : ""}
    <div id="maintenanceCountdown" style="font-family:'Orbitron',monospace; font-size:22px; font-weight:800; color:var(--accent,#e63946); letter-spacing:1px;">
      ${formatMaintenanceCountdown(secondsLeft)}
    </div>`;
  document.documentElement.appendChild(overlay);
  document.body.style.overflow = "hidden";

  // مخرج جميل للأدمن: زر لوحة التحكم + زر دخول للمتجر (معاينة) — للمشرفين فقط
  try{
    const isAdmin = !!localStorage.getItem("admin_token") || !!(Store.user() && Store.user().is_admin);
    if(isAdmin){
      const btn = document.createElement("button");
      btn.id = "maintenanceAdminBtn";
      btn.innerHTML = '<i class="fa-solid fa-user-shield"></i> لوحة التحكم';
      btn.style.cssText = "margin-top:6px; padding:12px 30px; border-radius:99px; border:1px solid rgba(255,194,75,.6); font-size:14px; font-weight:800; color:#3a1f00; cursor:pointer; background:linear-gradient(135deg, var(--gold,#ffc24b), var(--gold-2,#e0a83a)); box-shadow:0 0 22px var(--gold-glow, rgba(255,194,75,.35)); display:flex; align-items:center; gap:8px; animation:aiBlink 2s infinite;";
      btn.onclick = ()=>{ location.href = "/admin.html"; };
      overlay.appendChild(btn);
      const prev = document.createElement("button");
      prev.id = "maintenancePreviewBtn";
      prev.innerHTML = '<i class="fa-solid fa-eye"></i> دخول للمتجر (معاينة الأدمن)';
      prev.style.cssText = "padding:11px 26px; border-radius:99px; border:1px solid var(--border); font-size:13px; font-weight:800; color:var(--text); cursor:pointer; background:var(--card-soft); display:flex; align-items:center; gap:8px;";
      prev.onclick = ()=>{ enterAdminPreview(); };
      overlay.appendChild(prev);
      const note2 = document.createElement("div");
      note2.style.cssText = "font-size:10.5px; color:var(--muted);";
      note2.textContent = "هذه الأزرار تظهر لك فقط كمشرف";
      overlay.appendChild(note2);
    }
  }catch(e){}

  let remaining = secondsLeft;
  _maintenanceInterval = setInterval(()=>{
    remaining -= 1;
    if(remaining <= 0){
      clearInterval(_maintenanceInterval);
      location.reload();
      return;
    }
    const el = document.getElementById("maintenanceCountdown");
    if(el) el.textContent = formatMaintenanceCountdown(remaining);
  }, 1000);
}

async function checkMaintenanceMode(){
  // لوحة تحكم الأدمن وصفحة تسجيل الدخول لازم تبقى وصولة دايماً عشان الأدمن يقدر يسجّل دخول ويوقف الصيانة
  if(location.pathname.includes("admin.html") || location.pathname.includes("login.html")) return;
  try{
    const res = await fetch(API_BASE + "/maintenance-status");
    const data = await res.json();
    if(data.enabled){
      // معاينة الأدمن: يتجول بحرية ليرى المتجر والمنتجات كما هي
      try{
        if(sessionStorage.getItem("as_admin_preview") === "1"){
          const isAdmin = !!localStorage.getItem("admin_token") || !!(Store.user() && Store.user().is_admin);
          if(isAdmin){ showPreviewBadge(); return; }
          sessionStorage.removeItem("as_admin_preview");
        }
      }catch(e){}
      showMaintenanceScreen(data.seconds_left, data);
    }
  }catch(err){ /* تجاهل أي خطأ شبكة هون، ما منوقف الموقع لأجل هيك */ }
}

/* معاينة الأدمن أثناء الصيانة: دخول للمتجر + شارة خروج عائمة */
function enterAdminPreview(){
  try{ sessionStorage.setItem("as_admin_preview", "1"); }catch(e){}
  const ov = document.getElementById("maintenanceOverlay");
  if(ov) ov.remove();
  if(_maintenanceInterval){ clearInterval(_maintenanceInterval); _maintenanceInterval = null; }
  document.body.style.overflow = "";
  showPreviewBadge();
  toast("👁 وضع معاينة الأدمن — تتصفح كالزوار تماماً");
}
function showPreviewBadge(){
  if(document.getElementById("adminPreviewBadge")) return;
  const b = document.createElement("button");
  b.id = "adminPreviewBadge";
  b.innerHTML = '<i class="fa-solid fa-eye"></i> معاينة الأدمن — خروج';
  b.style.cssText = "position:fixed; bottom:150px; right:12px; z-index:120; padding:9px 14px; border-radius:99px; border:1px solid rgba(255,194,75,.6); font-size:11px; font-weight:800; color:#3a1f00; cursor:pointer; background:linear-gradient(135deg, var(--gold,#ffc24b), var(--gold-2,#e0a83a)); box-shadow:0 6px 18px rgba(0,0,0,.4); display:flex; align-items:center; gap:6px;";
  b.onclick = ()=>{
    try{ sessionStorage.removeItem("as_admin_preview"); }catch(e){}
    location.reload();
  };
  document.body.appendChild(b);
}

document.addEventListener("DOMContentLoaded", ()=>{
  applyTranslations();
  renderAuthState();
  setupFab();
  loadSiteBranding();
  askNotifPermission();
  setActiveNav();
  setupNotifBell();
  syncUserState();
  loadNotifications();
  checkMaintenanceMode();
  setTimeout(enableWebPush, 900);
  // تحديث الرصيد كل 30 ثانية بشكل صامت (يستخدم syncUserState الموجودة أصلاً)
  setInterval(syncUserState, 30000);
  setInterval(loadNotifications, 30000);
});
