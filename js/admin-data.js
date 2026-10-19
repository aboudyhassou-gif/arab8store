/* =========================================================
   ARAB ADMIN — admin-data.js
   منطق تنقّل لوحة التحكم + كل البيانات حقيقية من السيرفر
   (ولا قيمة وهمية متبقية — كل قسم متصل بـ /api/admin/*)
   ========================================================= */

const SECTION_TITLES = {
  dashboard:"الرئيسية", orders:"الطلبات", deposits:"الإيداعات",
  users:"المستخدمون", "discount-tiers":"المستويات", products:"المنتجات",
  "smart-admin":"الإدارة الذكية", backup:"النسخ الاحتياطي", logs:"سجل الأدمن",
  "ai-agent":"المساعد الذكي",
  whatsapp:"بوت واتساب",
};

const SECTION_LOADERS = {
  dashboard: ()=>Promise.all([loadDashboard(), loadProfits(), loadSettings(), loadAdmins(), loadWebAdmins(), loadPushStatus()]),

  orders: ()=>Promise.all([loadOrders("all"), loadShopOrders()]),
  deposits: ()=>Promise.all([loadDeposits(), loadDepositMethods()]),
  users: loadUsers,
  "discount-tiers": ()=>Promise.all([loadDiscountTiers(), loadTierMatrix()]),
  products: ()=>Promise.all([loadProducts(), loadSections()]),
  "smart-admin": ()=>Promise.all([loadProviders(), loadPricing()]),
  backup: ()=>Promise.all([loadBackups(), loadSnaps()]),
  logs: loadAdminLogs,
  "ai-agent": ()=>Promise.all([loadAiAgent(), loadAiMemory()]),
  whatsapp: ()=>Promise.all([loadWhatsApp(), loadWhatsAppMessages()]),
};
async function changeAdminPassword(){
  const cur = document.getElementById("admCurPw").value, nw = document.getElementById("admNewPw").value;
  if(!cur || nw.length < 8){ toast("أدخل الحالية والجديدة (8+ أحرف)", "error"); return; }
  try{
    const r = await adminFetch("/admin/password", { method:"POST", body: JSON.stringify({ current: cur, new: nw }) });
    toast(r.message); document.getElementById("admCurPw").value = ""; document.getElementById("admNewPw").value = "";
  }catch(err){ toast(err.message, "error"); }
}
async function loadSnaps(){
  const body = document.getElementById("snapsTableBody");
  if(!body) return;
  try{
    const data = await adminFetch("/admin/snapshots");
    body.innerHTML = data.map(s=>`<tr><td>${s.reason}</td><td>${s.created_at}</td><td>${s.size_kb} KB</td>
      <td class="row-actions"><button class="btn-sm primary" onclick="restoreSnap('${s.id}')">استرجاع</button>
      <button class="btn-sm danger" onclick="deleteSnap('${s.id}')">حذف</button></td></tr>`).join("")
      || `<tr><td colspan="4">لا توجد نسخ تلقائية بعد</td></tr>`;
  }catch(err){ body.innerHTML = `<tr><td colspan="4">${err.message}</td></tr>`; }
}
async function restoreSnap(id){
  if(!confirm("استرجاع هذه النسخة؟ سيتم استبدال البيانات الحالية.")) return;
  try{ const r = await adminFetch(`/admin/snapshots/${encodeURIComponent(id)}/restore`, { method:"POST" }); toast(r.message); setTimeout(()=>location.reload(), 1000); }
  catch(err){ toast(err.message, "error"); }
}
async function deleteSnap(id){
  try{ await adminFetch(`/admin/snapshots/${encodeURIComponent(id)}`, { method:"DELETE" }); loadSnaps(); }
  catch(err){ toast(err.message, "error"); }
}
function downloadJsonBackup(){
  const token = localStorage.getItem("admin_token") || "";
  const a = document.createElement("a");
  a.href = "/api/admin/backup-json?token=" + encodeURIComponent(token);
  a.download = "arab-store-backup.json";
  document.body.appendChild(a); a.click(); a.remove();
  toast("جاري تنزيل النسخة…");
}
async function restoreJsonBackup(input){
  const f = input.files && input.files[0];
  if(!f) return;
  if(!confirm("استرجاع هذا الملف؟ سيتم استبدال البيانات الحالية (تُؤخذ نسخة أمان أولاً).")){ input.value=""; return; }
  const fd = new FormData(); fd.append("file", f);
  try{ const r = await adminFetch("/admin/restore-json", { method:"POST", body: fd }); toast(r.message); setTimeout(()=>location.reload(), 1200); }
  catch(err){ toast(err.message, "error"); }
  input.value = "";
}

function goSection(name, navEl){
  if(ADMIN_ME && ADMIN_ME.stale){ showStaleSession(); return; }
  if(ADMIN_ME && ADMIN_ME.restricted && !(ADMIN_ME.sections || []).includes(name)){
    showSectionLocked(name);
    document.querySelectorAll(".admin-nav-item").forEach(n=>n.classList.remove("active"));
    if(navEl) navEl.classList.add("active");
    document.getElementById("sectionTitle").textContent = SECTION_TITLES[name] || name;
    toggleSidebar(false);
    window.scrollTo({ top:0, behavior:"smooth" });
    return;
  }
  document.getElementById("secLocked").style.display = "none";
  document.querySelectorAll(".admin-section").forEach(s=>s.classList.remove("active"));
  document.getElementById("sec-"+name)?.classList.add("active");
  document.querySelectorAll(".admin-nav-item").forEach(n=>n.classList.remove("active"));
  if(navEl) navEl.classList.add("active");
  document.getElementById("sectionTitle").textContent = SECTION_TITLES[name] || name;
  toggleSidebar(false);
  window.scrollTo({ top:0, behavior:"smooth" });
  applyViewMode(name);
  SECTION_LOADERS[name]?.().catch(err=> toast(err.message, "error"));
}

/* لافتة القسم المغلق + وضع المشاهدة فقط */
function showSectionLocked(name){
  document.querySelectorAll(".admin-section").forEach(s=>s.classList.remove("active"));
  const box = document.getElementById("secLocked");
  document.getElementById("secLockedIcon").textContent = "🔐";
  document.getElementById("secLockedTitle").textContent = SECTION_TITLES[name] || name;
  document.getElementById("secLockedMsg").innerHTML = "هذا القسم خاص بالمالك لأسباب أمنية<br>تواصل مع مالك المتجر لمنحك الصلاحية";
  document.getElementById("secLockedBtn").style.display = "none";
  box.style.display = "block";
}
/* جلسة قديمة بلا هوية (صدرت قبل نظام الصلاحيات): ليست حظراً — فقط أعد الدخول بحسابك */
function showStaleSession(){
  document.querySelectorAll(".admin-section").forEach(s=>s.classList.remove("active"));
  document.querySelectorAll(".admin-nav-item").forEach(n=>n.classList.remove("active"));
  const box = document.getElementById("secLocked");
  document.getElementById("secLockedIcon").textContent = "🔄";
  document.getElementById("secLockedTitle").textContent = "انتهت صلاحية الجلسة";
  document.getElementById("secLockedMsg").innerHTML = "صلاحياتك محفوظة لكن هذه الجلسة قديمة ولا تحمل هويتك<br>سجّل خروج ثم ادخل مجدداً <b>بحسابك الخاص</b> لتُطبق صلاحياتك فوراً";
  document.getElementById("secLockedBtn").style.display = "block";
  box.style.display = "block";
  document.getElementById("sectionTitle").textContent = "لوحة التحكم";
  toggleSidebar(false);
  window.scrollTo({ top:0, behavior:"smooth" });
}
function applyViewMode(name){
  document.querySelectorAll(".perm-view-banner").forEach(b=>b.remove());
  document.querySelectorAll(".admin-section.perm-view").forEach(s=>s.classList.remove("perm-view"));
  const sec = document.getElementById("sec-" + name);
  if(!sec) return;
  if(ADMIN_ME && ADMIN_ME.restricted && (ADMIN_ME.sections || []).includes(name) && !(ADMIN_ME.edit || []).includes(name)){
    sec.classList.add("perm-view");
    const banner = document.createElement("div");
    banner.className = "perm-view-banner";
    banner.innerHTML = '<i class="fa-solid fa-eye"></i> وضع المشاهدة فقط — يمكنك رؤية البيانات لكن التعديل معطّل (تواصل مع المالك)';
    sec.prepend(banner);
  }
}

function toggleSidebar(open){
  document.getElementById("adminSidebar").classList.toggle("open", open);
  document.getElementById("adminOverlay").classList.toggle("show", open);
}

/* ===== صلاحيات الأقسام (يتحكم بها المالك لكل أدمن) ===== */
let ADMIN_ME = null;
function canSeeSection(name){
  if(!ADMIN_ME || !ADMIN_ME.restricted) return true;
  return (ADMIN_ME.sections || []).includes(name);
}
function canEditSection(name){
  if(!ADMIN_ME || !ADMIN_ME.restricted) return true;
  return (ADMIN_ME.edit || []).includes(name);
}
async function initAdminPerms(){
  // تُستدعى قبل تحميل أي بيانات — الفشل لا يمنع اللوحة أبداً (صلاحية كاملة افتراضياً)
  try{
    ADMIN_ME = await adminFetch("/admin/me");
  }catch(err){ ADMIN_ME = null; return; }
  applySectionPerms();
}
function applySectionPerms(){
  if(!ADMIN_ME || !ADMIN_ME.restricted) return;
  if(ADMIN_ME.stale){ showStaleSession(); return; }
  const allowed = ADMIN_ME.sections || [];
  const editable = ADMIN_ME.edit || [];
  document.querySelectorAll(".admin-nav-item[data-section]").forEach(n=>{
    const s = n.dataset.section;
    n.querySelector(".perm-tag")?.remove();
    if(!allowed.includes(s)){
      const tag = document.createElement("span");
      tag.className = "perm-tag";
      tag.textContent = " 🔒";
      tag.title = "خاص بالمالك لأسباب أمنية";
      n.appendChild(tag);
    }else if(!editable.includes(s)){
      const tag = document.createElement("span");
      tag.className = "perm-tag";
      tag.textContent = " 👁";
      tag.title = "مشاهدة فقط";
      n.appendChild(tag);
    }
  });
  if(!allowed.length){
    toast("لا تملك صلاحية أي قسم — تواصل مع المالك 🔐", "error");
    showSectionLocked("dashboard");
    document.getElementById("sectionTitle").textContent = "لوحة التحكم";
    return;
  }
  // فعّل أول قسم مسموح بدل الرئيسية إن كانت محجوبة
  const cur = document.querySelector(".admin-section.active")?.id?.replace("sec-", "");
  if(!cur || !allowed.includes(cur)){
    const first = allowed[0];
    goSection(first, document.querySelector(`.admin-nav-item[data-section="${first}"]`));
  }else{
    applyViewMode(cur);
  }
}

/* ===== أداة استدعاء API بصلاحية الأدمن ===== */
async function adminFetch(path, opts={}){
  const token = localStorage.getItem("admin_token");
  const headers = Object.assign({ "Accept":"application/json" }, opts.headers || {});
  if(token) headers["Authorization"] = "Bearer " + token;
  if(opts.body && !(opts.body instanceof FormData)) headers["Content-Type"] = "application/json";
  const res = await fetch(API_BASE + path, Object.assign({}, opts, { headers }));
  const data = await res.json().catch(()=>null);
  if(res.status === 401){ adminLogout(); throw new Error("انتهت الجلسة"); }
  if(!res.ok) throw new Error((data && data.message) || `حدث خطأ (رمز ${res.status}) — انسخ هذه الرسالة وأرسلها للدعم`);
  return data;
}

let lastCatalogBatchId = "";
async function importCatalogCsv(){
  const input = document.getElementById("catalogCsvInput");
  const result = document.getElementById("catalogImportResult");
  const file = input?.files?.[0];
  if(!file){ toast("اختر ملف CSV أولاً", "error"); return; }
  const fd = new FormData(); fd.append("file", file);
  if(result) result.textContent = "جارِ الاستيراد، يرجى الانتظار...";
  try{
    const data = await adminFetch("/admin/catalog/import-csv", { method:"POST", body:fd });
    lastCatalogBatchId = data.batch_id || "";
    if(result) result.textContent = `${data.message}. تم تجاهل ${data.skipped_unknown} منتج غير معروف و${data.skipped_duplicate} مكرر.`;
    document.getElementById("catalogRollbackBtn").style.display = lastCatalogBatchId ? "inline-flex" : "none";
    toast("تم استيراد المنتجات ✅");
    loadProducts(); loadSections();
  }catch(err){ if(result) result.textContent = err.message; toast(err.message, "error"); }
}
async function rollbackCatalogImport(){
  if(!lastCatalogBatchId || !confirm("هل تريد حذف آخر دفعة مستوردة؟")) return;
  try{
    const data = await adminFetch(`/admin/catalog/import/${encodeURIComponent(lastCatalogBatchId)}`, { method:"DELETE" });
    toast(data.message); lastCatalogBatchId = "";
    document.getElementById("catalogRollbackBtn").style.display = "none";
    document.getElementById("catalogImportResult").textContent = data.message;
    loadProducts(); loadSections();
  }catch(err){ toast(err.message, "error"); }
}
async function clearCatalogProducts(){
  if(!confirm("سيتم حذف كل المنتجات والباقات نهائياً. متابعة؟")) return;
  try{
    const data = await adminFetch("/admin/catalog/clear", { method:"POST" });
    toast(data.message); loadProducts(); loadSections();
  }catch(err){ toast(err.message, "error"); }
}
async function brandAllImages(){
  try{
    toast("جاري توليد الصور… ⏳");
    const data = await adminFetch("/admin/catalog/brand-images", { method:"POST" });
    toast(data.message); loadProducts();
  }catch(err){ toast(err.message, "error"); }
}
/* التوليد الجماعي عبر API الخارجي — دفعات متتالية (2 بكل طلب) مع شريط تقدم،
   يعمل بأمان على Vercel مهما كان عدد المنتجات. يتخطى الصور الحقيقية المرفوعة. */
let bulkAiRunning = false;
function stopBulkAi(){ bulkAiRunning = false; }
async function bulkAiImages(){
  if(bulkAiRunning) return;
  bulkAiRunning = true;
  const bar = document.getElementById("bulkAiBar");
  const wrap = document.getElementById("bulkAiProgress");
  const label = document.getElementById("bulkAiLabel");
  const failsBox = document.getElementById("bulkAiFails");
  const btn = document.getElementById("bulkAiBtn");
  if(btn) btn.disabled = true;
  wrap.style.display = "block";
  failsBox.textContent = "";
  let doneTotal = 0, failSeen = new Set(), grand = null, retries = 0, deadRounds = 0;
  const LIMIT = 2;
  try{
    while(bulkAiRunning){
      label.textContent = `جاري التوليد… تم ${doneTotal}${grand ? " / " + grand : ""} ⏳`;
      let res;
      try{
        // offset=0 دائماً: الباكند يعطي أول دفعة من المتبقي (المعالَج يخرج من القائمة)
        res = await adminFetch("/admin/catalog/brand-images/bulk", {
          method:"POST", body: JSON.stringify({ limit: LIMIT, offset: 0 })
        });
        retries = 0;
      }catch(err){
        // محاولة أخيرة واحدة قبل التوقف (انقطاع لحظي / مهلة Vercel)
        if(++retries > 1) throw err;
        label.textContent = "انقطاع لحظي — إعادة المحاولة… ⏳";
        await new Promise(r=>setTimeout(r, 2500));
        continue;
      }
      doneTotal += (res.updated || 0);
      if(grand === null) grand = doneTotal + (res.total || 0);
      (res.failed || []).forEach(f=>{
        const k = "p" + f.id;
        if(!failSeen.has(k)){
          failSeen.add(k);
          failsBox.innerHTML += `<div>⚠️ ${escapeHtml(f.name || ("#" + f.id))}: ${escapeHtml(f.error || "")}</div>`;
        }
      });
      const pct = grand ? Math.min(100, Math.round(doneTotal / grand * 100)) : 100;
      bar.style.width = pct + "%";
      label.textContent = `تم ${doneTotal}${grand ? " / " + grand : ""} ✅`;
      if(res.done) break;
      if((res.updated || 0) === 0 && (res.failed || []).length > 0){
        // دفعة فاشلة بالكامل (API متوقف مثلاً) — لا تدور للأبد
        if(++deadRounds >= 3){
          label.textContent = "توقف: 3 دفعات فاشلة متتالية — تحقق من API الصور ثم أعد التشغيل";
          toast("توقف التوليد: فشل متكرر — تحقق من API الصور", "error");
          break;
        }
      }else{
        deadRounds = 0;
      }
      await new Promise(r=>setTimeout(r, 800));
    }
    if(!bulkAiRunning){
      toast("تم إيقاف التوليد الجماعي", "error");
    }else if(deadRounds < 3){
      bar.style.width = "100%";
      label.textContent = `اكتمل التوليد الجماعي ✅ (${doneTotal} منتج، فشل ${failSeen.size})`;
      toast(`اكتمل التوليد الجماعي ✅ (${doneTotal} منتج)`);
      loadProducts();
    }
  }catch(err){
    label.textContent = "توقف بخطأ: " + err.message;
    toast(err.message, "error");
  }finally{
    bulkAiRunning = false;
    if(btn) btn.disabled = false;
  }
}

const STATUS_LABEL = { processing:"قيد التنفيذ", completed:"مكتمل", failed:"فشل", pending:"بإنتظار المراجعة" };

/* ===== رفع الصور (أقسام / منتجات / فئات) ===== */
let pendingUploadTarget = null;
function pickImage(kind, id){
  pendingUploadTarget = { kind, id };
  document.getElementById("globalImageInput").value = "";
  document.getElementById("globalImageInput").click();
}
document.addEventListener("DOMContentLoaded", ()=>{
  document.getElementById("globalImageInput")?.addEventListener("change", async (e)=>{
    const file = e.target.files[0];
    if(!file || !pendingUploadTarget) return;
    if(file.size > 4 * 1024 * 1024){ toast("الصورة أكبر من 4MB — صغّرها وحاول مجدداً", "error"); return; }
    const nm = (file.name || "").toLowerCase();
    if(nm.endsWith(".heic") || nm.endsWith(".heif") || file.type === "image/heic"){
      toast("صيغة HEIC غير مدعومة — حوّل الصورة إلى JPG أو PNG أولاً", "error"); return;
    }
    const { kind, id } = pendingUploadTarget;
    const endpoints = {
      section:`/admin/sections/${id}/image`, product:`/admin/products/${id}/image`,
      category:`/admin/categories/${id}/image`, banner:`/admin/settings/banner-image`,
      logo:`/admin/settings/logo`, subsection:`/admin/subsections/${id}/image`,
      manual_method:`/admin/deposit-methods/manual/${id}/image`, auto_method:`/admin/deposit-methods/auto/${id}/image`,
      app_icon:`/admin/settings/app-icon`, dev_logo:`/admin/settings/dev-logo`,
      notif_icon:`/admin/settings/notif-icon`,
    };
    const fd = new FormData();
    fd.append("file", file);
    try{
      await adminFetch(endpoints[kind], { method:"POST", body: fd });
      toast("تم رفع الصورة ✅");
      if(kind === "section") loadSections();
      if(kind === "product") loadProducts();
      if(kind === "category") loadCategories();
      if(kind === "subsection") loadSubsections();
      if(kind === "banner" || kind === "logo" || kind === "app_icon" || kind === "dev_logo" || kind === "notif_icon") loadSettings();
      if(kind === "manual_method" || kind === "auto_method") loadDepositMethods();
    }catch(err){ toast(err.message, "error"); }
  });
});

async function renderTables(){
  await loadDashboard().catch(err=> toast(err.message, "error"));
  loadAdminAlerts();
  askAdminNotificationPermission();
  setInterval(loadAdminAlerts, 30000);
}

/* ===== زر التنبيهات بهيدر لوحة الأدمن ===== */
const ADMIN_NOTIF_SEEN_KEY = "adminLastNotifId";
let adminNotifBootstrapped = false;

function askAdminNotificationPermission(){
  if(!("Notification" in window)) return;
  if(Notification.permission === "default"){
    Notification.requestPermission().then((permission)=>{ if(permission === "granted") enableAdminWebPush(); }).catch(()=>{});
  } else if(Notification.permission === "granted") enableAdminWebPush();
}

function adminPushKeyBytes(base64){
  const padding = "=".repeat((4 - base64.length % 4) % 4);
  const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from([...raw].map(ch => ch.charCodeAt(0)));
}

async function enableAdminWebPush(){
  if(!("serviceWorker" in navigator) || !("PushManager" in window)) return;
  try{
    const keyRes = await fetch(API_BASE + "/push/public-key");
    const keyData = await keyRes.json();
    if(!keyData.enabled || !keyData.public_key || Notification.permission !== "granted") return;
    const registration = await navigator.serviceWorker.register("/sw.js");
    let subscription = await registration.pushManager.getSubscription();
    if(!subscription){
      subscription = await registration.pushManager.subscribe({ userVisibleOnly:true, applicationServerKey:adminPushKeyBytes(keyData.public_key) });
    }
    await adminFetch("/admin/push/subscribe", { method:"POST", body:JSON.stringify(subscription.toJSON()) });
  }catch(err){ /* إشعارات الخلفية اختيارية */ }
}

/* زر صريح لتفعيل Push الأدمن على الجهاز الحالي — مع تأكيد مرئي */
async function enableAdminPushUI(){
  if(!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)){
    toast("متصفحك لا يدعم الإشعارات", "error"); return;
  }
  if(Notification.permission === "denied"){
    toast("الإشعارات محظورة من إعدادات المتصفح — اسمح بها أولاً", "error"); return;
  }
  if(Notification.permission === "default"){
    try{ await Notification.requestPermission(); }catch(e){}
  }
  if(Notification.permission !== "granted"){ toast("لم يتم السماح بالإشعارات", "error"); return; }
  await enableAdminWebPush();
  try{
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    if(sub){ toast("تم تفعيل إشعارات الأدمن ✅ ستصلك حتى والموقع مغلق"); loadPushStatus(); }
    else toast("تعذّر الاشتراك — حاول مجدداً", "error");
  }catch(err){ toast("تعذّر التفعيل", "error"); }
}

function showAdminSystemNotification(n){
  if(!("Notification" in window) || Notification.permission !== "granted") return;
  try{
    const note = new Notification(n.title || "تنبيه جديد", { body:n.message || "", icon:"/site-icon", tag:"arab-admin-" + n.id });
    note.onclick = ()=>{ window.focus(); };
  }catch(e){}
}

async function loadAdminAlerts(){
  try{
    const [a, n] = await Promise.all([
      adminFetch("/admin/alerts-count"),
      adminFetch("/admin/notifications")
    ]);
    const badge = document.getElementById("adminAlertsBadge");
    if(a.total > 0){
      badge.style.display = "flex";
      badge.textContent = a.total > 99 ? "99+" : a.total;
    } else {
      badge.style.display = "none";
    }
    const list = document.getElementById("adminAlertsList");
    const items = (n.items || []).map(x => `<div class="admin-alert-item"><i class="fa-solid fa-bell"></i><span><b>${x.title}</b><br><small>${x.message || ""}</small></span></div>`);
    if(a.pending_deposits > 0) items.push(`<div class="admin-alert-item" onclick="goSection('deposits', document.querySelector('[data-section=deposits]')); toggleAdminAlerts(false);"><i class="fa-solid fa-credit-card"></i> ${a.pending_deposits} طلب إيداع بانتظار المراجعة</div>`);
    if(a.pending_shop_orders > 0) items.push(`<div class="admin-alert-item" onclick="goSection('orders', document.querySelector('[data-section=orders]')); toggleAdminAlerts(false);"><i class="fa-solid fa-bolt"></i> ${a.pending_shop_orders} طلب يدوي بانتظار المراجعة</div>`);
    list.innerHTML = items.join("") || `<div class="admin-alert-item empty">لا توجد تنبيهات جديدة 👍</div>`;
    const ids = (n.items || []).map(x => Number(x.id) || 0);
    const maxId = ids.length ? Math.max(...ids) : 0;
    const lastSeen = Number(localStorage.getItem(ADMIN_NOTIF_SEEN_KEY) || 0);
    if(!adminNotifBootstrapped && !lastSeen){
      localStorage.setItem(ADMIN_NOTIF_SEEN_KEY, String(maxId));
      adminNotifBootstrapped = true;
    } else {
      adminNotifBootstrapped = true;
      (n.items || []).filter(x => Number(x.id) > lastSeen).slice(0, 3).forEach(showAdminSystemNotification);
      if(maxId > lastSeen) localStorage.setItem(ADMIN_NOTIF_SEEN_KEY, String(maxId));
    }
  }catch(err){ /* تجاهل */ }
}

function toggleAdminAlerts(force){
  const panel = document.getElementById("adminAlertsPanel");
  const show = force !== undefined ? force : panel.style.display === "none";
  panel.style.display = show ? "block" : "none";
  if(show){
    adminFetch("/admin/notifications/mark-read", { method:"POST" }).catch(()=>{});
    document.getElementById("adminAlertsBadge").style.display = "none";
  }
}
document.addEventListener("click", (e)=>{
  const panel = document.getElementById("adminAlertsPanel");
  if(!panel || panel.style.display === "none") return;
  if(!e.target.closest("#adminAlertsPanel") && !e.target.closest(".icon-btn")) toggleAdminAlerts(false);
});

/* ===== 1) لوحة المعلومات ===== */
async function loadDashboard(){
  fetch("/health").then(r=>r.json()).then(h=>{
    const w = document.getElementById("ephemeralWarn");
    if(w && h && h.storage && h.storage !== "persistent-postgres") w.style.display = "block";
  }).catch(()=>{});
  const stats = await adminFetch("/admin/stats");
  document.getElementById("kpiUsers").textContent = stats.total_users.toLocaleString();
  document.getElementById("kpiOrders").textContent = stats.total_orders.toLocaleString();
  document.getElementById("kpiBalance").textContent = Math.round(stats.total_balance_syp).toLocaleString() + " ل.س";
  document.getElementById("kpiRate").textContent = "1$ = " + stats.exchange_rate.toLocaleString() + " ل.س";
  document.getElementById("kpiTodaySales").textContent = "$" + stats.today_sales_usd.toFixed(2);
  document.getElementById("kpiTodayOrders").textContent = stats.today_orders.toLocaleString();
  document.getElementById("kpiTodayProfit").textContent = "$" + stats.today_profit_usd.toFixed(2);
  document.getElementById("kpiTodayMargin").textContent = stats.today_margin_percent + "%";

  const orders = await adminFetch("/admin/orders");
  document.getElementById("dashOrdersBody").innerHTML = orders.slice(0,5).map(o=>`
    <tr><td>#${o.id}</td><td>${o.user_id}</td><td>${o.product_name}</td><td>${Math.round(o.price_syp).toLocaleString()} ل.س</td>
    <td><span class="status-badge ${o.status}">${STATUS_LABEL[o.status]||o.status}</span></td><td>${o.date}</td></tr>`).join("")
    || `<tr><td colspan="6" class="text-muted" style="text-align:center; padding:16px;">لا توجد طلبات بعد</td></tr>`;

  const deposits = await adminFetch("/admin/deposits");
  const pending = deposits.filter(d=>d.status==="pending");
  document.getElementById("dashDepositsBody").innerHTML = pending.slice(0,5).map(d=>`
    <tr><td>#${d.id}</td><td>${d.full_name||d.user_id}</td><td>${d.method_title}</td><td>$${d.amount_usd}</td>
    <td style="font-family:'Orbitron',monospace; font-size:10px;">${d.code}</td>
    <td><button class="btn-sm primary" onclick="acceptDeposit(${d.id})">قبول</button></td></tr>`).join("")
    || `<tr><td colspan="6" class="text-muted" style="text-align:center; padding:16px;">لا توجد طلبات إيداع معلّقة</td></tr>`;
}

/* ===== 1.5) الأرباح ===== */
const PROFIT_SOURCE_LABEL = { shop:"يدوي", api:"مزوّد API" };
async function loadProfits(){
  const start = document.getElementById("profitsStart").value;
  const end = document.getElementById("profitsEnd").value;
  let path = "/admin/profits";
  const qs = [];
  if(start) qs.push("start="+start);
  if(end) qs.push("end="+end);
  if(qs.length) path += "?" + qs.join("&");

  const data = await adminFetch(path);
  const s = data.summary;
  document.getElementById("profitOrdersCount").textContent = s.total_orders.toLocaleString();
  document.getElementById("profitSales").textContent = "$" + s.total_sales_usd.toFixed(2);
  document.getElementById("profitCost").textContent = "$" + s.total_cost_usd.toFixed(2);
  document.getElementById("profitNet").textContent = "$" + s.total_profit_usd.toFixed(2);

  document.getElementById("profitsTableBody").innerHTML = data.orders.map(o=>`
    <tr>
      <td>#${o.id}</td>
      <td>${PROFIT_SOURCE_LABEL[o.source]||o.source}</td>
      <td>${o.product_name}</td>
      <td>${o.category_name}</td>
      <td>$${o.price_usd.toFixed(2)}</td>
      <td>$${o.cost_usd.toFixed(2)}</td>
      <td style="color:${o.profit_usd>=0?'var(--success)':'var(--danger)'}; font-weight:700;">$${o.profit_usd.toFixed(2)}</td>
      <td>${o.created_at}</td>
    </tr>`).join("")
    || `<tr><td colspan="8" class="text-muted" style="text-align:center; padding:16px;">لا توجد مبيعات مكتملة بهذه الفترة</td></tr>`;
}
function resetProfitsFilter(){
  document.getElementById("profitsStart").value = "";
  document.getElementById("profitsEnd").value = "";
  loadProfits();
}

/* ===== 2) الطلبات ===== */
let allOrdersCache = [];
let adminOrdersFilter = "all";
async function loadOrders(filter){
  allOrdersCache = await adminFetch("/admin/orders");
  if(filter) adminOrdersFilter = filter;
  renderOrdersTable();
}
function renderOrdersTable(){
  const filter = adminOrdersFilter;
  const q = (document.getElementById("ordersSearchInput")?.value || "").trim().toLowerCase();
  const items = allOrdersCache.filter(o => {
    if(filter !== "all" && o.status !== filter) return false;
    if(q){
      const hay = `#${o.id} ${o.track||''} ${o.user_id||''} ${o.product_name||''} ${o.player_id||''} ${o.provider_order||''}`.toLowerCase();
      if(!hay.includes(q)) return false;
    }
    return true;
  });
  document.getElementById("ordersTableBody").innerHTML = items.map(o=>`
    <tr><td>#${o.ref||o.id}<br><small style="color:var(--muted)">${o.source||''}</small></td>
    <td style="font-family:'Orbitron',monospace; font-size:10px; direction:ltr; cursor:pointer;" title="انقر للنسخ" onclick="navigator.clipboard?.writeText('${o.track||''}'); toast('تم نسخ رقم التتبع ✅')">${o.track||'-'}</td>
    <td>${o.user_id}</td><td>${o.product_name}</td><td>${o.player_id||'-'}</td>
    <td>${Math.round(o.price_syp).toLocaleString()} ل.س</td>
    <td><span class="status-badge ${o.status}">${STATUS_LABEL[o.status]||o.status}</span></td>
    <td>
      ${(o.status==='accepted'||o.status==='rejected') ? '—' : `
        <button class="btn-sm primary" onclick="setOrderStatus('${o.ref||('S'+o.id)}','accept')">✅ قبول</button>
        <button class="btn-sm danger" onclick="setOrderStatus('${o.ref||('S'+o.id)}','reject')">❌ رفض</button>`}
      <button class="btn-sm" onclick="printOrderInvoice('${o.ref||('S'+o.id)}')">🖨️</button>
    </td></tr>`).join("")
    || `<tr><td colspan="8" class="text-muted" style="text-align:center; padding:16px;">لا توجد طلبات</td></tr>`;
}

/* ===== 🖨️ فاتورة البطاقة الديجيتال (ESC/POS 58mm) ===== */
function buildInvoiceText(o, store){
  const line = '='.repeat(32);
  const dash = '-'.repeat(32);
  const price = o.price_usd ? `$${(+o.price_usd).toFixed(2)} / ${Math.round(o.price_syp||0).toLocaleString()} ل.س` : '—';
  const rows = [
    (store.name||'ARAB STORE').padStart(parseInt((32+(store.name||'ARAB STORE').length)/2)),
    (store.url||'arab8store.vercel.app').padStart(parseInt((32+(store.url||'').length)/2)),
    line, 'فاتورة طلب رقم: ' + (o.ref||o.id),
    line, dash,
    'المنتج: ' + (o.product_name||''),
    'الزيارة: ' + (o.qty||1),
    'اللاعب: ' + (o.player_id||'-'),
    'التاريخ: ' + (o.date||o.created_at||''),
    'الحالة: ' + (STATUS_LABEL[o.status]||o.status),
    'المبلغ: ' + price,
    dash,
    'شكراً لتعاملكم معنا  🌟',
    'تلقتنا هذا الطلب وأنشأنا له تتبع د.'
  ];
  return rows.filter(Boolean).join('\n') + '\n';
}
/* ===== طباعة مطبعة ميني 58مم عبر Web Bluetooth (RASTER ESC/POS) — نفس أسلوب Fun Print ===== */
const PT_SVDS = [
  '000018f0-0000-1000-8000-00805f9b34fb', '00002af1-0000-1000-8000-00805f9b34fb',
  '0000ae00-0000-1000-8000-00805f9b34fb', '0000ae01-0000-1000-8000-00805f9b34fb',
  '0000ae10-0000-1000-8000-00805f9b34fb',
  '0000ff00-0000-1000-8000-00805f9b34fb', '0000ff01-0000-1000-8000-00805f9b34fb',
  '0000ff02-0000-1000-8000-00805f9b34fb',
  '0000ffe0-0000-1000-8000-00805f9b34fb', '0000ffe1-0000-1000-8000-00805f9b34fb',
  '0000ffe2-0000-1000-8000-00805f9b34fb',
  '0000fff0-0000-1000-8000-00805f9b34fb', '0000fff1-0000-1000-8000-00805f9b34fb',
  '0000fff2-0000-1000-8000-00805f9b34fb',
  '0000fee7-0000-1000-8000-00805f9b34fb', '0000ffff-0000-1000-8000-00805f9b34fb',
  '49535343-fe7d-4ae5-8fa9-9fafd205e455',
  'e7810a71-73ae-499d-8c15-faa916ef0a92',
  '6e400001-b5a3-f393-e0a9-e50e24dcca9e'
];
const BT = { device: null, ch: null, connected: false };
async function btRequestDevice(){
  if (!navigator.bluetooth) throw new Error('Web Bluetooth غير مدعوم — افتح اللوحة في Chrome أندرويد');
  try {
    BT.device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: PT_SVDS });
  } catch (e) {
    if (e && /user|selected/i.test(e.message || '')) throw e;
    throw e;
  }
  BT.device.addEventListener('gattserverdisconnected', () => { BT.connected = false; BT.ch = null; });
  return BT.device;
}
async function btConnect(){
  if (BT.connected && BT.ch) return BT;
  await btRequestDevice();
  try { await BT.device.gatt.connect(); } catch (e) { throw new Error('فشل الاتصال بالمطبعة: ' + (e.message || '')); }
  const svcs = await BT.device.gatt.getPrimaryServices();
  const all = [];
  for (const s of svcs) {
    let cs = [];
    try { cs = await s.getCharacteristics(); } catch (_) { continue; }
    for (const c of cs) if (c.properties && (c.properties.write || c.properties.writeWithoutResponse)) all.push(c);
  }
  const ch = all.find(c => /ae01|ffe1|ff02|2af1|fff2|8841|fa00/i.test(c.uuid))
    || all.find(c => c.properties.writeWithoutResponse)
    || all[0];
  if (!ch) {
    const names = svcs.map(s => s.uuid.slice(4, 8)).join(', ') || '—';
    BT.dbg = 'services=' + names + ' chars=' + all.length;
    throw new Error('NUM_SERVICES=' + svcs.length + ' [' + names + '] — المطبعة لا تقبل كتابة BLE؛ أرسل هذا النص');
  }
  BT.ch = ch; BT.connected = true;
  return BT;
}
async function btWrite(bytes){
  if (!BT.ch) throw new Error('المطبعة غير متصلة');
  const CH = 20;
  for (let i = 0; i < bytes.length; i += CH) {
    const part = Uint8Array.from(bytes.slice(i, i + CH));
    if (BT.ch.properties.write) { try { await BT.ch.writeValue(part); } catch (_) { await BT.ch.writeValueWithoutResponse(part); } }
    else await BT.ch.writeValueWithoutResponse(part);
    await new Promise(r => setTimeout(r, 22));
  }
}
function invRows(o){
  const d = (o.date || o.created_at || '').replace('T', ' ');
  return [
    { t: 'ARAB STORE', s: 22, b: 1, a: 'c' },
    { t: 'arab8store.vercel.app', s: 13, a: 'c' },
    { t: 'ــــــــــــــــــــــــ', s: 14, a: 'c' },
    { t: 'فاتورة طلب رقم: ' + (o.ref || ('S' + o.id)), s: 17, b: 1 },
    { t: 'المنتج: ' + (o.product_name || ''), s: 15 },
    { t: 'الكمية: ' + (o.qty || 1), s: 15 },
    { t: 'اللاعب: ' + (o.player_id || '-'), s: 15 },
    { t: 'التاريخ: ' + d, s: 15 },
    { t: 'الحالة: ' + (STATUS_LABEL[o.status] || o.status || ''), s: 15 },
    { t: 'المبلغ: $' + (+(o.price_usd || 0)).toFixed(2), s: 15, b: 1 },
    { t: o.sku ? ('SKU: ' + o.sku) : '', s: 12 },
    { t: 'ــــــــــــــــــــــــ', s: 14, a: 'c' },
    { t: 'شكراً لتعاملكم معنا', s: 15, a: 'c' }
  ].filter(r => r.t);
}
function buildInvoiceCanvas(o){
  const W = 384, PAD = 12, LH = 1.45;
  const probe = document.createElement('canvas').getContext('2d');
  const rows = invRows(o).map(r => { r.lines = []; return r; });
  let H = PAD + 18;
  for (const r of rows) {
    probe.font = (r.b ? 'bold ' : '') + r.s + 'px Tahoma, sans-serif';
    let cur = '';
    for (const w of String(r.t).split(' ')) {
      const t = cur ? cur + ' ' + w : w;
      if (probe.measureText(t).width <= W - PAD * 2) cur = t;
      else { if (cur) r.lines.push(cur); cur = w; }
    }
    if (cur) r.lines.push(cur);
    H += r.lines.length * (r.s * LH + 6);
  }
  H += PAD;
  const cvs = document.createElement('canvas');
  cvs.width = W; cvs.height = Math.ceil(H / 8) * 8;
  const ctx = cvs.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, cvs.height);
  ctx.fillStyle = '#000'; ctx.textBaseline = 'top';
  let y = PAD + 6;
  for (const r of rows) {
    ctx.font = (r.b ? 'bold ' : '') + r.s + 'px Tahoma, sans-serif';
    for (const ln of r.lines) {
      const wpx = ctx.measureText(ln).width;
      const x = r.a === 'c' ? (W - wpx) / 2 : W - PAD - wpx;
      ctx.fillText(ln, x, y);
      y += r.s * LH + 6;
    }
  }
  return cvs;
}
function escRaster(cvs){
  const ctx = cvs.getContext('2d');
  const W = cvs.width, H = cvs.height, yb = H / 8;
  const out = [0x1B, 0x40, 0x1D, 0x76, 0x30, 0x00, W % 256, (W >> 8) & 0xff, yb % 256, (yb >> 8) & 0xff];
  const img = ctx.getImageData(0, 0, W, H).data;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x += 8) {
      let b = 0;
      for (let k = 0; k < 8; k++) {
        const i = ((y * W) + x + k) * 4;
        if (i < img.length && img[i] < 128) b |= (0x80 >> k);
      }
      out.push(b);
    }
  }
  out.push(0x0A, 0x0A, 0x0A, 0x0A);
  return Uint8Array.from(out);
}


/* ===== نافذة الفاتورة + إرسال إلى المطبعة ===== */
function printOrderInvoice(ref){
  const o = (allOrdersCache||[]).find(x=>(x.ref||('S'+x.id))===ref);
  if(!o){ toast('الطلب غير موجود', 'error'); return; }
  document.getElementById('invModal')?.remove();
  const cvs = buildInvoiceCanvas(o);
  const rowText = (new Date().toLocaleString('en-GB', {timeZone:'Asia/Damascus', hour12:false}));
  const modal = `
  <div id="invModal" style="position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:9999;display:flex;align-items:center;justify-content:center;">
    <div style="background:var(--panel);padding:18px;border-radius:14px;width:420px;max-width:92vw;max-height:90vh;display:flex;flex-direction:column;">
      <h3 style="text-align:center;margin:0 0 8px;">🖨️ معاينة فاتورة #${o.ref||o.id}</h3>
      <div id="invPrev" style="overflow:auto;background:#111;padding:8px;border-radius:10px;flex:1;min-height:120px;"></div>
      <div style="font-size:11px;color:#8aa;margin-top:6px;">الوقت: ${rowText} — الطباعة تتم على ورق 58مم</div>
      <button id="invShareBtn" class="btn-sm primary" style="width:100%;margin-top:10px;" onclick="shareInvoice('${ref}')">📤 إرسال الفاتورة إلى Fun Print / واتساب …</button>
      <button id="invSaveBtn" class="btn-sm" style="width:100%;margin-top:6px;" onclick="saveInvoiceImage('${ref}')">💾 حفظ الصورة في الجهاز (للطباعة من Fun Print)</button>
      <button id="invPrintBtn" class="btn-sm" style="width:100%;margin-top:6px;" onclick="doBtPrint('${ref}')">🖨️ طباعة BLE مباشرة (للمطابع الذكية فقط)</button>
      <button class="btn-sm" style="width:100%;margin-top:6px;" onclick="btReconnect('${ref}')">🔄 إعادة اختيار الجهاز</button>
      <button class="btn-sm" style="width:100%;margin-top:6px;" onclick="closeInvoice()">إغلاق</button>
    </div>
  </div>`;
  document.body.insertAdjacentHTML('beforeend', modal);
  const st = cvs.style; st.maxWidth='100%'; st.height='auto'; st.display='block'; st.margin='auto';
  document.getElementById('invPrev').appendChild(cvs);
  BT.connected = false; BT.ch = null; BT.device = null;
}
async function btReconnect(ref){
  BT.connected = false; BT.ch = null; BT.device = null;
  toast('اختر المطبعات من القائمة');
  doBtPrint(ref);
}
async function doBtPrint(ref){
  const btn = document.getElementById('invPrintBtn');
  try{
    if(btn){ btn.disabled = true; btn.textContent = 'جارِ الاتصال…'; }
    toast('جارِ الاتصال بالمطبعة…');
    await btConnect();
    if(btn){ btn.textContent = 'إرسال البيانات…'; }
    const o = (allOrdersCache||[]).find(x=>(x.ref||('S'+x.id))===ref);
    if(!o) throw new Error('الطلب غير موجود');
    const cvs = buildInvoiceCanvas(o);
    const data = escRaster(cvs);
    await btWrite(data);
    toast('تم إرسال الفاتورة للمطبعة 🖨️');
    closeInvoice();
  }catch(err){
    const d = (typeof BT !== 'undefined' && BT.dbg) ? (' ' + BT.dbg) :
      (BT.device ? (' name=' + (BT.device.name||'?')) : '');
    toast((err.message || 'فشل الوصول للمطبعة') + d, 'error');
  }finally{
    if(btn){ btn.disabled = false; btn.textContent = '🖨️ طباعة عبر Bluetooth'; }
  }
}


function invoiceAsBlob(ref){
  const o = (allOrdersCache||[]).find(x=>(x.ref||('S'+x.id))===ref);
  if(!o) return null;
  const cvs = buildInvoiceCanvas(o);
  return new Promise(res => cvs.toBlob(b => res(b ? {blob:b, o:o} : null), 'image/png'));
}
async function shareInvoice(ref){
  try{
    const r = await invoiceAsBlob(ref);
    if(!r){ toast('الطلب غير موجود', 'error'); return; }
    const file = new File([r.blob], ('invoice-' + (r.o.ref||r.o.id) + '.png'), {type:'image/png'});
    if (navigator.canShare && navigator.canShare({files:[file]})){
      await navigator.share({ files:[file], title:'فاتورة ' + (r.o.ref||r.o.id) });
      toast('اختر Fun Print من القائمة ثم اضغط طباعة 🖨️');
      closeInvoice();
    } else { saveInvoiceImage(ref); }
  }catch(e){
    if(String(e||'').indexOf('Abort')>=0){ return; }
    saveInvoiceImage(ref);
  }
}
async function saveInvoiceImage(ref){
  const r = await invoiceAsBlob(ref);
  if(!r){ toast('الطلب غير موجود', 'error'); return; }
  const file = new File([r.blob], ('invoice-' + (r.o.ref||r.o.id) + '.png'), {type:'image/png'});
  try{
    const a = document.createElement('a');
    a.href = URL.createObjectURL(r.blob); a.download = file.name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=>URL.revokeObjectURL(a.href), 4000);
    toast('حُفظت الصورة في التنزيلات — افتح Fun Print واخترها 🖨️');
    closeInvoice();
  }catch(e){ toast('تعذر الحفظ', 'error'); }
}

function closeInvoice(){ document.getElementById('invModal')?.remove(); }

async function setOrderStatus(ref, action){
  if(!confirm(action==='accept' ? "تأكيد قبول الطلب؟" : "تأكيد رفض الطلب واسترجاع رصيد العميل؟")) return;
  try{
    await adminFetch(`/admin/orders/${ref}/status`, { method:"POST", body: JSON.stringify({ action }) });
    toast(action==='accept' ? "تم قبول الطلب ✅" : "تم رفض الطلب واسترجاع الرصيد");
    loadOrders("all");
  }catch(err){ toast(err.message, "error"); }
}
function filterAdminOrders(status, btn){
  adminOrdersFilter = status;
  document.querySelectorAll("#sec-orders .tab-btn").forEach(b=>b.classList.remove("active"));
  btn.classList.add("active");
  renderOrdersTable();
}

/* ===== 3) طلبات الإيداع ===== */
let allDepositsCache = [];
async function loadDeposits(){
  allDepositsCache = await adminFetch("/admin/deposits");
  renderDepositsTable();
}
function renderDepositsTable(){
  const q = (document.getElementById("depositsSearchInput")?.value || "").trim().toLowerCase();
  const deposits = allDepositsCache.filter(d => {
    if(!q) return true;
    const hay = `#${d.id} ${d.full_name||d.user_id||''} ${d.method_title||''} ${d.code||''}`.toLowerCase();
    return hay.includes(q);
  });
  document.getElementById("depositsTableBody").innerHTML = deposits.map(d=>`
    <tr><td>#${d.id}</td><td>${d.full_name||d.user_id}</td><td>${d.method_title}</td><td>$${d.amount_usd}</td>
    <td>${Math.round(d.amount_syp).toLocaleString()} ل.س</td>
    <td style="font-family:'Orbitron',monospace; font-size:10px;">${d.code}</td>
    <td>${d.status==="pending"
      ? `<button class="btn-sm primary" onclick="acceptDeposit(${d.id})">قبول</button> <button class="btn-sm danger" onclick="rejectDeposit(${d.id})">رفض</button>`
      : `<span class="status-badge ${d.status==='accepted'?'completed':'failed'}">${d.status==='accepted'?'مقبول':'مرفوض'}</span>`}</td></tr>`).join("")
    || `<tr><td colspan="7" class="text-muted" style="text-align:center; padding:16px;">لا توجد طلبات إيداع</td></tr>`;
}
async function acceptDeposit(id){
  try{ await adminFetch(`/admin/deposits/${id}/accept`, { method:"POST" }); toast("تم قبول الإيداع ✅"); loadDeposits(); }
  catch(err){ toast(err.message, "error"); }
}
async function rejectDeposit(id){
  try{ await adminFetch(`/admin/deposits/${id}/reject`, { method:"POST" }); toast("تم رفض الإيداع"); loadDeposits(); }
  catch(err){ toast(err.message, "error"); }
}

/* ===== بث إشعارات Push (تصل حتى والموقع مغلق) ===== */
async function loadPushStatus(){
  try{
    const s = await adminFetch("/admin/push/status");
    const el = document.getElementById("pushSubCount");
    if(el) el.textContent = s.enabled
      ? `🔔 ${s.subscribers} مشترك (${s.users} مستخدم + ${s.guests} ضيف)`
      : "⚠️ غير مفعّل";
  }catch(err){ /* لا نكسر تحميل اللوحة */ }
}
async function sendPushBroadcast(btn){
  const title = document.getElementById("pushTitle").value.trim();
  const message = document.getElementById("pushMessage").value.trim();
  const url = document.getElementById("pushUrl").value.trim() || "/store.html";
  if(!title || !message){ toast("أدخل العنوان والنص", "error"); return; }
  if(!confirm(`بث "${title}" لكل المشتركين؟`)) return;
  if(btn){ btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> جاري البث...'; }
  try{
    const r = await adminFetch("/admin/push/broadcast", { method:"POST", body: JSON.stringify({ title, message, url }) });
    toast(r.message);
    document.getElementById("pushTitle").value = "";
    document.getElementById("pushMessage").value = "";
    loadPushStatus();
  }catch(err){ toast(err.message, "error"); }
  finally{ if(btn){ btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-tower-broadcast"></i> بث الآن'; } }
}

/* ===== المساعد الذكي 🤖 ===== */
const AI_OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
function onAiModelPreset(){
  const sel = document.getElementById("aiModelPreset");
  const v = sel ? sel.value : "";
  if(!v || v === "custom"){ document.getElementById("aiModel")?.focus(); return; }
  document.getElementById("aiModel").value = v;
  const urlEl = document.getElementById("aiUrl");
  if(urlEl && !urlEl.value.trim()) urlEl.value = AI_OPENROUTER_URL;
  toast("تم تعبئة النموذج ✅ الصق المفتاح ثم احفظ وجرّب الاتصال");
}
async function loadAiAgent(){
  for(let attempt = 0; attempt < 2; attempt++){
    try{
      const s = await adminFetch("/admin/ai-agent");
    document.getElementById("aiEnabled").checked = (s.ai_agent_enabled === "true");
    document.getElementById("aiName").value = s.ai_agent_name || "";
    document.getElementById("aiUrl").value = s.ai_agent_api_url || "";
    document.getElementById("aiKey").value = "";
    document.getElementById("aiKey").placeholder = s.ai_agent_api_key ? "تم الحفظ مسبقاً •••••• (اتركه للإبقاء)" : "sk-...";
    document.getElementById("aiModel").value = s.ai_agent_model || "";
    document.getElementById("aiPrompt").value = s.ai_agent_prompt || "";
    document.getElementById("aiWelcome").value = s.ai_agent_welcome || "";
    const ok = (s.ai_agent_enabled === "true") && s.ai_agent_api_url && s.ai_agent_model;
    document.getElementById("aiAgentStatus").textContent = ok ? "🟢 مفعّل وجاهز" : "⚪ غير مفعّل أو ناقص الإعداد";
    return;
    }catch(err){
      if(attempt === 0){ await new Promise(r=>setTimeout(r, 1200)); continue; }
      toast(err.message, "error");
    }
  }
}
async function saveAiAgent(){
  const body = {
    ai_agent_enabled: document.getElementById("aiEnabled").checked ? "true" : "false",
    ai_agent_name: document.getElementById("aiName").value.trim(),
    ai_agent_api_url: document.getElementById("aiUrl").value.trim(),
    ai_agent_model: document.getElementById("aiModel").value.trim(),
    ai_agent_prompt: document.getElementById("aiPrompt").value,
    ai_agent_welcome: document.getElementById("aiWelcome").value.trim(),
  };
  const key = document.getElementById("aiKey").value.trim();
  if(key) body.ai_agent_api_key = key;
  if(body.ai_agent_enabled === "true" && (!body.ai_agent_api_url || !body.ai_agent_model)){
    toast("أدخل رابط الـ API واسم النموذج قبل التفعيل", "error"); return;
  }
  try{
    const r = await adminFetch("/admin/ai-agent", { method:"POST", body: JSON.stringify(body) });
    toast(r.message);
    document.getElementById("aiKey").value = "";
    loadAiAgent();
  }catch(err){ toast(err.message, "error"); }
}
async function testAiAgent(btn){
  const box = document.getElementById("aiTestResult");
  box.textContent = "جارِ تجربة الاتصال... ⏳";
  if(btn){ btn.disabled = true; }
  try{
    const r = await adminFetch("/admin/ai-agent/test", { method:"POST" });
    box.textContent = r.message + "\n\nرد النموذج:\n" + (r.reply || "…");
    toast(r.message);
  }catch(err){ box.textContent = err.message; toast(err.message, "error"); }
  finally{ if(btn) btn.disabled = false; }
}
/* ===== بوت واتساب 💬 ===== */
let WA_POLL = null;
function fmtWaDate(d){
  if(!d) return "—";
  try{ const dt = new Date((d||"").replace(" ","T")+"Z"); return dt.toLocaleString("ar-EG",{hour12:false}); }catch(e){ return d; }
}
async function loadWhatsApp(){
  try{
    const s = await adminFetch("/admin/whatsapp");
    document.getElementById("waEnabled").checked = !!s.enabled;
    document.getElementById("waBotEnabled").checked = !!s.bot_enabled;
    document.getElementById("waAppendLink").checked = !!s.append_link;
    document.getElementById("waPhone").value = s.phone || "";
    document.getElementById("waBotName").value = s.bot_name || "";
    document.getElementById("waStoreUrl").value = s.store_url || "";
    document.getElementById("waGreeting").value = s.greeting || "";
    document.getElementById("waReplyUnknown").value = s.reply_unknown || "";
    document.getElementById("waSecret").value = s.secret || "";
    document.getElementById("waServerUrl").value = (location.origin || "");
    renderWaStatus(s.status, s.pair, s.enabled);
    return s;
  }catch(err){ toast(err.message, "error"); }
}
function renderWaStatus(status, pair, enabled){
  status = status || {}; pair = pair || {};
  const badge = document.getElementById("waStatusBadge");
  const line = document.getElementById("waStatusLine");
  const linked = !!status.linked;
  if(badge){
    badge.textContent = linked ? "🟢 متصل" : (pair.requested ? "🟡 بانتظار الكود" : "⚪ غير مرتبط");
  }
  let txt = "";
  if(linked){
    txt = "✅ الرقم مرتبط: " + (status.me || "—") + (status.platform ? (" (" + status.platform + ")") : "");
    if(status.since) txt += "\nمنذ: " + status.since;
  }else if(pair.requested){
    txt = "⏳ طلب الربط مرسل. تأكد أن الموصل (Connector) شغّال وفي انتظار كود الربط…";
  }else{
    txt = "⚪ غير مرتبط. أدخل الرقم واضغط «ربط جهاز».";
  }
  if(status.error) txt += "\n⚠️ " + status.error;
  if(!enabled) txt += "\n(البوت غير مفعّل — فعّله من الأعلى)";
  if(line) line.textContent = txt;
  const box = document.getElementById("waPairBox");
  if(box){
    if(linked){ box.style.display = "none"; }
    else if(pair.requested || status.code){
      box.style.display = "block";
      document.getElementById("waPairCode").textContent = status.code || "----";
      document.getElementById("waPairHint").textContent = status.code ? "" : "بانتظار توليد الكود من الموصل…";
    }else{ box.style.display = "none"; }
  }
  scheduleWaPoll(pair.requested && !linked, enabled);
}
function scheduleWaPoll(active, enabled){
  if(WA_POLL){ clearTimeout(WA_POLL); WA_POLL = null; }
  if(!active) return;
  WA_POLL = setTimeout(async ()=>{ try{ await loadWhatsApp(); }catch(e){} }, 4000);
}
async function saveWhatsApp(){
  const body = {
    wa_enabled: document.getElementById("waEnabled").checked,
    wa_bot_enabled: document.getElementById("waBotEnabled").checked,
    wa_append_link: document.getElementById("waAppendLink").checked,
    wa_phone: document.getElementById("waPhone").value.trim(),
    wa_bot_name: document.getElementById("waBotName").value.trim(),
    wa_store_url: document.getElementById("waStoreUrl").value.trim(),
    wa_greeting: document.getElementById("waGreeting").value,
    wa_reply_unknown: document.getElementById("waReplyUnknown").value.trim(),
  };
  try{
    const r = await adminFetch("/admin/whatsapp", { method:"POST", body: JSON.stringify(body) });
    toast(r.message);
  }catch(err){ toast(err.message, "error"); }
}
async function waPair(btn){
  const phone = document.getElementById("waPhone").value.trim();
  if(phone.replace(/\D/g,"").length < 8){ toast("أدخل رقم واتساب صحيح مع رمز الدولة", "error"); return; }
  if(btn) btn.disabled = true;
  try{
    // احفظ الإعدادات أولاً حتى يعرف الموصل الرقم
    await adminFetch("/admin/whatsapp", { method:"POST", body: JSON.stringify({ wa_phone: phone }) });
    const r = await adminFetch("/admin/whatsapp/pair", { method:"POST", body: JSON.stringify({ phone }) });
    toast(r.message);
    document.getElementById("waPairBox").style.display = "block";
    document.getElementById("waPairCode").textContent = "----";
    document.getElementById("waPairHint").textContent = "بانتظار توليد الكود من الموصل… (تأكد أنه شغّال)";
    scheduleWaPoll(true, true);
  }catch(err){ toast(err.message, "error"); }
  finally{ if(btn) btn.disabled = false; }
}
async function waLogout(btn){
  if(!confirm("فصل جهاز واتساب المرتبط؟")) return;
  if(btn) btn.disabled = true;
  try{
    const r = await adminFetch("/admin/whatsapp/logout", { method:"POST" });
    toast(r.message); loadWhatsApp();
  }catch(err){ toast(err.message, "error"); }
  finally{ if(btn) btn.disabled = false; }
}
function waCopy(id){
  const el = document.getElementById(id);
  if(!el) return;
  el.select(); el.setSelectionRange(0, 9999);
  navigator.clipboard?.writeText(el.value).then(()=>toast("تم النسخ ✅")).catch(()=>{ document.execCommand("copy"); toast("تم النسخ ✅"); });
}
async function loadWhatsAppMessages(){
  const body = document.getElementById("waMsgTableBody");
  if(!body) return;
  try{
    const [data, hum] = await Promise.all([
      adminFetch("/admin/whatsapp/messages"),
      adminFetch("/admin/whatsapp/humans").catch(()=>({items:[]}))
    ]);
    const openHum = new Set((hum.items || []).map(h=>String(h.number||"")));
    document.getElementById("waMsgCount").textContent = (data.total || 0) + " رسالة" + (openHum.size ? ` • 🔔 ${openHum.size} توجيه للمالك نشط` : "");
    body.innerHTML = (data.items || []).map(m=>{
      const dir = m.direction === "in" ? "⬅️ وارد" : "➡️ صادر";
      const txt = (m.direction === "in" ? (m.body||"") : (m.body||""));
      const num = String(m.number||"");
      const act = openHum.has(num)
        ? `<button class="btn-sm" onclick="closeWaHuman('${num}')">✅ إنهاء التوجيه</button>`
        : "—";
      return `<tr><td>${fmtWaDate(m.date)}</td><td>${dir}</td><td style="direction:ltr;">${num}</td><td style="white-space:pre-line; max-width:420px;">${(txt||"").replace(/</g,"&lt;")}</td><td>${act}</td></tr>`;
    }).join("") || `<tr><td colspan="5">لا توجد رسائل بعد</td></tr>`;
  }catch(err){ body.innerHTML = `<tr><td colspan="5">${err.message}</td></tr>`; }
}
async function closeWaHuman(num){
  try{ const r = await adminFetch("/admin/whatsapp/humans/close", { method:"POST", body:{ number:num } }); toast(r.message); loadWhatsAppMessages(); }
  catch(err){ toast(err.message, "error"); }
}
async function clearWhatsAppMessages(){
  if(!confirm("مسح سجل محادثات واتساب؟")) return;
  try{ const r = await adminFetch("/admin/whatsapp/messages", { method:"DELETE" }); toast(r.message); loadWhatsAppMessages(); }
  catch(err){ toast(err.message, "error"); }
}
/* ===== ذاكرة الوكيل 🧠 ===== */
let ALL_AI_MEM = [];
async function loadAiMemory(){
  for(let attempt = 0; attempt < 2; attempt++){
    try{
      const d = await adminFetch("/admin/ai-memory?limit=150");
      ALL_AI_MEM = d.items || [];
      document.getElementById("aiMemCount").textContent = `🧠 ${d.total || 0} محادثة محفوظة` + (d.warning ? " — ⚠️ " + d.warning : "");
      break;
    }catch(err){
      if(attempt === 0){ await new Promise(r=>setTimeout(r, 1200)); continue; }
      ALL_AI_MEM = [];
      toast(err.message, "error");
    }
  }
  renderAiMemory();
}
function renderAiMemory(){
  const q = (document.getElementById("aiMemSearchInput")?.value || "").trim().toLowerCase();
  const rows = ALL_AI_MEM.filter(m => !q || `${m.question||''} ${m.reply||''}`.toLowerCase().includes(q));
  document.getElementById("aiMemTableBody").innerHTML = rows.map(m=>`
    <tr><td style="font-size:10px; white-space:nowrap;">${m.date||''}</td>
    <td style="font-size:11px;">${m.question||''}</td>
    <td style="font-size:10.5px; color:var(--muted); max-width:280px;">${(m.reply||'').slice(0,160)}${(m.reply||'').length > 160 ? '…' : ''}</td>
    <td><button class="btn-sm danger" onclick="deleteAiMemory(${m.id})"><i class="fa-solid fa-xmark"></i></button></td></tr>`).join("")
    || `<tr><td colspan="4" class="text-muted" style="text-align:center; padding:16px;">لا توجد محادثات بعد</td></tr>`;
}
async function deleteAiMemory(id){
  try{ await adminFetch("/admin/ai-memory", { method:"DELETE", body: JSON.stringify({ id }) }); loadAiMemory(); }
  catch(err){ toast(err.message, "error"); }
}
async function clearAiMemory(){
  if(!confirm("مسح كل ذاكرة الوكيل؟")) return;
  try{ await adminFetch("/admin/ai-memory", { method:"DELETE", body: JSON.stringify({}) }); toast("تم المسح ✅"); loadAiMemory(); }
  catch(err){ toast(err.message, "error"); }
}

/* ===== البحث الشامل (طلب / مستخدم / إيداع) ===== */
let _globalSearchTimer = null;
async function adminGlobalSearch(q){
  q = (q || "").trim();
  const panel = document.getElementById("adminSearchPanel");
  clearTimeout(_globalSearchTimer);
  if(q.length < 2){ if(panel) panel.style.display = "none"; return; }
  _globalSearchTimer = setTimeout(async ()=>{
    try{
      const r = await adminFetch("/admin/search?q=" + encodeURIComponent(q));
      const n = (r.orders||[]).length + (r.users||[]).length + (r.deposits||[]).length;
      let html = "";
      if(!n) html = `<div class="text-muted" style="text-align:center; padding:14px; font-size:11px;">لا نتائج لـ "${q}"</div>`;
      if((r.orders||[]).length){
        html += `<div style="font-size:10px; color:var(--muted); margin:4px 2px;">🛒 الطلبات</div>` + r.orders.map(o=>
          `<div onclick="jumpToOrder('${o.track||''}')" style="padding:8px; border-radius:8px; cursor:pointer; font-size:11px;" onmouseover="this.style.background='var(--card-soft)'" onmouseout="this.style.background=''">
            <b>#${o.id}</b> ${o.product||''} <span style="color:var(--muted)">• ${o.player||''}</span><br>
            <small style="font-family:'Orbitron',monospace; color:var(--accent);">🔖 ${o.track||''}</small></div>`).join("");
      }
      if((r.users||[]).length){
        html += `<div style="font-size:10px; color:var(--muted); margin:6px 2px 4px;">👤 المستخدمون</div>` + r.users.map(u=>
          `<div onclick="jumpToUser(${u.web_id})" style="padding:8px; border-radius:8px; cursor:pointer; font-size:11px;" onmouseover="this.style.background='var(--card-soft)'" onmouseout="this.style.background=''">
            <b>${u.name||'—'}</b><br><small style="color:var(--muted);">${u.email||''}</small></div>`).join("");
      }
      if((r.deposits||[]).length){
        html += `<div style="font-size:10px; color:var(--muted); margin:6px 2px 4px;">💳 الإيداعات</div>` + r.deposits.map(d=>
          `<div onclick="jumpToDeposit(${d.id})" style="padding:8px; border-radius:8px; cursor:pointer; font-size:11px;" onmouseover="this.style.background='var(--card-soft)'" onmouseout="this.style.background=''">
            <b>#${d.id}</b> ${d.method||''} — ${Math.round(d.amount_syp||0).toLocaleString()} ل.س<br>
            <small style="font-family:'Orbitron',monospace; color:var(--muted);">${d.code||''}</small></div>`).join("");
      }
      panel.innerHTML = html;
      panel.style.display = "block";
    }catch(err){ /* تجاهل بهدوء */ }
  }, 350);
}
document.addEventListener("click", (e)=>{
  const panel = document.getElementById("adminSearchPanel");
  if(panel && !e.target.closest("#adminGlobalSearch") && !e.target.closest("#adminSearchPanel")) panel.style.display = "none";
});
function _hideSearchPanel(){ const p = document.getElementById("adminSearchPanel"); if(p) p.style.display = "none"; }
function jumpToOrder(track){
  _hideSearchPanel();
  goSection("orders", document.querySelector('[data-section=orders]'));
  setTimeout(()=>{
    const inp = document.getElementById("ordersSearchInput");
    if(inp){ inp.value = track || ""; renderOrdersTable(); }
  }, 350);
}
function jumpToUser(webId){
  _hideSearchPanel();
  goSection("users", document.querySelector('[data-section=users]'));
  setTimeout(async ()=>{
    try{ await openUserDetails(webId); }catch(e){}
  }, 500);
}
function jumpToDeposit(id){
  _hideSearchPanel();
  goSection("deposits", document.querySelector('[data-section=deposits]'));
  setTimeout(()=>{
    const inp = document.getElementById("depositsSearchInput");
    if(inp){ inp.value = "#" + id; renderDepositsTable(); }
  }, 350);
}

/* ===== سجل الأدمن ===== */
let ALL_LOGS_ROWS = [];
async function loadAdminLogs(){
  try{
    ALL_LOGS_ROWS = await adminFetch("/admin/logs?limit=300");
  }catch(err){ ALL_LOGS_ROWS = []; toast(err.message, "error"); }
  renderAdminLogs();
}
function renderAdminLogs(){
  const q = (document.getElementById("logsSearchInput")?.value || "").trim().toLowerCase();
  const rows = ALL_LOGS_ROWS.filter(l => {
    if(!q) return true;
    return `${l.actor||''} ${l.action||''} ${l.target||''} ${l.detail||''}`.toLowerCase().includes(q);
  });
  document.getElementById("logsTableBody").innerHTML = rows.map(l=>`
    <tr><td style="font-size:10px; white-space:nowrap;">${l.date||''}</td><td>${l.actor||''}</td>
    <td><b>${l.action||''}</b></td>
    <td style="font-family:'Orbitron',monospace; font-size:10px; direction:ltr;">${l.target||''}</td>
    <td style="font-size:10.5px; color:var(--muted);">${l.detail||''}</td></tr>`).join("")
    || `<tr><td colspan="5" class="text-muted" style="text-align:center; padding:16px;">لا توجد سجلات بعد — ستظهر هنا إجراءات الأدمن القادمة</td></tr>`;
}

/* ===== 4) المستخدمون ===== */
let ALL_DISCOUNT_TIERS = [];

let ALL_USERS_ROWS = [];
let topBalancesChartInstance = null;
let tierDistributionChartInstance = null;

async function loadUsers(){
  // allSettled: فشل الإحصائيات أو الرتب لا يوقف جدول المستخدمين والبحث
  const [uRes, tRes, sRes] = await Promise.allSettled([
    adminFetch("/admin/users"), adminFetch("/admin/discount-tiers"), adminFetch("/admin/stats")
  ]);
  const users = uRes.status === "fulfilled" ? uRes.value : [];
  const tiers = tRes.status === "fulfilled" ? tRes.value : [];
  const stats = sRes.status === "fulfilled" ? sRes.value : { exchange_rate: 13800, total_orders: 0 };
  ALL_DISCOUNT_TIERS = tiers;
  ALL_USERS_ROWS = users;

  // ===== بطاقات الإحصائيات =====
  const rate = stats.exchange_rate || 1;
  const totalBalanceUsd = users.reduce((s,u)=> s + ((u.balance_syp||0)/rate), 0);
  const avgBalanceUsd = users.length ? totalBalanceUsd / users.length : 0;
  document.getElementById("usersKpiAvgBalance").textContent = "$" + avgBalanceUsd.toFixed(2);
  document.getElementById("usersKpiOrders").textContent = stats.total_orders.toLocaleString();
  document.getElementById("usersKpiTotalBalance").textContent = "$" + totalBalanceUsd.toFixed(2);
  document.getElementById("usersKpiTotal").textContent = users.length.toLocaleString();

  // ===== فلتر المستويات =====
  const tierSelect = document.getElementById("usersFilterTier");
  tierSelect.innerHTML = `<option value="">كل المستويات</option>` +
    tiers.map(t => `<option value="${t.id}">${t.name}</option>`).join("");

  // ===== رسم: أعلى 5 مستخدمين رصيداً =====
  const top5 = [...users].sort((a,b)=> (b.balance_syp||0) - (a.balance_syp||0)).slice(0,5);
  renderChart("topBalancesChart", "topBalances", top5.map(u=>u.name||"—"), top5.map(u=> Number((((u.balance_syp||0)/rate)).toFixed(2))), "#e0a83a");

  // ===== رسم: توزيع المستويات =====
  const tierCounts = tiers.map(t => users.filter(u=>u.discount_tier_id===t.id).length);
  const noTierCount = users.filter(u=>!u.discount_tier_id).length;
  renderChart("tierDistributionChart", "tierDist",
    [...tiers.map(t=>t.name), "بدون رتبة"], [...tierCounts, noTierCount], "#e63946");

  renderUsersTable();
}

function renderChart(canvasId, kind, labels, data, color){
  if(typeof Chart === "undefined") return; // لو تعذّر تحميل مكتبة الرسوم من CDN (بدون إنترنت مثلاً)
  const ctx = document.getElementById(canvasId);
  if(!ctx) return;
  const existing = kind === "topBalances" ? topBalancesChartInstance : tierDistributionChartInstance;
  if(existing) existing.destroy();
  const instance = new Chart(ctx, {
    type: "bar",
    data: { labels, datasets: [{ data, backgroundColor: color, borderRadius: 6 }] },
    options: {
      maintainAspectRatio: true,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: "#9aa3b2", font: { size: 10 } }, grid: { display:false } },
        y: { ticks: { color: "#9aa3b2", font: { size: 10 } }, grid: { color: "rgba(255,255,255,.05)" } },
      },
    },
  });
  if(kind === "topBalances") topBalancesChartInstance = instance;
  else tierDistributionChartInstance = instance;
}

function renderUsersTable(){
  const apiFilter = document.getElementById("usersFilterApi").value;
  const tierFilter = document.getElementById("usersFilterTier").value;
  const search = document.getElementById("usersSearchInput").value.trim().toLowerCase();

  const tierOptions = (selectedId) => `
    <option value="0" ${!selectedId ? 'selected' : ''}>بدون رتبة</option>
    ${ALL_DISCOUNT_TIERS.map(t => `<option value="${t.id}" ${t.id === selectedId ? 'selected' : ''}>${t.name} (${t.percent}%)</option>`).join("")}`;

  const filtered = ALL_USERS_ROWS.filter(u => {
    if(apiFilter === "enabled" && !u.api_enabled) return false;
    if(apiFilter === "disabled" && u.api_enabled) return false;
    if(tierFilter && String(u.discount_tier_id) !== tierFilter) return false;
    if(search){
      const hay = `${u.name||''} ${u.email||''} ${u.phone||''} ${u.site_user_id||''}`.toLowerCase();
      if(!hay.includes(search)) return false;
    }
    return true;
  });

  document.getElementById("usersTableBody").innerHTML = filtered.map(u=>`
    <tr>
    <td style="cursor:pointer;" onclick="openUserDetails(${u.web_id})"><i class="fa-solid fa-circle-info" style="color:var(--accent); margin-left:4px;"></i>${u.name||'—'}</td>
    <td>${u.email||'—'}</td><td>${Math.round(u.balance_syp||0).toLocaleString()} ل.س</td>
    <td><select onchange="setUserDiscountTier(${u.web_id}, this.value)" style="padding:6px 8px; border-radius:8px; border:1px solid var(--border); background:var(--card-soft); color:var(--text); font-size:11px;">${tierOptions(u.discount_tier_id)}</select></td>
    <td>${u.blocked ? '<span class="status-badge failed">محظور</span>' : '<span class="status-badge completed">نشط</span>'}</td>
    <td>${u.api_enabled
        ? `<span class="status-badge completed" title="${u.api_key}" style="cursor:pointer;" onclick="navigator.clipboard?.writeText('${u.api_key}'); toast('تم نسخ المفتاح')">مفعّل <i class="fa-solid fa-copy"></i></span>`
        : '<span class="status-badge pending">غير مفعّل</span>'}</td>
    <td style="display:flex; gap:6px; flex-wrap:wrap;">
      <button class="btn-sm" style="background:var(--gold); color:#000;" onclick="openBalanceAdjust(${u.web_id}, '${(u.name||'').replace(/'/g,"")}')"><i class="fa-solid fa-coins"></i> الرصيد</button>
      <button class="btn-sm ${u.blocked?'primary':'danger'}" onclick="${u.blocked?'unblockUser':'blockUser'}(${u.web_id})">${u.blocked?'رفع الحظر':'حظر'}</button>
      ${u.api_enabled
        ? `<button class="btn-sm danger" onclick="disableUserApi(${u.web_id})">تعطيل API</button>
           <button class="btn-sm primary" onclick="regenerateUserApi(${u.web_id})">تجديد المفتاح</button>`
        : `<button class="btn-sm primary" onclick="enableUserApi(${u.web_id})">فتح API</button>`}
    </td></tr>`).join("")
    || `<tr><td colspan="7" class="text-muted" style="text-align:center; padding:16px;">لا يوجد مستخدمون مطابقون</td></tr>`;
}

function exportUsersCsv(){
  const rows = [["الاسم","البريد","الرصيد (ل.س)","الرتبة","الحالة","API"]];
  ALL_USERS_ROWS.forEach(u => rows.push([
    u.name, u.email, Math.round(u.balance_syp), u.discount_tier_name || "بدون رتبة",
    u.blocked ? "محظور" : "نشط", u.api_enabled ? "مفعّل" : "غير مفعّل"
  ]));
  downloadCsv(rows, "users-export.csv");
}

function downloadCsv(rows, filename){
  const csv = rows.map(r => r.map(cell => `"${String(cell).replace(/"/g,'""')}"`).join(",")).join("\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

/* ===== مودال تفاصيل المستخدم المتقدمة ===== */
let CURRENT_USER_DETAILS = null;
async function openUserDetails(webId){
  try{
    const d = await adminFetch(`/admin/users/${webId}/details`);
    CURRENT_USER_DETAILS = d;
    document.getElementById("userDetailsName").innerHTML = `<i class="fa-solid fa-user"></i> ${d.name} — ${d.email}`;
    document.getElementById("udRProfit").textContent = "$" + d.total_profit_usd.toFixed(4);
    document.getElementById("udOrders").textContent = d.total_orders.toLocaleString();
    document.getElementById("udSpent").textContent = "$" + d.total_spent_usd.toFixed(2);
    document.getElementById("udBalance").textContent = "$" + d.balance_usd.toFixed(2);
    document.getElementById("userDetailsOrdersBody").innerHTML = d.recent_orders.map(o=>`
      <tr><td>#${o.id}</td><td>${o.product_name||'-'}</td><td>${o.qty}</td><td>$${Number(o.price_usd).toFixed(4)}</td>
      <td><span class="status-badge ${o.status}">${STATUS_LABEL[o.status]||o.status}</span></td><td>${o.date}</td></tr>`).join("")
      || `<tr><td colspan="6" class="text-muted" style="text-align:center; padding:16px;">لا توجد طلبات</td></tr>`;
    document.getElementById("userDetailsModal").style.display = "flex";
  }catch(err){ toast(err.message, "error"); }
}
function closeUserDetailsModal(){ document.getElementById("userDetailsModal").style.display = "none"; }
function exportUserOrdersCsv(){
  if(!CURRENT_USER_DETAILS) return;
  const rows = [["ID","المنتج","الكمية","السعر (USD)","الحالة","التاريخ"]];
  CURRENT_USER_DETAILS.recent_orders.forEach(o => rows.push([o.id, o.product_name||"-", o.qty, o.price_usd, o.status, o.date]));
  downloadCsv(rows, `user-${CURRENT_USER_DETAILS.email}-orders.csv`);
}

let balanceModalWebId = null;
function openBalanceAdjust(webId, userName){
  balanceModalWebId = webId;
  document.getElementById("balanceModalUser").textContent = userName;
  document.getElementById("balanceModalAmount").value = "";
  document.getElementById("balanceModal").style.display = "flex";
}
function closeBalanceModal(){
  document.getElementById("balanceModal").style.display = "none";
  balanceModalWebId = null;
}
async function submitBalanceAdjust(action){
  const amount = Number(document.getElementById("balanceModalAmount").value || 0);
  if(!amount || amount <= 0){ toast("أدخل مبلغ صحيح أكبر من صفر", "error"); return; }
  try{
    await adminFetch(`/admin/users/${balanceModalWebId}/balance`, { method:"POST", body: JSON.stringify({ action, amount }) });
    toast(action === "add" ? "✅ تمت إضافة الرصيد" : "✅ تم خصم الرصيد");
    closeBalanceModal();
    loadUsers();
  }catch(err){ toast(err.message, "error"); }
}
async function setUserDiscountTier(webId, tierId){
  try{
    await adminFetch(`/admin/users/${webId}/discount-tier`, { method:"POST", body: JSON.stringify({ tier_id: Number(tierId) }) });
    toast(Number(tierId) === 0 ? "تمت إزالة رتبة المستخدم" : "تم تعيين الرتبة ✅");
  }catch(err){ toast(err.message, "error"); loadUsers(); }
}

/* ===== الرتب والخصومات ===== */
async function loadDiscountTiers(){
  const tiers = await adminFetch("/admin/discount-tiers");
  ALL_DISCOUNT_TIERS = tiers;
  try{
    const cfg = await adminFetch("/admin/settings");
    const cb = document.getElementById("autoTierEnabled");
    if(cb) cb.checked = (cfg.auto_tier_enabled === "true");
  }catch(e){}
  document.getElementById("tiersTableBody").innerHTML = tiers.map(t => `
    <tr>
      <td><input type="text" value="${t.name}" onchange="updateDiscountTier(${t.id}, {name:this.value})" style="padding:6px 8px; border-radius:8px; border:1px solid var(--border); background:var(--card-soft); color:var(--text); font-size:11px; width:100px;"></td>
      <td><input type="number" value="${t.percent}" min="0" max="100" step="0.5" onchange="updateDiscountTier(${t.id}, {percent:Number(this.value)})" style="padding:6px 8px; border-radius:8px; border:1px solid var(--border); background:var(--card-soft); color:var(--text); font-size:11px; width:70px;"> %</td>
      <td><input type="number" value="${t.min_spent || 0}" min="0" step="1" onchange="updateDiscountTier(${t.id}, {min_spent:Number(this.value)})" title="حد الإنفاق بالدولار للترقية التلقائية" style="padding:6px 8px; border-radius:8px; border:1px solid var(--border); background:var(--card-soft); color:var(--text); font-size:11px; width:80px;"> $</td>
      <td><input type="number" value="${t.sort_order}" onchange="updateDiscountTier(${t.id}, {sort_order:Number(this.value)})" style="padding:6px 8px; border-radius:8px; border:1px solid var(--border); background:var(--card-soft); color:var(--text); font-size:11px; width:60px;"></td>
      <td><button class="btn-sm danger" onclick="deleteDiscountTier(${t.id})">حذف</button></td>
    </tr>`).join("")
    || `<tr><td colspan="5" class="text-muted" style="text-align:center; padding:16px;">لا توجد رتب بعد، أضف أول رتبة فوق</td></tr>`;
}
async function saveAutoTier(on){
  try{
    await adminFetch("/admin/settings", { method:"POST", body: JSON.stringify({ auto_tier_enabled: on ? "true" : "false" }) });
    toast(on ? "تم تفعيل الترقية التلقائية ⚡" : "تم إيقاف الترقية التلقائية");
  }catch(err){ toast(err.message, "error"); loadDiscountTiers(); }
}
async function addDiscountTier(){
  const name = document.getElementById("newTierName").value.trim();
  const percent = Number(document.getElementById("newTierPercent").value || 0);
  const min_spent = Number(document.getElementById("newTierMinSpent")?.value || 0);
  const sort_order = Number(document.getElementById("newTierSort").value || 0);
  if(!name){ toast("أدخل اسم الرتبة", "error"); return; }
  if(percent < 0 || percent > 100){ toast("نسبة الخصم يجب أن تكون بين 0 و100", "error"); return; }
  try{
    await adminFetch("/admin/discount-tiers", { method:"POST", body: JSON.stringify({ name, percent, min_spent, sort_order }) });
    toast("تمت إضافة الرتبة ✅");
    document.getElementById("newTierName").value = "";
    document.getElementById("newTierPercent").value = "";
    if(document.getElementById("newTierMinSpent")) document.getElementById("newTierMinSpent").value = "";
    document.getElementById("newTierSort").value = "0";
    loadDiscountTiers();
  }catch(err){ toast(err.message, "error"); }
}
async function updateDiscountTier(tierId, changes){
  try{
    await adminFetch(`/admin/discount-tiers/${tierId}`, { method:"PUT", body: JSON.stringify(changes) });
    toast("تم الحفظ ✅");
  }catch(err){ toast(err.message, "error"); loadDiscountTiers(); }
}
async function deleteDiscountTier(tierId){
  if(!confirm("حذف هذه الرتبة؟ كل المستخدمين المعيّنين لها سيرجعون لحالة بدون رتبة (0% خصم).")) return;
  try{ await adminFetch(`/admin/discount-tiers/${tierId}`, { method:"DELETE" }); toast("تم الحذف"); loadDiscountTiers(); loadTierMatrix(); }
  catch(err){ toast(err.message, "error"); }
}
/* ===== مصفوفة خصم كل رتبة على كل قسم ===== */
async function loadTierMatrix(){
  const head = document.getElementById("tierMatrixHead");
  const body = document.getElementById("tierMatrixBody");
  if(!head || !body) return;
  try{
    const d = await adminFetch("/admin/tier-section-discounts");
    const tiers = d.tiers || [], sections = d.sections || [], matrix = d.matrix || {};
    if(!tiers.length || !sections.length){
      head.innerHTML = "<th>القسم</th>";
      body.innerHTML = `<tr><td class="text-muted" style="text-align:center; padding:14px;">أضف رتبة وأقساماً أولاً لتظهر المصفوفة هنا</td></tr>`;
      return;
    }
    head.innerHTML = "<th>القسم \\ الرتبة</th>" + tiers.map(t=>`<th>${t.name}<br><small style="color:var(--muted);">عام ${t.percent}%</small></th>`).join("");
    body.innerHTML = sections.map(sec=>{
      const cells = tiers.map(t=>{
        const v = (matrix[t.id] && matrix[t.id][sec] !== undefined) ? matrix[t.id][sec] : "";
        return `<td><input type="number" min="0" max="100" step="0.5" placeholder="${t.percent}" value="${v}"
          onchange="saveTierSection(${t.id}, '${sec.replace(/'/g,"")}', this.value)"
          style="padding:6px 8px; border-radius:8px; border:1px solid var(--border); background:var(--card-soft); color:var(--text); font-size:11px; width:70px;" title="فارغ = الخصم العام (${t.percent}%)"> <small>%</small></td>`;
      }).join("");
      return `<tr><td><b>${sec}</b></td>${cells}</tr>`;
    }).join("");
  }catch(err){
    body.innerHTML = `<tr><td class="text-muted" style="text-align:center; padding:14px;">${err.message}</td></tr>`;
  }
}
async function saveTierSection(tierId, section, value){
  try{
    const r = await adminFetch("/admin/tier-section-discounts", { method:"POST", body: JSON.stringify({ tier_id: tierId, section, percent: (value === "" ? null : Number(value)) }) });
    toast(r.message);
  }catch(err){ toast(err.message, "error"); loadTierMatrix(); }
}
async function blockUser(webId){
  try{ await adminFetch(`/admin/users/${webId}/block`, { method:"POST" }); toast("تم حظر المستخدم"); loadUsers(); }
  catch(err){ toast(err.message, "error"); }
}
async function unblockUser(webId){
  try{ await adminFetch(`/admin/users/${webId}/unblock`, { method:"POST" }); toast("تم رفع الحظر"); loadUsers(); }
  catch(err){ toast(err.message, "error"); }
}
async function enableUserApi(webId){
  if(!confirm("هل تريد تفعيل API لهذا المستخدم؟ سيتمكن من إنشاء طلبات خارجية عبر مفتاحه.")) return;
  try{ await adminFetch(`/admin/users/${webId}/api/enable`, { method:"POST" }); toast("تم تفعيل API ✅"); loadUsers(); }
  catch(err){ toast(err.message, "error"); }
}
async function disableUserApi(webId){
  if(!confirm("هل تريد تعطيل API لهذا المستخدم؟ مفتاحه سيتوقف عن العمل فوراً.")) return;
  try{ await adminFetch(`/admin/users/${webId}/api/disable`, { method:"POST" }); toast("تم تعطيل API"); loadUsers(); }
  catch(err){ toast(err.message, "error"); }
}
async function regenerateUserApi(webId){
  if(!confirm("توليد مفتاح جديد سيلغي المفتاح القديم فوراً. متابعة؟")) return;
  try{ await adminFetch(`/admin/users/${webId}/api/regenerate`, { method:"POST" }); toast("تم توليد مفتاح جديد ✅"); loadUsers(); }
  catch(err){ toast(err.message, "error"); }
}

/* ===== 5) المنتجات والفئات ===== */
let currentProductId = null;
let sectionsCache = [];
let productsCache = [];
async function loadProducts(){
  sectionsCache = await adminFetch("/admin/sections");
  const sel = document.getElementById("newProductSection");
  sel.innerHTML = sectionsCache.map(s=>`<option value="${s.name}" data-id="${s.id}">${s.name}</option>`).join("") || `<option value="">لا يوجد أقسام بعد</option>`;
  await onProductSectionChange();

  productsCache = await adminFetch("/admin/products");
  renderProductsTable(productsCache);
  loadNewParentOptions();
}
function renderProductsTable(products){
  // عرض مجمّع حسب القسم ثم الفرع ثم الترتيب الفعلي — لتكون أسهم التطليع/التنزيل مرئية المعنى
  const rows = [...products].sort((a, b)=>{
    if((a.category||"") !== (b.category||"")) return (a.category||"").localeCompare(b.category||"");
    if((a.subsection_name||"") !== (b.subsection_name||"")) return (a.subsection_name||"").localeCompare(b.subsection_name||"");
    return (a.sort_order||0) - (b.sort_order||0) || a.id - b.id;
  });
  document.getElementById("productsTableBody").innerHTML = rows.map((p, idx)=>`
    <tr>
      <td style="white-space:nowrap;">
        <button class="btn-sm" ${idx===0?'disabled':''} onclick="moveProduct(${p.id}, -1)" title="تطليع المنتج"><i class="fa-solid fa-arrow-up"></i></button>
        <button class="btn-sm" ${idx===rows.length-1?'disabled':''} onclick="moveProduct(${p.id}, 1)" title="تنزيل المنتج"><i class="fa-solid fa-arrow-down"></i></button>
      </td>
      <td>${p.image ? `<img src="${p.image}" style="width:30px; height:30px; border-radius:8px; object-fit:cover; vertical-align:middle; margin-left:6px;">` : ''}${p.name}${p.notes ? ` <span title="${escapeHtml(p.notes)}" style="cursor:help; font-size:12px;">📝</span>` : ''}${p.offer ? ` <span class="status-badge completed">🏷️ ${escapeHtml(p.offer)}</span>` : ''}${p.active===false||p.active===0 ? ` <span class="status-badge failed">غير متوفر</span>` : ''}${p.parent_id ? `<br><small style="color:var(--gold);">🔹 فرعي من: ${escapeHtml(p.parent_name||'')}</small>` : ''}${p.children_count ? ` <small style="color:var(--muted);">(أب لـ ${p.children_count})</small>` : ''}</td>
      <td>${p.category}</td>
      <td>${p.subsection_name || '<span class="text-muted">—</span>'}</td>
      <td>${p.categories_count}</td>
      <td>
        <button class="btn-sm" onclick="pickImage('product', ${p.id})"><i class="fa-solid fa-camera"></i></button>
        <button class="btn-sm" onclick="openAiImage('product', ${p.id}, '${p.name.replace(/'/g,"")}')" title="إنشاء صورة بالذكاء الاصطناعي"><i class="fa-solid fa-wand-magic-sparkles"></i></button>
        <button class="btn-sm" onclick="openProductEdit(${p.id})"><i class="fa-solid fa-pen"></i></button>
        <button class="btn-sm" onclick="openProductMove(${p.id})" title="نقل المنتج لأي قسم/فرع"><i class="fa-solid fa-truck-fast"></i> نقل</button>
        <button class="btn-sm" onclick="openCategories(${p.id}, '${p.name.replace(/'/g,"")}')">الفئات</button>
        <button class="btn-sm danger" onclick="deleteProduct(${p.id})">حذف</button>
      </td>
    </tr>`).join("")
    || `<tr><td colspan="6" class="text-muted" style="text-align:center; padding:16px;">${productsCache.length ? 'لا توجد نتائج مطابقة' : 'لا توجد منتجات بعد'}</td></tr>`;
}
async function moveProduct(id, dir){
  try{
    const res = await adminFetch(`/admin/products/${id}/move`, { method:"POST", body: JSON.stringify({ direction: dir }) });
    toast(res.message || "تم النقل ✅");
    loadProducts();
  }catch(err){ toast(err.message, "error"); }
}
/* نافذة نقل منتج لأي مكان مع محتواه (فئاته تتبعه تلقائياً — مربوطة بمعرفه) */
async function openProductMove(id){
  const p = productsCache.find(x=>x.id===id);
  if(!p){ toast("المنتج غير موجود", "error"); return; }
  editTarget = { kind:"product_move", id };
  document.getElementById("editModalTitle").textContent = "نقل المنتج: " + p.name;
  const body = document.getElementById("editModalBody");
  const fld = "padding:11px;border-radius:11px;border:1px solid var(--border);background:var(--card-soft);color:var(--text);";
  let secs = (typeof sectionsCache !== "undefined" && sectionsCache.length) ? sectionsCache : [];
  if(!secs.length){
    try{ secs = await adminFetch("/admin/sections"); }catch(err){ secs = []; }
  }
  const secOpts = secs.map(s=>`<option value="${escapeHtml(s.name)}" ${s.name===p.category?"selected":""}>${escapeHtml(s.name)}</option>`).join("")
    || `<option value="">لا توجد أقسام</option>`;
  body.innerHTML = `
    <div class="field"><label>القسم الهدف (ينتقل المنتج لنهايته)</label><select id="mv_category" onchange="loadProductMoveSubs()" style="${fld}">${secOpts}</select></div>
    <div class="field"><label>القسم الفرعي الهدف</label><select id="mv_subsection_id" style="${fld}"><option value="">— بدون قسم فرعي —</option></select></div>
    <div class="info-banner" style="font-size:11px;"><i class="fa-solid fa-circle-info"></i><div>فئات المنتج وأسعاره ومخزونه تنتقل معه تلقائياً بدون أي فقدان.</div></div>`;
  document.getElementById("editModal").style.display = "flex";
  window._moveSections = secs;
  await loadProductMoveSubs(p.subsection_id);
}
async function loadProductMoveSubs(selected){
  const catEl = document.getElementById("mv_category");
  const sel = document.getElementById("mv_subsection_id");
  if(!catEl || !sel) return;
  const secs = window._moveSections || (typeof sectionsCache !== "undefined" ? sectionsCache : []);
  const sec = secs.find(s=>s.name===catEl.value);
  sel.innerHTML = `<option value="">— بدون قسم فرعي —</option>`;
  if(!sec) return;
  try{
    const subs = await adminFetch(`/admin/sections/${sec.id}/subsections`);
    sel.innerHTML = `<option value="">— بدون قسم فرعي —</option>` + subs.map(s=>`<option value="${s.id}" ${s.id===(selected??null)?"selected":""}>${escapeHtml(s.name)}</option>`).join("");
  }catch(err){ /* يبقى خيار "بدون" فقط */ }
}
function searchProducts(q){
  q = (q || "").trim().toLowerCase();
  if(!q){ renderProductsTable(productsCache); return; }
  renderProductsTable(productsCache.filter(p =>
    p.name.toLowerCase().includes(q) ||
    (p.category || "").toLowerCase().includes(q) ||
    (p.subsection_name || "").toLowerCase().includes(q)
  ));
}
async function onProductSectionChange(){
  const sel = document.getElementById("newProductSection");
  const opt = sel.options[sel.selectedIndex];
  const sectionId = opt ? opt.dataset.id : null;
  const wrap = document.getElementById("newProductSubsectionWrap");
  const subSel = document.getElementById("newProductSubsection");
  loadNewParentOptions();
  if(!sectionId){ wrap.style.display = "none"; return; }
  try{
    const subs = await adminFetch(`/admin/sections/${sectionId}/subsections`);
    if(subs.length){
      subSel.innerHTML = `<option value="">— بدون قسم فرعي —</option>` + subs.map(s=>`<option value="${s.id}">${s.name}</option>`).join("");
      wrap.style.display = "block";
    }else{
      wrap.style.display = "none";
    }
  }catch(err){ wrap.style.display = "none"; }
}
/* منتج الأب في نموذج الإضافة: يعرض المنتجات الرئيسية (بدون أب) لنفس القسم */
function loadNewParentOptions(){
  const wrap = document.getElementById("newProductParentWrap");
  const sel = document.getElementById("newProductParent");
  const cat = document.getElementById("newProductSection")?.value || "";
  if(!wrap || !sel) return;
  const tops = (typeof productsCache !== "undefined" ? productsCache : [])
    .filter(p => (p.category || "") === cat && !p.parent_id);
  if(!tops.length){ wrap.style.display = "none"; sel.innerHTML = ""; return; }
  sel.innerHTML = `<option value="">— بدون أب (منتج رئيسي) —</option>` +
    tops.map(p=>`<option value="${p.id}">${escapeHtml(p.name)}</option>`).join("");
  wrap.style.display = "block";
}
async function addProduct(){
  const name = document.getElementById("newProductName").value.trim();
  const category = document.getElementById("newProductSection").value;
  const emoji = document.getElementById("newProductEmoji").value.trim();
  const subsection_id = document.getElementById("newProductSubsection").value || null;
  const parentVal = document.getElementById("newProductParent")?.value || "";
  const parent_id = parentVal === "" ? null : Number(parentVal);
  const notes = (document.getElementById("newProductNotes")?.value || "").trim();
  const offer = (document.getElementById("newProductOffer")?.value || "").trim();
  const active = document.getElementById("newProductActive")?.value || "1";
  if(!name || !category){ toast("أدخل اسم المنتج واختر القسم", "error"); return; }
  try{
    await adminFetch("/admin/products", { method:"POST", body: JSON.stringify({ name, category, emoji, subsection_id: parent_id ? null : subsection_id, parent_id, notes, offer, active }) });
    toast("تمت إضافة المنتج ✅");
    document.getElementById("newProductName").value = "";
    document.getElementById("newProductEmoji").value = "";
    if(document.getElementById("newProductOffer")) document.getElementById("newProductOffer").value = "";
    if(document.getElementById("newProductNotes")) document.getElementById("newProductNotes").value = "";
    loadProducts();
  }catch(err){ toast(err.message, "error"); }
}
async function deleteProduct(id){
  try{ await adminFetch(`/admin/products/${id}`, { method:"DELETE" }); toast("تم الحذف"); loadProducts(); }
  catch(err){ toast(err.message, "error"); }
}
async function openCategories(productId, productName){
  currentProductId = productId;
  document.getElementById("categoriesPanel").style.display = "block";
  document.getElementById("categoriesPanelTitle").textContent = "فئات: " + productName;
  document.getElementById("categoriesPanel").scrollIntoView({ behavior:"smooth", block:"center" });
  await Promise.all([loadCategories(), ensureProvidersCache()]);
}
/* قائمة المزوّدين لنموذج الربط السريع عند إضافة فئة */
let _providersCache = null;
async function ensureProvidersCache(){
  const sel = document.getElementById("newCategoryProvider");
  if(_providersCache && sel && sel.options.length > 1) return;
  try{
    _providersCache = await adminFetch("/admin/providers");
  }catch(err){ return; }
  if(sel){
    const cur = sel.value;
    sel.innerHTML = `<option value="">🔗 الربط: يدوي (بموافقة الأدمن)</option>` +
      _providersCache.map(p=>`<option value="${p.id}">${p.name}${p.has_token ? "" : " ⚠️"}</option>`).join("");
    if(cur) sel.value = cur;
  }
}
async function loadCategories(){
  const cats = await adminFetch(`/admin/products/${currentProductId}/categories`);
  document.getElementById("categoriesTableBody").innerHTML = cats.map(c=>`
    <tr>
      <td>${c.image ? `<img src="${c.image}" style="width:26px; height:26px; border-radius:7px; object-fit:cover; vertical-align:middle; margin-left:6px;">` : ''}${c.name}</td>
      <td>$${c.price_usd}</td>
      <td>${c.stock_qty === null || c.stock_qty === undefined ? '<span style="color:var(--muted);">غير محدود</span>' : (c.stock_qty > 0 ? c.stock_qty : '<span style="color:var(--danger);">نفدت</span>')}</td>
      <td>${c.linked ? `<span class="status-badge completed" title="${c.api_product_id||''}">🔗 ${c.provider_name||'مربوطة'}</span>` : '<span class="status-badge pending">🖐️ يدوي</span>'}</td>
      <td>
        <button class="btn-sm" onclick="pickImage('category', ${c.id})"><i class="fa-solid fa-camera"></i></button>
        <button class="btn-sm" onclick="openAiImage('category', ${c.id}, '${c.name.replace(/'/g,"")}')" title="إنشاء صورة بالذكاء الاصطناعي"><i class="fa-solid fa-wand-magic-sparkles"></i></button>
        <button class="btn-sm" onclick="openLinkModal(${c.id}, '${c.name.replace(/'/g,"")}')" title="ربط بمزوّد API"><i class="fa-solid fa-link"></i></button>
        <button class="btn-sm" onclick="openEdit('category', ${c.id}, '${c.name.replace(/'/g,"")}', {name:'${c.name.replace(/'/g,"")}', price:${c.price_usd}, unit_qty:${c.unit_qty||1}, min_qty:${c.min_qty}, max_qty:${c.max_qty}, stock_qty:${c.stock_qty === null || c.stock_qty === undefined ? 'null' : c.stock_qty}, requires_id:${c.requires_id === false ? 0 : 1}})"><i class="fa-solid fa-pen"></i></button>
        <button class="btn-sm danger" onclick="deleteCategory(${c.id})">حذف</button>
      </td>
    </tr>`).join("")
    || `<tr><td colspan="5" class="text-muted" style="text-align:center; padding:12px;">لا توجد فئات بعد</td></tr>`;
}
async function addCategory(){
  const name = document.getElementById("newCategoryName").value.trim();
  const price = Number(document.getElementById("newCategoryPrice").value || 0);
  const type = document.getElementById("newCategoryType").value;
  const unit_qty = Math.max(1, Number(document.getElementById("newCategoryUnitQty").value || 1));
  const min_qty = Math.max(1, Number(document.getElementById("newCategoryMinQty").value || 1));
  const max_qty = Math.max(min_qty, Number(document.getElementById("newCategoryMaxQty").value || min_qty));
  const stockRaw = document.getElementById("newCategoryStock")?.value ?? "";
  const stock_qty = stockRaw.trim() === "" ? null : Number(stockRaw);
  const requires_id = document.getElementById("newCategoryRequiresId") ? document.getElementById("newCategoryRequiresId").checked : true;
  const provider_id = document.getElementById("newCategoryProvider")?.value || "";
  const api_product_id = document.getElementById("newCategoryApiProduct")?.value.trim() || "";
  if(!name || price <= 0){ toast("أدخل اسم الفئة وسعر صحيح", "error"); return; }
  if(provider_id && !api_product_id){ toast("اخترت مزوّداً — أدخل آيدي منتج المزوّد أيضاً", "error"); return; }
  try{
    const r = await adminFetch(`/admin/products/${currentProductId}/categories`, { method:"POST", body: JSON.stringify({ name, price, type, unit_qty, min_qty, max_qty, stock_qty, requires_id, provider_id: provider_id || null, api_product_id }) });
    toast(r.message || "تمت إضافة الفئة ✅");
    document.getElementById("newCategoryName").value = "";
    document.getElementById("newCategoryPrice").value = "";
    if(document.getElementById("newCategoryStock")) document.getElementById("newCategoryStock").value = "";
    if(document.getElementById("newCategoryProvider")) document.getElementById("newCategoryProvider").value = "";
    if(document.getElementById("newCategoryApiProduct")) document.getElementById("newCategoryApiProduct").value = "";
    loadCategories(); loadProducts();
  }catch(err){ toast(err.message, "error"); }
}
async function deleteCategory(id){
  try{ await adminFetch(`/admin/categories/${id}`, { method:"DELETE" }); toast("تم الحذف"); loadCategories(); loadProducts(); }
  catch(err){ toast(err.message, "error"); }
}

/* ===== 6) الأقسام ===== */
let sectionsListCache = [];
async function loadSections(){
  sectionsListCache = await adminFetch("/admin/sections");
  renderSectionsTable();
}
function renderSectionsTable(){
  const sections = sectionsListCache;
  document.getElementById("sectionsTableBody").innerHTML = sections.map((s, idx)=>`
    <tr>
      <td>
        <button class="btn-sm" ${idx===0?'disabled':''} onclick="moveSection(${s.id}, -1)"><i class="fa-solid fa-arrow-up"></i></button>
        <button class="btn-sm" ${idx===sections.length-1?'disabled':''} onclick="moveSection(${s.id}, 1)"><i class="fa-solid fa-arrow-down"></i></button>
      </td>
      <td>${s.image ? `<img src="${s.image}" style="width:26px; height:26px; border-radius:7px; object-fit:cover; vertical-align:middle; margin-left:6px;">` : (s.emoji||'')} ${s.name}</td>
      <td>${s.products_count}</td>
      <td>${s.active ? '<span class="status-badge completed">مفعّل</span>' : '<span class="status-badge pending">معطّل</span>'}</td>
      <td>
        <button class="btn-sm" onclick="pickImage('section', ${s.id})"><i class="fa-solid fa-camera"></i></button>
        <button class="btn-sm" onclick="openAiImage('section', ${s.id}, '${s.name.replace(/'/g,"")}')" title="إنشاء صورة بالذكاء الاصطناعي"><i class="fa-solid fa-wand-magic-sparkles"></i></button>
        <button class="btn-sm" onclick="openEdit('section', ${s.id}, '${s.name.replace(/'/g,"")}', {name:'${s.name.replace(/'/g,"")}', emoji:'${s.emoji||''}', active:${s.active}})"><i class="fa-solid fa-pen"></i></button>
        <button class="btn-sm" onclick="openSubsections(${s.id}, '${s.name.replace(/'/g,"")}')"><i class="fa-solid fa-layer-group"></i> الأقسام الفرعية (${s.subsections_count||0})</button>
        <button class="btn-sm danger" onclick="deleteSection(${s.id})">حذف</button>
      </td>
    </tr>`).join("")
    || `<tr><td colspan="5" class="text-muted" style="text-align:center; padding:16px;">لا توجد أقسام بعد</td></tr>`;
}
async function moveSection(id, dir){
  const idx = sectionsListCache.findIndex(s=>s.id===id);
  const swapIdx = idx + dir;
  if(idx<0 || swapIdx<0 || swapIdx>=sectionsListCache.length) return;
  [sectionsListCache[idx], sectionsListCache[swapIdx]] = [sectionsListCache[swapIdx], sectionsListCache[idx]];
  renderSectionsTable();
  try{
    await adminFetch("/admin/sections/reorder", { method:"POST", body: JSON.stringify({ ids: sectionsListCache.map(s=>s.id) }) });
  }catch(err){ toast(err.message, "error"); loadSections(); }
}
async function addSection(){
  const name = document.getElementById("newSectionName").value.trim();
  const emoji = document.getElementById("newSectionEmoji").value.trim();
  if(!name){ toast("أدخل اسم القسم", "error"); return; }
  try{
    await adminFetch("/admin/sections", { method:"POST", body: JSON.stringify({ name, emoji }) });
    toast("تمت إضافة القسم ✅");
    document.getElementById("newSectionName").value = "";
    document.getElementById("newSectionEmoji").value = "";
    loadSections();
  }catch(err){ toast(err.message, "error"); }
}
async function deleteSection(id){
  try{ await adminFetch(`/admin/sections/${id}`, { method:"DELETE" }); toast("تم الحذف"); loadSections(); }
  catch(err){ toast(err.message, "error"); }
}

/* ===== الأقسام الفرعية ===== */
let currentSectionId = null;
let subsectionsListCache = [];
async function openSubsections(sectionId, sectionName){
  currentSectionId = sectionId;
  document.getElementById("subsectionsPanel").style.display = "block";
  document.getElementById("subsectionsPanelTitle").textContent = "الأقسام الفرعية لـ: " + sectionName;
  document.getElementById("subsectionsPanel").scrollIntoView({ behavior:"smooth", block:"center" });
  await loadSubsections();
}
async function loadSubsections(){
  subsectionsListCache = await adminFetch(`/admin/sections/${currentSectionId}/subsections`);
  renderSubsectionsTable();
}
function renderSubsectionsTable(){
  const subs = subsectionsListCache;
  document.getElementById("subsectionsTableBody").innerHTML = subs.map((s, idx)=>`
    <tr>
      <td>
        <button class="btn-sm" ${idx===0?'disabled':''} onclick="moveSubsection(${s.id}, -1)"><i class="fa-solid fa-arrow-up"></i></button>
        <button class="btn-sm" ${idx===subs.length-1?'disabled':''} onclick="moveSubsection(${s.id}, 1)"><i class="fa-solid fa-arrow-down"></i></button>
      </td>
      <td>${s.image ? `<img src="${s.image}" style="width:26px; height:26px; border-radius:7px; object-fit:cover; vertical-align:middle; margin-left:6px;">` : (s.emoji||'')} ${s.name}</td>
      <td>${s.products_count}</td>
      <td>${s.active ? '<span class="status-badge completed">مفعّل</span>' : '<span class="status-badge pending">معطّل</span>'}</td>
      <td>
        <button class="btn-sm" onclick="pickImage('subsection', ${s.id})"><i class="fa-solid fa-camera"></i></button>
        <button class="btn-sm" onclick="openAiImage('subsection', ${s.id}, '${s.name.replace(/'/g,"")}')" title="إنشاء صورة بالذكاء الاصطناعي"><i class="fa-solid fa-wand-magic-sparkles"></i></button>
        <button class="btn-sm" onclick="openEdit('subsection', ${s.id}, '${s.name.replace(/'/g,"")}', {name:'${s.name.replace(/'/g,"")}', emoji:'${s.emoji||''}', active:${s.active}})"><i class="fa-solid fa-pen"></i></button>
        <button class="btn-sm" onclick="openSubsectionMove(${s.id}, '${s.name.replace(/'/g,"")}')" title="نقل الفرع كاملاً مع محتواه لأي قسم"><i class="fa-solid fa-truck-fast"></i> نقل فرع</button>
        <button class="btn-sm danger" onclick="deleteSubsection(${s.id})">حذف</button>
      </td>
    </tr>`).join("")
    || `<tr><td colspan="5" class="text-muted" style="text-align:center; padding:16px;">لا توجد أقسام فرعية بعد</td></tr>`;
}
async function moveSubsection(id, dir){
  const idx = subsectionsListCache.findIndex(s=>s.id===id);
  const swapIdx = idx + dir;
  if(idx<0 || swapIdx<0 || swapIdx>=subsectionsListCache.length) return;
  [subsectionsListCache[idx], subsectionsListCache[swapIdx]] = [subsectionsListCache[swapIdx], subsectionsListCache[idx]];
  renderSubsectionsTable();
  try{
    await adminFetch(`/admin/sections/${currentSectionId}/subsections/reorder`, { method:"POST", body: JSON.stringify({ ids: subsectionsListCache.map(s=>s.id) }) });
  }catch(err){ toast(err.message, "error"); loadSubsections(); }
}
async function addSubsection(){
  const name = document.getElementById("newSubsectionName").value.trim();
  const emoji = document.getElementById("newSubsectionEmoji").value.trim();
  if(!name){ toast("أدخل اسم القسم الفرعي", "error"); return; }
  try{
    await adminFetch(`/admin/sections/${currentSectionId}/subsections`, { method:"POST", body: JSON.stringify({ name, emoji }) });
    toast("تمت الإضافة ✅");
    document.getElementById("newSubsectionName").value = "";
    document.getElementById("newSubsectionEmoji").value = "";
    loadSubsections();
    loadSections(); // لتحديث عداد الأقسام الفرعية بجدول الأقسام
  }catch(err){ toast(err.message, "error"); }
}
async function deleteSubsection(id){
  try{ await adminFetch(`/admin/subsections/${id}`, { method:"DELETE" }); toast("تم الحذف"); loadSubsections(); loadSections(); }
  catch(err){ toast(err.message, "error"); }
}
/* نافذة نقل فرع كامل مع كل محتواه (منتجاته وفئاتها) لأي قسم آخر */
async function openSubsectionMove(id, name){
  editTarget = { kind:"subsection_move", id };
  document.getElementById("editModalTitle").textContent = "نقل الفرع: " + name;
  const body = document.getElementById("editModalBody");
  const fld = "padding:11px;border-radius:11px;border:1px solid var(--border);background:var(--card-soft);color:var(--text);";
  let secs = (typeof sectionsListCache !== "undefined" && sectionsListCache.length) ? sectionsListCache : [];
  if(!secs.length){
    try{ secs = await adminFetch("/admin/sections"); }catch(err){ secs = []; }
  }
  const cur = (typeof subsectionsListCache !== "undefined" ? subsectionsListCache : []).find(s=>s.id===id);
  body.innerHTML = `
    <div class="field"><label>القسم الهدف (ينتقل الفرع لنهايته مع كل منتجاته)</label>
      <select id="mv_target_section" style="${fld}">${secs.filter(s=>!cur || s.id!==cur.section_id).map(s=>`<option value="${s.id}">${escapeHtml(s.name)}</option>`).join("") || `<option value="">لا توجد أقسام أخرى</option>`}</select></div>
    <div class="info-banner" style="font-size:11px;"><i class="fa-solid fa-circle-info"></i><div>الفرع ومنتجاته وفئاتها ينتقلون معاً بدون أي فقدان، ويُحفظ ترتيب المنتجات كما هو.</div></div>`;
  document.getElementById("editModal").style.display = "flex";
}

/* ===== 7) طرق الإيداع ===== */
async function loadDepositMethods(){
  const m = await adminFetch("/admin/deposit-methods");
  document.getElementById("autoMethodsBody").innerHTML = m.auto.map(a=>`
    <tr>
      <td><img src="${a.image || ''}" onerror="this.style.visibility='hidden'" style="width:34px; height:34px; border-radius:8px; object-fit:cover; background:var(--card-soft); display:${a.image?'block':'none'};"></td>
      <td>${a.title} ${a.gateway_type==='invoice' ? '<span class="badge-sm" style="background:var(--success);">فاتورة</span>' : '<span class="badge-sm">تحقق</span>'}</td><td style="font-family:'Orbitron',monospace; font-size:10px;">${a.api_url}</td>
      <td style="display:flex; gap:6px;">
        <button class="btn-sm" onclick="pickImage('auto_method', ${a.id})"><i class="fa-solid fa-image"></i> صورة</button>
        <button class="btn-sm danger" onclick="deleteAutoMethod(${a.id})">حذف</button>
      </td>
    </tr>`).join("")
    || `<tr><td colspan="4" class="text-muted" style="text-align:center; padding:12px;">لا توجد طرق تلقائية بعد</td></tr>`;
  document.getElementById("manualMethodsBody").innerHTML = m.manual.map(a=>`
    <tr>
      <td><img src="${a.image || ''}" onerror="this.style.visibility='hidden'" style="width:34px; height:34px; border-radius:8px; object-fit:cover; background:var(--card-soft); display:${a.image?'block':'none'};"></td>
      <td>${a.title}</td>
      <td style="display:flex; gap:6px;">
        <button class="btn-sm" onclick="pickImage('manual_method', ${a.id})"><i class="fa-solid fa-image"></i> صورة</button>
        <button class="btn-sm danger" onclick="deleteManualMethod(${a.id})">حذف</button>
      </td>
    </tr>`).join("")
    || `<tr><td colspan="3" class="text-muted" style="text-align:center; padding:12px;">لا توجد طرق يدوية بعد</td></tr>`;
}
async function addAutoMethod(){
  const title = document.getElementById("autoMethodTitle").value.trim();
  const description = document.getElementById("autoMethodDescription").value.trim();
  const api_token = document.getElementById("autoMethodToken").value.trim();
  const api_url = document.getElementById("autoMethodUrl").value.trim();
  const gateway_type = document.getElementById("autoMethodGatewayType")?.value || "verify";
  const input_currency = document.getElementById("autoMethodCurrency")?.value || "usd";
  if(!title || !api_token || !api_url){ toast("عبّي كل الحقول", "error"); return; }
  try{
    await adminFetch("/admin/deposit-methods/auto", { method:"POST", body: JSON.stringify({ title, description, api_token, api_url, gateway_type, input_currency }) });
    toast("تمت الإضافة ✅");
    ["autoMethodTitle","autoMethodDescription","autoMethodToken","autoMethodUrl"].forEach(id=> document.getElementById(id).value = "");
    loadDepositMethods();
  }catch(err){ toast(err.message, "error"); }
}
async function deleteAutoMethod(id){
  try{ await adminFetch(`/admin/deposit-methods/auto/${id}`, { method:"DELETE" }); toast("تم الحذف"); loadDepositMethods(); }
  catch(err){ toast(err.message, "error"); }
}
async function addManualMethod(){
  const title = document.getElementById("manualMethodTitle").value.trim();
  const code = document.getElementById("manualMethodCode").value.trim();
  const description = document.getElementById("manualMethodDescription")?.value.trim() || "";
  const input_currency = document.getElementById("manualMethodCurrency")?.value || "usd";
  if(!title){ toast("أدخل اسم الطريقة", "error"); return; }
  try{
    await adminFetch("/admin/deposit-methods/manual", { method:"POST", body: JSON.stringify({ title, code, description, input_currency }) });
    toast("تمت الإضافة ✅");
    document.getElementById("manualMethodTitle").value = "";
    document.getElementById("manualMethodCode").value = "";
    if(document.getElementById("manualMethodDescription")) document.getElementById("manualMethodDescription").value = "";
    loadDepositMethods();
  }catch(err){ toast(err.message, "error"); }
}
async function deleteManualMethod(id){
  try{ await adminFetch(`/admin/deposit-methods/manual/${id}`, { method:"DELETE" }); toast("تم الحذف"); loadDepositMethods(); }
  catch(err){ toast(err.message, "error"); }
}

/* ===== 8) مزوّدو API ===== */
/* ===== التسعير الذكي ===== */
let ALL_PRICING_ROWS = [];

async function loadPricing(){
  ALL_PRICING_ROWS = await adminFetch("/admin/categories/all-pricing");
  document.getElementById("pricingSelectAll").checked = false;
  renderPricingTable();
}

function renderPricingTable(){
  const box = document.getElementById("pricingTableBody");
  box.innerHTML = ALL_PRICING_ROWS.map(c => `
    <tr>
      <td><input type="checkbox" class="pricing-row-check" data-id="${c.id}" onchange="updatePricingSelectedCount()"></td>
      <td>${c.product_name}</td>
      <td>${c.name}</td>
      <td>${c.linked ? (c.token_ok ? c.provider_name : `<span style="color:var(--danger);">⚠️ ${c.provider_name} — التوكن فارغ!</span>`) : '<span class="text-muted">غير مربوطة</span>'}</td>
      <td>${c.cost_usd != null ? "$"+Number(c.cost_usd).toFixed(4) : "—"}</td>
      <td>${c.margin_percent != null ? c.margin_percent+"%" : '<span class="text-muted">يدوي</span>'}</td>
      <td>$${Number(c.price_usd).toFixed(4)}</td>
    </tr>`).join("")
    || `<tr><td colspan="7" class="text-muted" style="text-align:center; padding:16px;">لا توجد فئات بعد — أضف منتجات وفئات من قسم "المنتجات والفئات" أولاً</td></tr>`;
  updatePricingSelectedCount();
}

function toggleSelectAllPricing(checkbox){
  document.querySelectorAll(".pricing-row-check").forEach(c => c.checked = checkbox.checked);
  updatePricingSelectedCount();
}

function updatePricingSelectedCount(){
  const n = document.querySelectorAll(".pricing-row-check:checked").length;
  document.getElementById("pricingSelectedCount").textContent = `${n} فئة محددة`;
}

function getSelectedPricingIds(){
  return Array.from(document.querySelectorAll(".pricing-row-check:checked")).map(c => Number(c.dataset.id));
}

async function applyMarginToSelected(){
  const ids = getSelectedPricingIds();
  const margin = Number(document.getElementById("pricingMarginInput").value);
  if(!ids.length){ toast("حدد فئة واحدة على الأقل من الجدول", "error"); return; }
  if(isNaN(margin) || margin < 0){ toast("أدخل نسبة هامش صحيحة", "error"); return; }
  try{
    const res = await adminFetch("/admin/categories/apply-margin", {
      method: "POST",
      body: JSON.stringify({ category_ids: ids, margin_percent: margin })
    });
    toast(res.message);
    loadPricing();
  }catch(err){ toast(err.message, "error"); }
}

async function loadProviders(){
  const providers = await adminFetch("/admin/providers");
  document.getElementById("providersTableBody").innerHTML = providers.map(p=>`
    <tr><td>${p.name}${p.has_token ? "" : ' <span style="color:var(--danger);" title="هذا المزوّد بلا توكن — الطلبات المرتبطة به لن تذهب للـ API">⚠️ بلا توكن</span>'}</td><td style="font-family:'Orbitron',monospace; font-size:10px;">${p.api_url}</td>
    <td id="provBal_${p.id}">${p.balance
      ? `<b style="color:var(--success); font-family:'Orbitron',monospace; font-size:11px;">💰 ${p.balance}</b><br><small style="color:var(--muted); font-size:9px;">${p.balance_at||''}</small>`
      : `<span class="text-muted" style="font-size:10px;">—</span>`}
      <div style="display:flex; gap:4px; margin-top:4px; flex-wrap:wrap;">
        <button class="btn-sm" onclick="refreshBalance(${p.id}, this)"><i class="fa-solid fa-arrows-rotate"></i> تحديث</button>
        <button class="btn-sm" onclick="setBalanceManual(${p.id})">✏️ يدوي</button>
      </div></td>
    <td>${p.linked_products}</td>
    <td><input type="number" id="importMargin_${p.id}" placeholder="10" min="0" step="0.5" style="width:70px; padding:7px; border-radius:8px; border:1px solid var(--border); background:var(--card-soft); color:var(--text); font-size:11px;"></td>
    <td style="display:flex; gap:6px; flex-wrap:wrap;">
      <button class="btn-sm" onclick="testProvider(${p.id}, this)"><i class="fa-solid fa-stethoscope"></i> فحص الاتصال</button>
      <button class="btn-sm primary" onclick="importProviderCatalog(${p.id}, '${p.name.replace(/'/g,"")}')"><i class="fa-solid fa-cloud-arrow-down"></i> استيراد الكل</button>
      <button class="btn-sm" onclick="exportProviderProducts(${p.id}, '${p.name.replace(/'/g,"")}')"><i class="fa-solid fa-file-arrow-down"></i> تحميل قائمة المنتجات</button>
      <button class="btn-sm danger" onclick="deleteProvider(${p.id})">حذف</button>
    </td></tr>`).join("")
    || `<tr><td colspan="6" class="text-muted" style="text-align:center; padding:16px;">لا يوجد مزوّدون بعد</td></tr>`;
}

async function refreshBalance(pid, btn){
  const cell = document.getElementById("provBal_" + pid);
  const origBtn = btn ? btn.innerHTML : "";
  if(btn){ btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>'; }
  try{
    const r = await adminFetch(`/admin/providers/${pid}/balance`);
    if(r.ok){
      if(cell) cell.innerHTML = `<b style="color:var(--success); font-family:'Orbitron',monospace; font-size:11px;">💰 ${r.balance}</b><br><small style="color:var(--muted); font-size:9px;">${r.cached_at||''}</small>
        <div style="display:flex; gap:4px; margin-top:4px; flex-wrap:wrap;">
          <button class="btn-sm" onclick="refreshBalance(${pid}, this)"><i class="fa-solid fa-arrows-rotate"></i> تحديث</button>
          <button class="btn-sm" onclick="setBalanceManual(${pid})">✏️ يدوي</button>
        </div>`;
      toast("تم تحديث الرصيد ✅");
    }else{
      const tried = (r.tried || []).map(t=>`• ${t.url}\n  ${t.result}`).join("\n");
      alert(`تعذّر قراءة الرصيد الحي (${r.note || "؟"})\n\nالمحاولات:\n${tried || "—"}\n\n${r.balance ? "المعروض الآن آخر قراءة محفوظة." : "لا توجد قراءة محفوظة."}\n\nإن كان لمزوّدك مسار رصيد خاص، أدخله بحقل "مسار الرصيد" عند إضافة المزوّد.`);
      loadProviders();
    }
  }catch(err){ toast(err.message, "error"); }
  finally{ if(btn && !cell){ btn.disabled = false; btn.innerHTML = origBtn; } }
}

async function setBalanceManual(pid){
  const v = prompt("أدخل رصيد المزوّد الحالي كما يظهر بلوحة المزوّد (مثال: 1250$):");
  if(v === null) return;
  if(!v.trim()){ toast("أدخل قيمة", "error"); return; }
  try{
    const r = await adminFetch(`/admin/providers/${pid}/balance-manual`, { method:"POST", body: JSON.stringify({ balance: v.trim() }) });
    toast(r.message);
    loadProviders();
  }catch(err){ toast(err.message, "error"); }
}

async function refreshAllBalances(btn){
  if(btn){ btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> جاري تحديث الأرصدة...'; }
  try{
    const providers = await adminFetch("/admin/providers");
    for(const p of providers){
      try{
        const r = await adminFetch(`/admin/providers/${p.id}/balance`);
        const cell = document.getElementById("provBal_" + p.id);
        if(cell && r.ok) cell.innerHTML = `<b style="color:var(--success); font-family:'Orbitron',monospace; font-size:11px;">💰 ${r.balance}</b><br><small style="color:var(--muted); font-size:9px;">${r.cached_at||''}</small>
          <div style="display:flex; gap:4px; margin-top:4px; flex-wrap:wrap;">
            <button class="btn-sm" onclick="refreshBalance(${p.id}, this)"><i class="fa-solid fa-arrows-rotate"></i> تحديث</button>
            <button class="btn-sm" onclick="setBalanceManual(${p.id})">✏️ يدوي</button>
          </div>`;
      }catch(e){ /* مزوّد واحد فاشل لا يوقف البقية */ }
    }
    toast("تم تحديث الأرصدة ✅");
  }catch(err){ toast(err.message, "error"); }
  finally{ if(btn){ btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-wallet"></i> تحديث كل الأرصدة'; } }
}

async function testProvider(pid, btn){
  const orig = btn ? btn.innerHTML : "";
  if(btn){ btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> جاري الفحص...'; }
  try{
    const r = await adminFetch(`/admin/providers/${pid}/test`, { method:"POST" });
    const lines = (r.checks || []).map(c=>`• ${c.label}: ${c.verdict}\n  ${c.url}`).join("\n");
    const balLine = r.balance ? `\n💰 رصيد المزوّد: ${r.balance}` : (r.balance_note ? `\n💰 الرصيد: تعذّر (${r.balance_note})` : "");
    const balTried = (!r.balance && (r.balance_tried||[]).length) ? `\n--- محاولات الرصيد ---\n${r.balance_tried.map(t=>`• ${t.url}\n  ${t.result}`).join("\n")}` : "";
    alert(`${r.message}\n\n${lines}\n\nالمنتجات المرصودة: ${r.products_found ?? 0}\nرابط الطلب: ${r.order_url}${balLine}${balTried}`);
    loadProviders();
  }catch(err){ toast(err.message, "error"); }
  finally{ if(btn){ btn.disabled = false; btn.innerHTML = orig; } }
}

async function exportProviderProducts(providerId, providerName){
  toast("جاري تجهيز ملف المنتجات ⏳");
  try{
    const token = localStorage.getItem("admin_token");
    const res = await fetch(`${API_BASE}/admin/providers/${providerId}/products/export`, {
      headers: token ? { "Authorization": "Bearer " + token } : {}
    });
    if(!res.ok){
      const data = await res.json().catch(()=>null);
      throw new Error((data && data.message) || "تعذّر تحميل الملف");
    }
    const blob = await res.blob();
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `products_${providerName || providerId}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(link.href);
    toast("تم تحميل قائمة المنتجات ✅");
  }catch(err){ toast(err.message, "error"); }
}

/* ===== إنشاء صور بالذكاء الاصطناعي ===== */
let aiImageTarget = null;
let aiImageUrl = null;
function openAiImage(kind, id, name){
  aiImageTarget = { kind, id, name };
  aiImageUrl = null;
  document.getElementById("aiImageTitle").textContent = "إنشاء صورة لـ: " + name;
  document.getElementById("aiImagePreview").style.display = "none";
  document.getElementById("aiImageConfirm").disabled = true;
  const pv = document.getElementById("aiImagePromptView");
  if(pv) pv.style.display = "none";
  document.getElementById("aiImageStatus").textContent = "اضغط «إنشاء صورة» — الاسم العربي يُحوَّل تلقائياً لإنجليزي فخم بهوية المتجر.";
  document.getElementById("aiImageModal").style.display = "flex";
}
function closeAiImage(){ document.getElementById("aiImageModal").style.display = "none"; aiImageTarget = null; }
async function generateAiImage(){
  if(!aiImageTarget) return;
  const status = document.getElementById("aiImageStatus");
  status.textContent = "جاري إنشاء الصورة... ⏳";
  document.getElementById("aiImageConfirm").disabled = true;
  try{
    const res = await adminFetch("/admin/ai-image/generate", {
      method: "POST",
      body: JSON.stringify({ kind: aiImageTarget.kind, name: aiImageTarget.name })
    });
    aiImageUrl = res.url;
    const img = document.getElementById("aiImagePreview");
    img.src = res.url;
    img.style.display = "block";
    document.getElementById("aiImageConfirm").disabled = false;
    status.textContent = res.message || "الصورة جاهزة — أكّدها أو أعد الإنشاء.";
    const pv = document.getElementById("aiImagePromptView");
    if(pv && (res.name_en || res.prompt)){
      pv.style.display = "block";
      pv.innerHTML = (res.name_en ? `<div style="margin-bottom:6px;">🏷️ <b dir="auto" style="color:var(--gold);">${escapeHtml(res.name_en)}</b> <span style="color:var(--muted);font-size:11px;">(الاسم بالإنجليزي داخل الصورة — بدون أي حرف عربي)</span></div>` : "")
        + (res.brand && res.brand.name ? `<div style="margin-bottom:6px; font-size:12px;">🎮 تم التعرف على اللعبة: <b dir="auto">${escapeHtml(res.brand.name)}</b> <span style="color:var(--muted);">— شعارها الرسمي داخل الصورة${res.brand.monogram ? " (" + escapeHtml(res.brand.monogram) + ")" : ""}</span></div>` : "")
        + (res.prompt ? `<div style="font-size:11px;color:var(--muted);line-height:1.8;text-align:left;direction:ltr;">${escapeHtml(res.prompt)}</div>` : "");
    }
  }catch(err){
    status.textContent = err.message;
    toast(err.message, "error");
  }
}
async function confirmAiImage(){
  if(!aiImageTarget || !aiImageUrl) return;
  try{
    await adminFetch("/admin/ai-image/apply", {
      method: "POST",
      body: JSON.stringify({ kind: aiImageTarget.kind, id: aiImageTarget.id, url: aiImageUrl })
    });
    toast("تم اعتماد الصورة ✅");
    const kind = aiImageTarget.kind;
    closeAiImage();
    if(kind === "product") loadProducts();
    if(kind === "category") loadCategories();
    if(kind === "section") loadSections();
    if(kind === "subsection") loadSubsections();
  }catch(err){ toast(err.message, "error"); }
}

async function importProviderCatalog(providerId, providerName){
  const marginInput = document.getElementById(`importMargin_${providerId}`);
  const margin = Number(marginInput.value);
  if(isNaN(margin) || margin < 0){ toast("حدد هامش ربح صحيح بالخانة جنب زر الاستيراد", "error"); return; }
  if(!confirm(`رح يتم سحب كل كتالوج "${providerName}" (كل الأقسام والمنتجات) وإضافته لموقعك بهامش ربح ${margin}%.\nهاي عملية دفعة وحدة، متابع؟`)) return;
  toast("جاري الاستيراد... قد ياخد لحظات حسب حجم كتالوج المزوّد ⏳");
  try{
    const res = await adminFetch(`/admin/providers/${providerId}/import-catalog`, {
      method: "POST", body: JSON.stringify({ margin_percent: margin })
    });
    toast("✅ " + res.message);
    loadProviders();
  }catch(err){ toast(err.message, "error"); }
}
async function importProviderFile(){
  const input = document.getElementById("impFileInput");
  const result = document.getElementById("impFileResult");
  const file = input && input.files && input.files[0];
  if(!file){ toast("اختر ملف CSV أولاً", "error"); return; }
  const text = await file.text();
  const lines = text.split(/\r?\n/);
  const header = lines[0] || "";
  const body = lines.slice(1).filter(l => l.trim() !== "");
  if(!body.length){ toast("الملف فارغ", "error"); return; }
  const CHUNK = 100;
  let imported = 0, skipped = 0, dups = 0, sections = [], n = 0;
  for(let i = 0; i < body.length; i += CHUNK){
    n++;
    const chunkText = header + "\n" + body.slice(i, i + CHUNK).join("\n");
    const fd = new FormData();
    fd.append("file", new Blob([chunkText], { type: "text/csv" }), file.name);
    fd.append("name", document.getElementById("impFileName").value.trim() || "Shams");
    fd.append("token", document.getElementById("impFileToken").value.trim());
    fd.append("url", document.getElementById("impFileUrl").value.trim());
    fd.append("margin", document.getElementById("impFileMargin").value || "15");
    fd.append("grouping", document.getElementById("impFileGrouping").value || "sections");
    if(result) result.textContent = `⏳ جاري الاستيراد… الدفعة ${n} من ${Math.ceil(body.length / CHUNK)}`;
    try{
      const res = await adminFetch("/admin/providers/import-file", { method:"POST", body: fd });
      imported += res.imported || 0; skipped += res.skipped || 0; dups += res.duplicates || 0;
      (res.sections || []).forEach(s => { if(!sections.includes(s)) sections.push(s); });
    }catch(err){ if(result) result.textContent = "توقفت عند الدفعة " + n + ": " + err.message; toast(err.message, "error"); return; }
  }
  if(result) result.textContent = `✅ تم استيراد وربط ${imported} منتج (تخطّي ${skipped}، مكرر ${dups}) | الأقسام: ${sections.join("، ")}`;
  toast(`✅ تم استيراد ${imported} منتج`);
  loadProviders(); if(typeof loadSections === "function") loadSections(); if(typeof loadProducts === "function") loadProducts();
}
async function addProvider(){
  const name = document.getElementById("providerName").value.trim();
  const token = document.getElementById("providerToken").value.trim();
  const url = document.getElementById("providerUrl").value.trim();
  const order_path = document.getElementById("providerOrderPath")?.value.trim() || "";
  const status_path = document.getElementById("providerStatusPath")?.value.trim() || "";
  const catalog_path = document.getElementById("providerCatalogPath")?.value.trim() || "";
  const balance_path = document.getElementById("providerBalancePath")?.value.trim() || "";
  if(!name || !token || !url){ toast("عبّي الاسم والتوكن والرابط", "error"); return; }
  try{
    await adminFetch("/admin/providers", { method:"POST", body: JSON.stringify({ name, token, url, order_path, status_path, catalog_path, balance_path }) });
    toast("تمت إضافة المزوّد ✅");
    ["providerName","providerToken","providerUrl","providerOrderPath","providerStatusPath","providerCatalogPath","providerBalancePath"].forEach(id=>{ const el = document.getElementById(id); if(el) el.value = ""; });
    loadProviders();
  }catch(err){ toast(err.message, "error"); }
}
async function deleteProvider(id){
  try{ await adminFetch(`/admin/providers/${id}`, { method:"DELETE" }); toast("تم الحذف"); loadProviders(); }
  catch(err){ toast(err.message, "error"); }
}

/* ===== إعدادات عامة ===== */
async function loadSettings(){
  const s = await adminFetch("/admin/settings");
  document.getElementById("settingsRate").value = s.exchange_rate;
  document.getElementById("settingsWelcome").value = s.welcome_message;
  document.getElementById("settingsSupport").value = s.support_username;
  document.getElementById("settingsPopupEnabled").checked = !!s.welcome_popup_enabled;
  document.getElementById("settingsPopupText").value = s.welcome_popup_text || "";
  if(document.getElementById("settingsAiUrl")){
    document.getElementById("settingsAiUrl").value = s.ai_image_api_url || "";
    document.getElementById("settingsAiKey").value = s.ai_image_api_key || "";
    document.getElementById("settingsAiPrompt").value = s.ai_image_prompt_template || "";
  }
  const setVal = (id, v)=>{ const el = document.getElementById(id); if(el) el.value = v || ""; };
  setVal("settingsAiType", s.ai_image_api_type || "custom");
  setVal("settingsAiModel", s.ai_image_model || "");
  setVal("settingsAiPromptProduct", s.ai_image_prompt_product);
  setVal("settingsAiPromptSection", s.ai_image_prompt_section);
  setVal("settingsAdminChatIds", s.admin_notify_chat_ids);
  const c = s.contact || {};
  setVal("settingsWaNumber", c.whatsapp_number);
  setVal("settingsWaUrl", c.whatsapp_url);
  setVal("settingsTgUrl", c.telegram_url);
  setVal("settingsWaChannel", c.whatsapp_channel_url);
  setVal("settingsTgChannel", c.telegram_channel_url);
  const devWrap = document.getElementById("devLogoPreviewWrap");
  if(devWrap){
    if(s.dev_logo){
      document.getElementById("devLogoPreview").src = s.dev_logo;
      document.getElementById("devLogoPreview").onerror = ()=>{ devWrap.style.display = "none"; };
      devWrap.style.display = "block";
    }
    else devWrap.style.display = "none";
  }

  const grid = document.getElementById("bannerPreviewGrid");
  const images = s.banner_images || [];
  grid.innerHTML = images.map(b => `
    <div style="position:relative; display:inline-block; margin:4px;">
      <img src="${b.image}" style="width:120px; height:64px; object-fit:cover; border-radius:10px; border:1px solid var(--border); display:block;">
      <button class="btn-sm danger" style="position:absolute; top:-6px; left:-6px; padding:2px 7px; border-radius:50%;" onclick="removeBannerImage(${b.id})"><i class="fa-solid fa-xmark"></i></button>
    </div>`).join("") || `<div class="text-muted" style="font-size:11.5px;">لا توجد صور بعد — أضف حتى 5 صور للسلايدر</div>`;
  document.getElementById("bannerCountHint").textContent = `${images.length} / 5 صور`;
  document.getElementById("bannerAddBtn").disabled = images.length >= 5;

  const logoWrap = document.getElementById("logoPreviewWrap");
  if(s.logo_image){
    document.getElementById("logoPreview").src = s.logo_image;
    document.getElementById("logoPreview").onerror = ()=>{ logoWrap.style.display = "none"; };
    logoWrap.style.display = "block";
  }else{ logoWrap.style.display = "none"; }

  const iconWrap = document.getElementById("appIconPreviewWrap");
  if(s.app_icon){
    document.getElementById("appIconPreview").src = s.app_icon;
    document.getElementById("appIconPreview").onerror = ()=>{ iconWrap.style.display = "none"; };
    iconWrap.style.display = "block";
  }else{ iconWrap.style.display = "none"; }

  const notifWrap = document.getElementById("notifIconPreviewWrap");
  if(notifWrap){
    if(s.notif_icon){
      document.getElementById("notifIconPreview").src = s.notif_icon;
      document.getElementById("notifIconPreview").onerror = ()=>{ notifWrap.style.display = "none"; };
      notifWrap.style.display = "block";
    }else{ notifWrap.style.display = "none"; }
  }

  loadMaintenanceStatus();
}

function fmtHMS(sec){
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec/3600), m = Math.floor((sec%3600)/60), s2 = sec%60;
  return `${h} ساعة ${m} دقيقة ${s2} ثانية`;
}

let _adminMaintenanceInterval = null;
async function loadMaintenanceStatus(){
  try{
    const m = await adminFetch("/admin/maintenance");
    const box = document.getElementById("maintenanceStatusBox");
    if(_adminMaintenanceInterval) clearInterval(_adminMaintenanceInterval);
    if(m.enabled){
      box.style.display = "flex";
      let remaining = m.seconds_left;
      document.getElementById("maintenanceRemaining").textContent = fmtHMS(remaining);
      const rv = document.getElementById("maintenanceReasonView");
      if(rv) rv.textContent = [m.reason, m.note].filter(Boolean).join(" — ") || "";
      _adminMaintenanceInterval = setInterval(()=>{
        remaining -= 1;
        if(remaining <= 0){ clearInterval(_adminMaintenanceInterval); box.style.display = "none"; return; }
        document.getElementById("maintenanceRemaining").textContent = fmtHMS(remaining);
      }, 1000);
    } else {
      box.style.display = "none";
    }
  }catch(err){ /* تجاهل */ }
}

async function enableMaintenance(){
  const num = (id)=> Number(document.getElementById(id)?.value || 0);
  const months = num("maintenanceMonths"), days = num("maintenanceDays"),
        hours = num("maintenanceHours"), minutes = num("maintenanceMinutes");
  const reason = document.getElementById("maintenanceReason")?.value.trim() || "";
  const note = document.getElementById("maintenanceNote")?.value.trim() || "";
  if(months < 0 || days < 0 || hours < 0 || minutes < 0){ toast("المدد لا تقبل القيم السالبة", "error"); return; }
  if(!(months > 0 || days > 0 || hours > 0 || minutes > 0)){ toast("حدد مدة أكبر من الصفر (شهر/يوم/ساعة/دقيقة)", "error"); return; }
  try{
    await adminFetch("/admin/maintenance", { method:"POST", body: JSON.stringify({ enabled: true, months, days, hours, minutes, reason, note }) });
    toast("✅ تم تفعيل وضع الصيانة");
    loadMaintenanceStatus();
  }catch(err){ toast(err.message, "error"); }
}

async function disableMaintenance(){
  try{
    await adminFetch("/admin/maintenance", { method:"POST", body: JSON.stringify({ enabled: false }) });
    toast("✅ تم إيقاف وضع الصيانة");
    loadMaintenanceStatus();
  }catch(err){ toast(err.message, "error"); }
}

async function removeBannerImage(imageId){
  try{ await adminFetch(`/admin/settings/banner-image/${imageId}`, { method:"DELETE" }); toast("تمت إزالة الصورة"); loadSettings(); }
  catch(err){ toast(err.message, "error"); }
}
async function clearAllBanners(){
  if(!confirm("سيتم حذف كل صور البنرات. متابعة؟")) return;
  try{ await adminFetch("/admin/banners/all", { method:"DELETE" }); toast("تم حذف كل البنرات ✅"); loadSettings(); }
  catch(err){ toast(err.message, "error"); }
}
async function removeLogo(){
  try{ await adminFetch("/admin/settings/logo", { method:"DELETE" }); toast("تمت إزالة اللوغو"); loadSettings(); location.reload(); }
  catch(err){ toast(err.message, "error"); }
}

async function removeDevLogo(){
  try{ await adminFetch("/admin/settings/dev-logo", { method:"DELETE" }); toast("تمت إزالة لوغو المطوّر"); loadSettings(); }
  catch(err){ toast(err.message, "error"); }
}

/* ===== تثبيت التطبيق (PWA) ===== */
let _deferredPwaPrompt = null;
window.addEventListener("beforeinstallprompt", (e)=>{
  e.preventDefault();
  _deferredPwaPrompt = e;
  const hint = document.getElementById("pwaHint");
  if(hint) hint.textContent = "التطبيق جاهز للتثبيت — اضغط الزر تحت.";
});
async function installPwa(){
  if(!_deferredPwaPrompt){
    toast("إذا كنت على آيفون: افتح مشاركة ← إضافة إلى الشاشة الرئيسية. أو التطبيق مثبّت مسبقاً.", "error");
    return;
  }
  _deferredPwaPrompt.prompt();
  const { outcome } = await _deferredPwaPrompt.userChoice;
  _deferredPwaPrompt = null;
  toast(outcome === "accepted" ? "تم تثبيت التطبيق ✅" : "تم إلغاء التثبيت");
}

async function removeAppIcon(){
  try{ await adminFetch("/admin/settings/app-icon", { method:"DELETE" }); toast("تمت إزالة أيقونة التطبيق"); loadSettings(); }
  catch(err){ toast(err.message, "error"); }
}
async function removeNotifIcon(){
  try{ await adminFetch("/admin/settings/notif-icon", { method:"DELETE" }); toast("تمت إزالة أيقونة الإشعارات — ستُستخدم أيقونة التطبيق/اللوغو"); loadSettings(); }
  catch(err){ toast(err.message, "error"); }
}

function previewWelcomePopup(){
  window.open("/store.html?preview_popup=1", "_blank");
}
async function saveSettings(){
  const exchange_rate = Number(document.getElementById("settingsRate").value || 0);
  const welcome_message = document.getElementById("settingsWelcome").value.trim();
  const support_username = document.getElementById("settingsSupport").value.trim();
  const welcome_popup_enabled = document.getElementById("settingsPopupEnabled").checked;
  const welcome_popup_text = document.getElementById("settingsPopupText").value.trim();
  const ai_image_api_url = document.getElementById("settingsAiUrl") ? document.getElementById("settingsAiUrl").value.trim() : "";
  const ai_image_api_key = document.getElementById("settingsAiKey") ? document.getElementById("settingsAiKey").value.trim() : "";
  const ai_image_prompt_template = document.getElementById("settingsAiPrompt") ? document.getElementById("settingsAiPrompt").value.trim() : "";
  const getVal = (id)=>{ const el = document.getElementById(id); return el ? el.value.trim() : ""; };
  const payload = {
    exchange_rate, welcome_message, support_username, welcome_popup_enabled, welcome_popup_text,
    ai_image_api_url, ai_image_api_key, ai_image_prompt_template,
    ai_image_api_type: getVal("settingsAiType") || "custom",
    ai_image_model: getVal("settingsAiModel"),
    ai_image_prompt_product: getVal("settingsAiPromptProduct"),
    ai_image_prompt_section: getVal("settingsAiPromptSection"),
    support_whatsapp_number: getVal("settingsWaNumber"),
    support_whatsapp_url: getVal("settingsWaUrl"),
    support_telegram_url: getVal("settingsTgUrl"),
    whatsapp_channel_url: getVal("settingsWaChannel"),
    telegram_channel_url: getVal("settingsTgChannel"),
  };
  try{
    await adminFetch("/admin/settings", { method:"POST", body: JSON.stringify(payload) });
    toast("تم حفظ الإعدادات ✅");
  }catch(err){ toast(err.message, "error"); }
}

/* ===== 11) صلاحيات الأدمن ===== */
async function loadAdmins(){
  const admins = await adminFetch("/admin/admins");
  document.getElementById("adminsTableBody").innerHTML = admins.map(a=>`
    <tr><td style="font-family:'Orbitron',monospace;">${a.user_id}</td>
    <td>${a.main ? '<span class="status-badge completed">مشرف رئيسي</span>' : '<span class="status-badge pending">مشرف</span>'}</td>
    <td>${a.main ? '—' : `<button class="btn-sm danger" onclick="removeAdminUser(${a.user_id})">إزالة</button>`}</td></tr>`).join("");
}
async function addAdminUser(){
  const idVal = document.getElementById("newAdminId").value.trim();
  if(!idVal || isNaN(Number(idVal))){ toast("أدخل آيدي تيليجرام صحيح (أرقام فقط)", "error"); return; }
  try{
    await adminFetch("/admin/admins", { method:"POST", body: JSON.stringify({ user_id: Number(idVal) }) });
    toast("تمت إضافة المشرف ✅");
    document.getElementById("newAdminId").value = "";
    loadAdmins();
  }catch(err){ toast(err.message, "error"); }
}
async function removeAdminUser(userId){
  try{ await adminFetch(`/admin/admins/${userId}`, { method:"DELETE" }); toast("تمت الإزالة"); loadAdmins(); }
  catch(err){ toast(err.message, "error"); }
}

/* ===== 11-b) أدمن الموقع (Web Admins) — صلاحية كاملة للوحة ===== */
async function loadWebAdmins(){
  try{
    const data = await adminFetch("/admin/web-admins");
    const isOwner = !!data.is_owner;
    document.getElementById("webAdminsAddRow").style.display = isOwner ? "" : "none";
    document.getElementById("webAdminsTableBody").innerHTML = (data.admins || []).map(a=>{
      const permsTxt = a.owner
        ? '<span class="status-badge completed">كل الأقسام 👑</span>'
        : (a.perms === null || a.perms === undefined
            ? '<span class="status-badge completed">كاملة ✅</span>'
            : ((ed, vw)=>{
                if(!ed && !vw) return '<span class="status-badge failed">محظور كلياً 🚫</span>';
                return `<span title="تعديل: ${ed} — مشاهدة: ${vw}">✏️${ed} 👁${vw}</span>`;
              })(Object.values(a.perms).filter(l=>l==="edit").length,
                 Object.values(a.perms).filter(l=>l==="view").length));
      const permsBtn = (!a.owner && isOwner)
        ? `<button class="btn-sm" onclick="openPermsModal('${a.email.replace(/'/g,"\\'")}', this)" title="تحديد أقسام اللوحة المسموحة"><i class="fa-solid fa-key"></i> الصلاحيات</button>` : '';
      return `
      <tr>
        <td style="font-family:monospace;">${a.email}</td>
        <td>${a.owner ? '<span class="status-badge completed">المالك</span>' : '<span class="status-badge pending">أدمن</span>'}</td>
        <td>${permsTxt}</td>
        <td>${a.added_at || '—'}</td>
        <td style="display:flex; gap:6px; flex-wrap:wrap;">${permsBtn}${(a.removable && isOwner) ? `<button class="btn-sm danger" onclick="removeWebAdmin('${a.email.replace(/'/g,"\\'")}')">إزالة</button>` : (permsBtn ? '' : '—')}</td>
      </tr>`;
    }).join("");
  }catch(err){ /* silent — قد لا تكون النقطة متاحة */ }
}
/* نافذة صلاحيات أدمن (للمالك فقط): تحديد الأقسام المسموحة */
let _permsEmail = null;
async function openPermsModal(email, btn){
  _permsEmail = email;
  const box = document.getElementById("permsCheckboxes");
  box.innerHTML = `<div class="text-muted" style="font-size:11px;">جاري التحميل...</div>`;
  document.getElementById("permsModalTitle").textContent = "صلاحيات: " + email;
  document.getElementById("permsModal").style.display = "flex";
  try{
    const data = await adminFetch("/admin/web-admins");
    const adm = (data.admins || []).find(a=>a.email === email);
    const sections = data.sections || Object.keys(SECTION_TITLES);
    const current = adm && adm.perms && typeof adm.perms === "object" && !Array.isArray(adm.perms) ? adm.perms
      : (Array.isArray(adm?.perms) ? Object.fromEntries(adm.perms.map(s=>[s, "edit"])) : null);
    const lvl = (s)=> current === null ? "edit" : (current[s] || "closed");
    box.innerHTML = sections.map(s=>`
      <div style="padding:8px 10px; border-radius:9px; background:var(--card-soft);">
        <div style="font-size:12px; font-weight:800; margin-bottom:6px;">${SECTION_TITLES[s] || s}</div>
        <div style="display:flex; gap:6px; flex-wrap:wrap;">
          ${[["edit","✏️ تعديل"],["view","👁 مشاهدة"],["closed","🚫 مغلق"]].map(([v,lbl])=>`
            <label style="display:flex; align-items:center; gap:5px; font-size:11px; padding:5px 10px; border-radius:99px; border:1px solid var(--border); cursor:pointer;">
              <input type="radio" name="perm_${s}" value="${v}" ${lvl(s)===v?"checked":""}> ${lbl}
            </label>`).join("")}
        </div>
      </div>`).join("");
    const nEdit = sections.filter(s=>lvl(s)==="edit").length;
    const nView = sections.filter(s=>lvl(s)==="view").length;
    document.getElementById("permsFullHint").textContent = current === null
      ? "الحالة: صلاحية كاملة ✅ (كل الأقسام تعديل)"
      : `الحالة: ✏️${nEdit} تعديل + 👁${nView} مشاهدة + 🚫${sections.length-nEdit-nView} مغلق`;
  }catch(err){ box.innerHTML = `<div class="field-error">${err.message}</div>`; }
}
function closePermsModal(){ document.getElementById("permsModal").style.display = "none"; _permsEmail = null; }
function permsSelectAll(mode){
  // mode: edit = الكل تعديل، view = الكل مشاهدة، closed = إغلاق الكل
  document.querySelectorAll("#permsCheckboxes input[type=radio]").forEach(r=>{
    r.checked = (r.value === mode);
  });
}
async function saveAdminPerms(){
  if(!_permsEmail) return;
  const names = [...new Set(Array.from(document.querySelectorAll("#permsCheckboxes input[type=radio]")).map(r=>r.name))];
  const obj = {};
  names.forEach(n=>{
    const sel = document.querySelector(`#permsCheckboxes input[name="${n}"]:checked`);
    if(sel && sel.value !== "closed") obj[n.replace(/^perm_/, "")] = sel.value;
  });
  try{
    // الكل تعديل = صلاحية كاملة (null) — أنظف وأضمن للتوافق
    const allEdit = names.length > 0 && names.every(n=>{
      const sel = document.querySelector(`#permsCheckboxes input[name="${n}"]:checked`);
      return sel && sel.value === "edit";
    });
    const r = await adminFetch(`/admin/web-admins/${encodeURIComponent(_permsEmail)}/perms`, { method:"PUT", body: JSON.stringify({ perms: allEdit ? null : obj, email: _permsEmail }) });
    toast(r.message);
    closePermsModal();
    loadWebAdmins();
  }catch(err){ toast(err.message, "error"); }
}
async function addWebAdmin(){
  const email = (document.getElementById("newWebAdminEmail").value || "").trim().toLowerCase();
  if(!email || !email.includes("@")){ toast("أدخل بريد إلكتروني صحيح", "error"); return; }
  try{
    await adminFetch("/admin/web-admins", { method:"POST", body: JSON.stringify({ email }) });
    toast("تمت إضافة الأدمن ✅");
    document.getElementById("newWebAdminEmail").value = "";
    loadWebAdmins();
  }catch(err){ toast(err.message, "error"); }
}
async function removeWebAdmin(email){
  if(!confirm("إزالة صلاحية الأدمن عن: " + email + "؟")) return;
  try{
    await adminFetch(`/admin/web-admins/${encodeURIComponent(email)}`, { method:"DELETE" });
    toast("تمت الإزالة"); loadWebAdmins();
  }catch(err){ toast(err.message, "error"); }
}


/* ===== 3) تعديل عام (modal ديناميكي) ===== */
let editTarget = null;
function escapeHtml(s){
  return String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
/* نافذة تعديل المنتج: الاسم + الإيموجي + القسم + القسم الفرعي (للنقل بين الأقسام) */
async function openProductEdit(id){
  const p = productsCache.find(x=>x.id===id);
  if(!p){ toast("المنتج غير موجود", "error"); return; }
  editTarget = { kind:"product", id };
  document.getElementById("editModalTitle").textContent = "تعديل: " + p.name;
  const body = document.getElementById("editModalBody");
  const fld = "padding:11px;border-radius:11px;border:1px solid var(--border);background:var(--card-soft);color:var(--text);";
  const secOpts = sectionsCache.map(s=>`<option value="${escapeHtml(s.name)}" ${s.name===p.category?"selected":""}>${escapeHtml(s.name)}</option>`).join("")
    || `<option value="">لا توجد أقسام</option>`;
  body.innerHTML = `
    <div class="field"><label>الاسم</label><input type="text" id="ef_name" value="${escapeHtml(p.name)}" style="${fld}"></div>
    <div class="field"><label>الإيموجي</label><input type="text" id="ef_emoji" value="${escapeHtml(p.emoji||"")}" style="${fld}"></div>
    <div class="field"><label>القسم (النقل لقسم آخر ينقل المنتج معه)</label><select id="ef_category" onchange="loadProductEditSubs()" style="${fld}">${secOpts}</select></div>
    <div class="field"><label>القسم الفرعي</label><select id="ef_subsection_id" style="${fld}"><option value="">— بدون قسم فرعي —</option></select></div>
    <div class="field"><label>منتج أب (اختياري — لجعل هذا المنتج فرعياً بداخله)</label><select id="ef_parent_id" style="${fld}"><option value="">— بدون أب (منتج رئيسي) —</option></select></div>
    <div class="field"><label>🏷️ نص العرض (اختياري — يظهر شارة حمراء على المنتج، مثال: عرض)</label><input type="text" id="ef_offer" value="${escapeHtml(p.offer||"")}" style="${fld}"></div>
    <div class="field"><label>التوفر</label><select id="ef_active" style="${fld}"><option value="1" ${p.active!==false&&p.active!==0?"selected":""}>متوفر</option><option value="0" ${p.active===false||p.active===0?"selected":""}>غير متوفر</option></select></div>
    <div class="field"><label>ملاحظات المنتج (تظهر للزبون في صفحة المنتج)</label><textarea id="ef_notes" rows="3" placeholder="مثال: يصلك الرقم خلال دقائق في صفحة الطلب…" style="${fld}width:100%;font-family:inherit;">${escapeHtml(p.notes||"")}</textarea></div>`;
  document.getElementById("editModal").style.display = "flex";
  await loadProductEditSubs(p.subsection_id);
  loadProductEditParents(p.category, p.id, p.parent_id);
}
function loadProductEditParents(category, selfId, selected){
  const sel = document.getElementById("ef_parent_id");
  if(!sel) return;
  const tops = (typeof productsCache !== "undefined" ? productsCache : [])
    .filter(x => x.id !== selfId && (x.category || "") === (category || "") && !x.parent_id);
  sel.innerHTML = `<option value="">— بدون أب (منتج رئيسي) —</option>` +
    tops.map(x=>`<option value="${x.id}" ${x.id===(selected??null)?"selected":""}>${escapeHtml(x.name)}</option>`).join("");
}
async function loadProductEditSubs(selected){
  const catEl = document.getElementById("ef_category");
  const sel = document.getElementById("ef_subsection_id");
  if(!catEl || !sel) return;
  const sec = (typeof sectionsCache !== "undefined" ? sectionsCache : []).find(s=>s.name===catEl.value);
  sel.innerHTML = `<option value="">— بدون قسم فرعي —</option>`;
  if(!sec) return;
  try{
    const subs = await adminFetch(`/admin/sections/${sec.id}/subsections`);
    sel.innerHTML = `<option value="">— بدون قسم فرعي —</option>` + subs.map(s=>`<option value="${s.id}" ${s.id===(selected??null)?"selected":""}>${escapeHtml(s.name)}</option>`).join("");
  }catch(err){ /* يبقى خيار "بدون" فقط */ }
}
function openEdit(kind, id, title, fields){
  editTarget = { kind, id };
  document.getElementById("editModalTitle").textContent = "تعديل: " + title;
  const body = document.getElementById("editModalBody");
  const labels = { name:"الاسم", emoji:"الإيموجي", price:"السعر $", unit_qty:"السعر لكل كمية", min_qty:"الحد الأدنى للكمية", max_qty:"الحد الأقصى للكمية", stock_qty:"كمية المخزون (فارغ = غير محدود)", requires_id:"يطلب ايدي اللاعب (1 = نعم / 0 = لا)", active:"الحالة", exchange_rate:"سعر الصرف", api_token:"API Token", api_url:"API URL", description:"الوصف" };
  body.innerHTML = Object.entries(fields).map(([k,v])=>{
    if(k === "active") return `<div class="field"><label>${labels[k]||k}</label><select id="ef_${k}" style="padding:11px;border-radius:11px;border:1px solid var(--border);background:var(--card-soft);color:var(--text);"><option value="1" ${v?"selected":""}>مفعّل</option><option value="0" ${!v?"selected":""}>معطّل</option></select></div>`;
    return `<div class="field"><label>${labels[k]||k}</label><input type="${typeof v==='number'?'number':'text'}" id="ef_${k}" value="${v??''}" step="${(k.includes('price')||k.includes('rate'))?'0.01':'1'}" style="padding:11px;border-radius:11px;border:1px solid var(--border);background:var(--card-soft);color:var(--text);"></div>`;
  }).join("");
  document.getElementById("editModal").style.display = "flex";
}
async function saveEdit(){
  if(!editTarget) return;
  const { kind, id } = editTarget;
  if(kind === "product_move"){
    const category = document.getElementById("mv_category")?.value || "";
    const subVal = document.getElementById("mv_subsection_id")?.value || "";
    if(!category){ toast("اختر القسم الهدف", "error"); return; }
    try{
      const res = await adminFetch(`/admin/products/${id}/move`, { method:"POST", body: JSON.stringify({ category, subsection_id: subVal === "" ? null : Number(subVal) }) });
      toast(res.message || "تم النقل ✅"); closeEdit(); loadProducts();
    }catch(err){ toast(err.message, "error"); }
    return;
  }
  if(kind === "subsection_move"){
    const section_id = Number(document.getElementById("mv_target_section")?.value || 0);
    if(!section_id){ toast("اختر القسم الهدف", "error"); return; }
    try{
      const res = await adminFetch(`/admin/subsections/${id}/move`, { method:"POST", body: JSON.stringify({ section_id }) });
      toast(res.message || "تم النقل ✅"); closeEdit(); loadSubsections(); loadSections();
    }catch(err){ toast(err.message, "error"); }
    return;
  }
  const eps = { product:`/admin/products/${id}`, category:`/admin/categories/${id}`, section:`/admin/sections/${id}`, subsection:`/admin/subsections/${id}`, manual_method:`/admin/deposit-methods/manual/${id}`, auto_method:`/admin/deposit-methods/auto/${id}` };
  const inputs = document.querySelectorAll("#editModalBody input, #editModalBody select, #editModalBody textarea");
  const b = {};
  inputs.forEach(el=>{
    const k=el.id.replace("ef_","");
    if(k === "stock_qty"){ b[k] = el.value.trim()===""? null : Number(el.value); return; }
    b[k]=el.type==="number"?Number(el.value):el.value;
  });
  if("active" in b) b.active = b.active==="1"||b.active===1;
  try{
    const res = await adminFetch(eps[kind], { method:"PUT", body: JSON.stringify(b) });
    toast((res && res.message) || "تم التعديل ✅"); closeEdit();
    if(kind==="product" || kind==="product_move") loadProducts();
    if(kind==="category") loadCategories();
    if(kind==="section") loadSections();
    if(kind==="subsection") loadSubsections();
    if(kind.includes("method")) loadDepositMethods();
  }catch(err){ toast(err.message, "error"); }
}
function closeEdit(){ document.getElementById("editModal").style.display="none"; editTarget=null; }

/* ===== طلبات المتجر اليدوية (قبول / رفض / شحن عبر مزوّد) ===== */
async function loadShopOrders(){
  const orders = await adminFetch("/admin/shop-orders");
  const STATUS_LABEL = { pending:"بإنتظار المراجعة", accepted:"مقبول/مكتمل", rejected:"مرفوض" };
  document.getElementById("shopOrdersBody").innerHTML = orders.map(o=>`
    <tr>
      <td>#${o.id}</td>
      <td style="font-family:'Orbitron',monospace; font-size:10px; direction:ltr; cursor:pointer;" title="انقر للنسخ" onclick="navigator.clipboard?.writeText('${o.track||''}'); toast('تم نسخ رقم التتبع ✅')">${o.track||'-'}</td>
      <td>${o.user_id}</td>
      <td>${o.product_name}<br><small style="color:var(--muted)">${o.category_name}</small></td>
      <td>${o.player_id||'-'}</td>
      <td>${Math.round(o.price_syp).toLocaleString()} ل.س</td>
      <td><span class="status-badge ${o.status==='pending'?'pending':o.status==='accepted'?'completed':'failed'}">${STATUS_LABEL[o.status]||o.status}</span></td>
      <td>
        ${o.status==='pending' ? `
          <button class="btn-sm primary" onclick="acceptShopOrder(${o.id})">✅ قبول</button>
          <button class="btn-sm danger" onclick="rejectShopOrder(${o.id})">❌ رفض</button>
          <button class="btn-sm" onclick="openExecuteModal(${o.id}, '${o.product_name.replace(/'/g,'')}', '${o.player_id||''}', ${o.qty||1})"><i class="fa-solid fa-bolt"></i> شحن</button>
        ` : '—'}
      </td>
    </tr>`).join("")
  || `<tr><td colspan="8" class="text-muted" style="text-align:center; padding:16px;">لا توجد طلبات يدوية</td></tr>`;
}

async function acceptShopOrder(id){
  try{ await adminFetch(`/admin/shop-orders/${id}/accept`, { method:"POST" }); toast("تم القبول وإشعار العميل ✅"); loadShopOrders(); }
  catch(err){ toast(err.message, "error"); }
}
async function rejectShopOrder(id){
  try{ await adminFetch(`/admin/shop-orders/${id}/reject`, { method:"POST" }); toast("تم الرفض واسترجاع الرصيد"); loadShopOrders(); }
  catch(err){ toast(err.message, "error"); }
}

/* ===== Modal تنفيذ الطلب عبر مزوّد ===== */
let executeOrderId = null;
async function openExecuteModal(orderId, productName, playerId, qty){
  executeOrderId = orderId;
  document.getElementById("executeOrderInfo").textContent = `${productName} • آيدي: ${playerId} • كمية: ${qty}`;
  document.getElementById("executeApiProductId").value = "";
  document.getElementById("executeCostUsd").value = "";
  document.getElementById("executeProviderProducts").innerHTML = "";
  document.getElementById("executeModal").style.display = "flex";

  // تحميل المزودين
  const providers = await adminFetch("/admin/providers").catch(()=>[]);
  const sel = document.getElementById("executeProviderSel");
  sel.innerHTML = `<option value="">— اختر المزوّد —</option>` + providers.map(p=>`<option value="${p.id}">${p.name}</option>`).join("");
}
function closeExecuteModal(){ document.getElementById("executeModal").style.display="none"; executeOrderId=null; }

async function loadProviderProducts(){
  const pid = document.getElementById("executeProviderSel").value;
  if(!pid) return;
  const box = document.getElementById("executeProviderProducts");
  box.innerHTML = `<div style="font-size:11px; color:var(--muted); padding:8px;">⏳ جاري جلب منتجات المزوّد...</div>`;
  try{
    const prods = await adminFetch(`/admin/providers/${pid}/products`);
    if(!prods.length){ box.innerHTML = `<div style="font-size:11px; color:var(--muted); padding:8px;">لا توجد منتجات</div>`; return; }
    box.innerHTML = `<div style="font-size:10.5px; color:var(--muted); margin-bottom:6px;">اضغط على المنتج لاختياره:</div>` +
      prods.slice(0,40).map(p=>`<button class="btn-sm" style="margin:3px; font-size:10px;" onclick="document.getElementById('executeApiProductId').value='${p.id}'; if(${JSON.stringify(p.price||0)}){document.getElementById('executeCostUsd').value=${JSON.stringify(p.price||0)};} this.style.background='var(--accent)'; this.style.color='#fff';">${p.name} (${p.id})</button>`).join("");
  }catch(err){ box.innerHTML = `<div style="font-size:11px; color:var(--danger);">${err.message}</div>`; }
}

async function confirmExecute(){
  if(!executeOrderId) return;
  const provider_id = document.getElementById("executeProviderSel").value;
  const api_product_id = document.getElementById("executeApiProductId").value.trim();
  const cost_usd = Number(document.getElementById("executeCostUsd").value || 0);
  if(!provider_id || !api_product_id){ toast("اختر المزوّد وآيدي المنتج", "error"); return; }
  const btn = document.getElementById("executeConfirmBtn");
  btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
  try{
    const r = await adminFetch(`/admin/shop-orders/${executeOrderId}/execute`, { method:"POST", body: JSON.stringify({ provider_id: Number(provider_id), api_product_id, cost_usd }) });
    toast("✅ " + r.message); closeExecuteModal(); loadShopOrders();
  }catch(err){ toast(err.message, "error"); }
  btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-bolt"></i> تنفيذ الشحن الآن';
}

/* ===== ربط فئة بمزوّد API بشكل دائم (من لوحة تحكم الموقع مباشرة) ===== */
let linkCategoryId = null;
async function openLinkModal(categoryId, categoryName){
  linkCategoryId = categoryId;
  document.getElementById("linkCategoryInfo").textContent = categoryName;
  document.getElementById("linkApiProductId").value = "";
  document.getElementById("linkProviderProducts").innerHTML = "";
  document.getElementById("linkCurrentStatus").innerHTML = "";
  document.getElementById("linkTokenWarn")?.remove();
  document.getElementById("linkModal").style.display = "flex";

  const providers = await adminFetch("/admin/providers").catch(()=>[]);
  const sel = document.getElementById("linkProviderSel");
  sel.innerHTML = `<option value="">— اختر المزوّد —</option>` + providers.map(p=>`<option value="${p.id}">${p.name}${p.has_token ? "" : " ⚠️ (بلا توكن)"}</option>`).join("");
  sel._providers = providers;
  if(!sel._warnWired){
    sel._warnWired = true;
    sel.addEventListener("change", ()=>{
    const list = sel._providers || providers;
    const chosen = list.find(x=>String(x.id)===String(sel.value));
    let warn = document.getElementById("linkTokenWarn");
    if(chosen && !chosen.has_token){
      if(!warn){
        warn = document.createElement("div");
        warn.id = "linkTokenWarn";
        sel.closest(".field").appendChild(warn);
      }
      warn.innerHTML = `<div class="info-banner" style="font-size:11px; border-color:var(--danger); margin-top:8px;"><i class="fa-solid fa-triangle-exclamation" style="color:var(--danger);"></i><div>هذا المزوّد بلا توكن — احذفه وأعده بالتوكن الصحيح وإلا لن تذهب الطلبات للـ API</div></div>`;
    }else if(warn){
      warn.remove();
    }
    });
  }

  try{
    const status = await adminFetch(`/admin/categories/${categoryId}/link`);
    if(status.linked){
      document.getElementById("linkCurrentStatus").innerHTML =
        `<div class="info-banner" style="font-size:11px; border-color:var(--success);"><i class="fa-solid fa-circle-check" style="color:var(--success);"></i> مربوطة حالياً — آيدي المزوّد: <b>${status.api_product_id}</b></div>`;
      sel.value = status.provider_id;
      document.getElementById("linkApiProductId").value = status.api_product_id;
    }
  }catch(err){ /* لا يوجد ربط سابق، تجاهل */ }
}
function closeLinkModal(){ document.getElementById("linkModal").style.display="none"; linkCategoryId=null; }

async function loadLinkProviderProducts(){
  const pid = document.getElementById("linkProviderSel").value;
  if(!pid) return;
  const box = document.getElementById("linkProviderProducts");
  box.innerHTML = `<div style="font-size:11px; color:var(--muted); padding:8px;">⏳ جاري جلب منتجات المزوّد...</div>`;
  try{
    const prods = await adminFetch(`/admin/providers/${pid}/products`);
    if(!prods.length){ box.innerHTML = `<div style="font-size:11px; color:var(--muted); padding:8px;">لا توجد منتجات</div>`; return; }
    box.innerHTML = `<div style="font-size:10.5px; color:var(--muted); margin-bottom:6px;">اضغط على المنتج لاختياره:</div>` +
      prods.slice(0,40).map(p=>`<button class="btn-sm" style="margin:3px; font-size:10px;" onclick="document.getElementById('linkApiProductId').value='${p.id}'; this.style.background='var(--accent)'; this.style.color='#fff';">${p.name} (${p.id})</button>`).join("");
  }catch(err){ box.innerHTML = `<div style="font-size:11px; color:var(--danger);">${err.message}</div>`; }
}

async function confirmLink(){
  if(!linkCategoryId) return;
  const provider_id = document.getElementById("linkProviderSel").value;
  const api_product_id = document.getElementById("linkApiProductId").value.trim();
  if(!provider_id || !api_product_id){ toast("اختر المزوّد وآيدي المنتج", "error"); return; }
  const btn = document.getElementById("linkConfirmBtn");
  btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
  try{
    const r = await adminFetch(`/admin/categories/${linkCategoryId}/link`, { method:"POST", body: JSON.stringify({ provider_id: Number(provider_id), provider_product: api_product_id }) });
    toast("✅ " + r.message); closeLinkModal(); loadCategories();
  }catch(err){ toast(err.message, "error"); }
  btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-link"></i> حفظ الربط';
}

async function unlinkCurrentCategory(){
  if(!linkCategoryId) return;
  if(!confirm("متأكد من إلغاء ربط هذه الفئة بالمزوّد؟")) return;
  try{
    await adminFetch(`/admin/categories/${linkCategoryId}/link`, { method:"DELETE" });
    toast("تم إلغاء الربط"); closeLinkModal(); loadCategories();
  }catch(err){ toast(err.message, "error"); }
}


/* =========================================================
   النسخ الاحتياطي / الاسترجاع / حذف كل البيانات
   ========================================================= */
async function loadBackups(){
  const body = document.getElementById("backupsTableBody");
  if(!body) return;
  loadStorageUsage();
  try{
    const data = await adminFetch("/admin/backups");
    const token = localStorage.getItem("admin_token") || "";
    if(!data.backups.length){
      body.innerHTML = `<tr><td colspan="4">لا توجد نسخ احتياطية بعد</td></tr>`;
      return;
    }
    body.innerHTML = data.backups.map(b=>`
      <tr>
        <td style="font-family:monospace; font-size:11px;">${b.name}</td>
        <td>${b.size_kb} KB</td>
        <td>${b.created_at}</td>
        <td class="row-actions">
          <a class="btn-sm" href="${API_BASE}${b.download_url}?token=${encodeURIComponent(token)}"><i class="fa-solid fa-download"></i> تنزيل</a>
          <button class="btn-sm" onclick="restoreBackup('${b.name}', this)"><i class="fa-solid fa-rotate-left"></i> استرجاع</button>
          <button class="btn-sm danger" onclick="deleteBackup('${b.name}')"><i class="fa-solid fa-trash"></i></button>
        </td>
      </tr>`).join("");
  }catch(err){
    body.innerHTML = `<tr><td colspan="4">${err.message}</td></tr>`;
  }
}

/* حجم قاعدة البيانات المستخدم */
async function loadStorageUsage(){
  const txt = document.getElementById("storageUsageText");
  if(!txt) return;
  try{
    const s = await adminFetch("/admin/storage");
    txt.textContent = `${s.total} / ${s.limit} (${s.pct}%)`;
    const bar = document.getElementById("storageUsageBar");
    if(bar){
      bar.style.width = Math.min(100, s.pct) + "%";
      bar.style.background = s.pct > 85 ? "linear-gradient(90deg,#ff2e63,#c40f5e)"
        : s.pct > 60 ? "linear-gradient(90deg,#ffc24b,#e0a83a)"
        : "linear-gradient(90deg,#22c55e,#16a34a)";
    }
    const det = document.getElementById("storageUsageDetail");
    if(det) det.textContent = `الصور: ${s.blobs} • النسخ واللقطات: ${s.backups} • الجداول: ${s.tables}`;
  }catch(err){
    txt.textContent = "تعذّر القراءة";
  }
}

async function createBackup(btn){
  if(btn) btn.disabled = true;
  try{
    const r = await adminFetch("/admin/backups", { method:"POST" });
    toast(r.message);
    loadBackups();
  }catch(err){ toast(err.message, "error"); }
  if(btn) btn.disabled = false;
}

async function deleteBackup(name){
  if(!confirm("حذف هذه النسخة الاحتياطية؟")) return;
  try{
    const r = await adminFetch("/admin/backups/" + encodeURIComponent(name), { method:"DELETE" });
    toast(r.message);
    loadBackups();
  }catch(err){ toast(err.message, "error"); }
}

async function restoreBackup(name, btn){
  if(!confirm("سيتم استبدال كل البيانات الحالية بمحتوى هذه النسخة. متابعة؟")) return;
  if(btn) btn.disabled = true;
  const fd = new FormData();
  fd.append("name", name);
  try{
    const r = await adminFetch("/admin/restore", { method:"POST", body: fd });
    toast(r.message);
    setTimeout(()=> location.reload(), 1200);
  }catch(err){ toast(err.message, "error"); }
  if(btn) btn.disabled = false;
}

async function restoreFromUpload(btn){
  const input = document.getElementById("restoreFileInput");
  const file = input && input.files[0];
  if(!file) return toast("اختر ملف نسخة احتياطية أولاً", "error");
  if(!confirm("سيتم استبدال كل البيانات الحالية بمحتوى هذا الملف. متابعة؟")) return;
  if(btn) btn.disabled = true;
  const fd = new FormData();
  fd.append("file", file);
  try{
    const r = await adminFetch("/admin/restore", { method:"POST", body: fd });
    toast(r.message);
    setTimeout(()=> location.reload(), 1200);
  }catch(err){ toast(err.message, "error"); }
  if(btn) btn.disabled = false;
}

async function wipeAllData(btn){
  const confirmText = (document.getElementById("wipeConfirm").value || "").trim();
  const scope = document.getElementById("wipeScope").value;
  if(confirmText !== "حذف") return toast("اكتب كلمة (حذف) للتأكيد", "error");
  if(!confirm("تأكيد أخير: سيتم حذف البيانات نهائياً. متابعة؟")) return;
  if(btn) btn.disabled = true;
  try{
    const r = await adminFetch("/admin/wipe-data", { method:"POST", body: JSON.stringify({ confirm: confirmText, scope }) });
    toast(r.message);
    document.getElementById("wipeConfirm").value = "";
    loadBackups();
  }catch(err){ toast(err.message, "error"); }
  if(btn) btn.disabled = false;
}
