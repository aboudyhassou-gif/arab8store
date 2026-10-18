"""ARAB STORE backend — Flask (Vercel serverless: api/index.py).
Compatible with the existing static frontend (same design). DB: Postgres via
DATABASE_URL, else local SQLite (data/data.db). All times UTC, formatted
"YYYY-MM-DD HH:MM:SS" as the frontend expects.
"""
import os, re, json, time, csv, io, base64, hashlib, secrets, datetime, sqlite3
from functools import wraps
from flask import Flask, request, jsonify, g, send_from_directory, abort

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ON_VERCEL = bool(os.environ.get("VERCEL"))
# Vercel serverless filesystem is read-only except /tmp (ephemeral! connect
# Postgres via DATABASE_URL for persistent data in production).
DATA_DIR = os.environ.get("DATA_DIR", ("/tmp/arabstore-data" if ON_VERCEL else os.path.join(BASE_DIR, "data")))
UPLOAD_DIR = os.environ.get("UPLOAD_DIR", ("/tmp/arabstore-uploads" if ON_VERCEL else os.path.join(BASE_DIR, "uploads")))
os.makedirs(DATA_DIR, exist_ok=True)
os.makedirs(UPLOAD_DIR, exist_ok=True)
DATABASE_URL = os.environ.get("DATABASE_URL", "")
USE_PG = DATABASE_URL.startswith("postgres")

if USE_PG:
    import psycopg2
    import psycopg2.extras

NOW = lambda: datetime.datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")

# ---------------- DB layer (sqlite + postgres) ----------------
def db():
    import time as _t
    if "db" not in g:
        last = None
        for _ in range(2):
            try:
                if USE_PG:
                    g.db = psycopg2.connect(DATABASE_URL, connect_timeout=10)
                else:
                    g.db = sqlite3.connect(os.path.join(DATA_DIR, "data.db"))
                    g.db.row_factory = sqlite3.Row
                last = None
                break
            except Exception as ex:
                last = ex
                _t.sleep(1)
        if "db" not in g:
            raise last
    return g.db

def q(sql, args=(), one=False, commit=False):
    """SELECT helper returning list of dicts. Use %s (pg) or ? (sqlite) via PH."""
    con = db()
    if USE_PG:
        cur = con.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute(sql, args)
        rows = cur.fetchall()
        out = [dict(r) for r in rows]
    else:
        cur = con.execute(sql, args)
        out = [dict(r) for r in cur.fetchall()]
    if commit:
        con.commit()
    if one:
        return out[0] if out else None
    return out

# tables with an auto-increment integer PK named id (need RETURNING id on Postgres)
ID_TABLES = {"users", "sections", "subsections", "products", "skus", "orders", "deposits",
             "dep_manual", "dep_auto", "providers", "tiers", "banners", "notifs", "admin_notifs",
             "activity", "ai_memory", "logs"}

def w(sql, args=()):
    """Write helper. Returns lastrowid (or None for tables without SERIAL id)."""
    con = db()
    if USE_PG:
        m = re.match(r"\s*INSERT\s+INTO\s+(\w+)", sql, re.I)
        if m and m.group(1).lower() in ID_TABLES and "RETURNING" not in sql.upper():
            sql = sql + " RETURNING id"
        cur = con.cursor()
        cur.execute(sql, args)
        lid = None
        try:
            r = cur.fetchone()
            lid = r[0] if r else None
        except Exception:
            lid = None
        con.commit()
        return lid
    else:
        cur = con.execute(sql, args)
        con.commit()
        return cur.lastrowid

PH = "%s" if USE_PG else "?"
def ph(n):
    return ",".join([PH] * n)

SCHEMA_SQLITE = """
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT,email TEXT UNIQUE,phone TEXT,country TEXT,pw TEXT,balance_usd REAL DEFAULT 0,preferred_currency TEXT DEFAULT 'USD',discount_tier_id INTEGER,blocked INTEGER DEFAULT 0,api_enabled INTEGER DEFAULT 0,api_key TEXT,allowed_ips TEXT DEFAULT '',created_at TEXT);
CREATE TABLE IF NOT EXISTS admin_tokens(token TEXT PRIMARY KEY,created_at TEXT);
CREATE TABLE IF NOT EXISTS web_admins(email TEXT PRIMARY KEY,perms TEXT,added_at TEXT);
CREATE TABLE IF NOT EXISTS tg_admins(user_id TEXT PRIMARY KEY,main INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS sections(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT,emoji TEXT,image TEXT,active INTEGER DEFAULT 1,sort_order INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS subsections(id INTEGER PRIMARY KEY AUTOINCREMENT,section_id INTEGER,name TEXT,emoji TEXT,image TEXT,active INTEGER DEFAULT 1,sort_order INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS products(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT,category TEXT,emoji TEXT,image TEXT,notes TEXT,subsection_id INTEGER,sort_order INTEGER DEFAULT 0,parent_id INTEGER,active INTEGER DEFAULT 1,offer TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS skus(id INTEGER PRIMARY KEY AUTOINCREMENT,product_id INTEGER,name TEXT,price_usd REAL,public_id TEXT,type TEXT DEFAULT 'default',unit_qty INTEGER DEFAULT 1,min_qty INTEGER DEFAULT 1,max_qty INTEGER DEFAULT 0,stock_qty INTEGER,requires_id INTEGER DEFAULT 1,provider_id INTEGER,api_product_id TEXT,cost_usd REAL DEFAULT 0,margin_percent REAL DEFAULT 0,image TEXT,available INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS orders(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER,sku_id INTEGER,product_name TEXT,category_name TEXT,player_id TEXT,qty INTEGER DEFAULT 1,currency TEXT DEFAULT 'USD',price_usd REAL,price_syp REAL,cost_usd REAL DEFAULT 0,status TEXT DEFAULT 'pending',source TEXT DEFAULT 'manual',track TEXT,ext_order_id TEXT,uuid TEXT,raw_status TEXT,response_time_text TEXT,replies TEXT,created_at TEXT);
CREATE TABLE IF NOT EXISTS deposits(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER,method_title TEXT,method_id INTEGER,kind TEXT,amount_usd REAL,amount_syp REAL,code TEXT,status TEXT DEFAULT 'pending',created_at TEXT);
CREATE TABLE IF NOT EXISTS dep_manual(id INTEGER PRIMARY KEY AUTOINCREMENT,title TEXT,code TEXT,description TEXT,image TEXT,input_currency TEXT DEFAULT 'usd');
CREATE TABLE IF NOT EXISTS dep_auto(id INTEGER PRIMARY KEY AUTOINCREMENT,title TEXT,description TEXT,api_token TEXT,api_url TEXT,gateway_type TEXT,input_currency TEXT DEFAULT 'usd',image TEXT);
CREATE TABLE IF NOT EXISTS providers(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT,token TEXT,url TEXT,order_path TEXT,status_path TEXT,catalog_path TEXT,balance_path TEXT,balance_manual TEXT,balance_cached_at TEXT,api_mode TEXT DEFAULT 'auto');
CREATE TABLE IF NOT EXISTS tiers(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT,percent REAL DEFAULT 0,min_spent REAL DEFAULT 0,sort_order INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS tier_matrix(tier_id INTEGER,section TEXT,percent REAL,PRIMARY KEY(tier_id,section));
CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY,v TEXT);
CREATE TABLE IF NOT EXISTS banners(id INTEGER PRIMARY KEY AUTOINCREMENT,image TEXT);
CREATE TABLE IF NOT EXISTS notifs(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER,title TEXT,message TEXT,kind TEXT DEFAULT 'info',created_at TEXT,is_read INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS admin_notifs(id INTEGER PRIMARY KEY AUTOINCREMENT,title TEXT,message TEXT,created_at TEXT,is_read INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS push_subs(endpoint TEXT PRIMARY KEY,user_id INTEGER,keys_json TEXT,is_admin INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS activity(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER,kind TEXT,status TEXT,title TEXT,detail TEXT,source TEXT,amount_syp REAL,ref TEXT,created_at TEXT);
CREATE TABLE IF NOT EXISTS ai_memory(id INTEGER PRIMARY KEY AUTOINCREMENT,question TEXT,reply TEXT,created_at TEXT);
CREATE TABLE IF NOT EXISTS logs(id INTEGER PRIMARY KEY AUTOINCREMENT,created_at TEXT,actor TEXT,action TEXT,target TEXT,detail TEXT);
CREATE TABLE IF NOT EXISTS snapshots(id TEXT PRIMARY KEY,reason TEXT,created_at TEXT,size_kb REAL,data_json TEXT);
CREATE TABLE IF NOT EXISTS backups(name TEXT PRIMARY KEY,size_kb REAL,created_at TEXT,data_json TEXT);
CREATE TABLE IF NOT EXISTS batches(batch_id TEXT PRIMARY KEY,created_at TEXT);
CREATE TABLE IF NOT EXISTS reset_codes(email TEXT PRIMARY KEY,code TEXT,created_at TEXT);
CREATE TABLE IF NOT EXISTS blob_files(name TEXT PRIMARY KEY,data TEXT,mime TEXT);
CREATE TABLE IF NOT EXISTS wa_kv(k TEXT PRIMARY KEY,v TEXT,updated_at TEXT);
CREATE TABLE IF NOT EXISTS wa_messages(id INTEGER PRIMARY KEY AUTOINCREMENT,direction TEXT,number TEXT,name TEXT,body TEXT,reply TEXT,created_at TEXT);
CREATE TABLE IF NOT EXISTS wa_humans(number TEXT PRIMARY KEY,name TEXT,first_msg TEXT,created_at TEXT,done INTEGER DEFAULT 0);
"""
SCHEMA_PG = SCHEMA_SQLITE.replace("AUTOINCREMENT", "").replace(
    "INTEGER PRIMARY KEY", "SERIAL PRIMARY KEY")

_inited = False
def init_db(app):
    global _inited
    if _inited:
        return
    with app.app_context():
        con = db()
        schema = SCHEMA_PG if USE_PG else SCHEMA_SQLITE
        if USE_PG:
            cur = con.cursor()
            for stmt in [s.strip() for s in schema.split(";") if s.strip()]:
                cur.execute(stmt)
            con.commit()
        else:
            con.executescript(schema)
            con.commit()
        for _ddl, _pg in [("ALTER TABLE providers ADD COLUMN api_mode TEXT DEFAULT 'auto'",
                             "ALTER TABLE providers ADD COLUMN IF NOT EXISTS api_mode TEXT DEFAULT 'auto'"),
                            ("ALTER TABLE products ADD COLUMN parent_id INTEGER",
                             "ALTER TABLE products ADD COLUMN IF NOT EXISTS parent_id INTEGER"),
                            ("ALTER TABLE products ADD COLUMN active INTEGER DEFAULT 1",
                             "ALTER TABLE products ADD COLUMN IF NOT EXISTS active INTEGER DEFAULT 1"),
                            ("ALTER TABLE products ADD COLUMN offer TEXT DEFAULT ''",
                             "ALTER TABLE products ADD COLUMN IF NOT EXISTS offer TEXT DEFAULT ''")]:
            try:
                if USE_PG:
                    cur = con.cursor()
                    cur.execute(_pg)
                    con.commit()
                else:
                    con.execute(_ddl)
                    con.commit()
            except Exception:
                pass
        if not q("SELECT v FROM settings WHERE k='seeded'", one=True):
            seed()
        _boot = os.environ.get("ADMIN_PASSWORD", "")
        if _boot:
            try:
                if not get_setting("admin_password_hash", ""):
                    set_setting("admin_password_hash", sha_pw(_boot))
            except Exception:
                pass
    _inited = True

DEFAULT_SETTINGS = {
    "exchange_rate": "140",
    "store_name": "ARAB STORE",
    "welcome_message": "أهلاً بك في ARAB STORE ✨",
    "welcome_popup_enabled": "false",
    "welcome_popup_text": "",
    "support_username": "aboudy2312",
    "support_telegram": "https://t.me/aboudy2312",
    "support_whatsapp": "",
    "contact": '{"telegram_url":"https://t.me/aboudy2312","whatsapp_url":"","whatsapp_channel_url":"","telegram_channel_url":"","whatsapp_number":""}',
    "logo_image": "",
    "dev_logo": "",
    "app_icon": "",
    "notif_icon": "",
    "banner_images": "[]",
    "admin_password_hash": "",
    "ai_agent_enabled": "false",
    "ai_agent_name": "مساعد ARAB",
    "ai_agent_api_url": "",
    "ai_agent_api_key": "",
    "ai_agent_model": "",
    "ai_agent_prompt": "",
    "ai_agent_welcome": "أهلاً فيك! أنا مساعد المتجر 🤖 اسألني عن أي منتج أو سعر أو طريقة شحن.",
    "wa_enabled": "false",
    "wa_bot_enabled": "true",
    "wa_phone": "",
    "wa_bot_name": "مساعد المتجر",
    "wa_store_url": "",
    "wa_greeting": "أهلاً وسهلاً 👋 كيف بقدر ساعدك اليوم؟ اكتب اسم اللعبة أو الخدمة اللي بدك ياها.",
    "wa_append_link": "true",
    "wa_reply_unknown": "",
    "wa_secret": "",
    "wa_status": '{"linked":false,"code":"","qr":"","me":"","platform":"","since":"","updated":"","error":""}',
    "wa_pair_req": '{"requested":false,"phone":"","at":""}',
    "ai_image_api_url": "",
    "ai_image_api_key": "",
    "ai_image_prompt_template": "",
    "ai_image_api_type": "",
    "ai_image_model": "",
    "ai_image_prompt_product": "",
    "ai_image_prompt_section": "",
    "admin_notify_chat_ids": "",
    "auto_tier_enabled": "false",
    "maintenance": '{"enabled":false,"seconds_left":0,"reason":"","note":""}',
    "vapid_public": "",
    "seeded": "1",
}

def seed():
    for k, v in DEFAULT_SETTINGS.items():
        if not q(f"SELECT v FROM settings WHERE k={PH}", (k,), one=True):
            w(f"INSERT INTO settings(k,v) VALUES({PH},{PH})", (k, v))

def get_setting(k, default=""):
    r = q(f"SELECT v FROM settings WHERE k={PH}", (k,), one=True)
    return r["v"] if r and r.get("v") is not None else default

def set_setting(k, v):
    if v is None:
        v = ""
    if not isinstance(v, str):
        v = json.dumps(v, ensure_ascii=False)
    if q(f"SELECT v FROM settings WHERE k={PH}", (k,), one=True):
        w(f"UPDATE settings SET v={PH} WHERE k={PH}", (v, k))
    else:
        w(f"INSERT INTO settings(k,v) VALUES({PH},{PH})", (k, v))

def jget(k, default=None):
    try:
        return json.loads(get_setting(k, ""))
    except Exception:
        return default

# ---------------- helpers ----------------
def err(msg, code=400):
    return jsonify({"message": msg}), code

def sha_pw(pw):
    return hashlib.sha256(("arabstore::" + pw).encode()).hexdigest()

def verify_pw(stored, cand):
    """Supports legacy Werkzeug hashes (old store) with transparent upgrade to sha256."""
    cand = cand or ""
    try:
        if stored and ("$" in stored or stored.startswith(("scrypt:", "pbkdf2:"))):
            from werkzeug.security import check_password_hash
            return check_password_hash(stored, cand)
    except Exception:
        pass
    return stored == sha_pw(cand)

def new_token(prefix=""):
    return prefix + secrets.token_hex(24)

def log(actor, action, target="", detail=""):
    try:
        w(f"INSERT INTO logs(created_at,actor,action,target,detail) VALUES({PH},{PH},{PH},{PH},{PH})",
          (NOW(), actor, action, target, detail))
    except Exception:
        pass

def notify_user(user_id, title, message, kind="info"):
    try:
        w(f"INSERT INTO notifs(user_id,title,message,kind,created_at) VALUES({PH},{PH},{PH},{PH},{PH})",
          (user_id, title, message, kind, NOW()))
    except Exception:
        pass

def notify_admin(title, message):
    try:
        w(f"INSERT INTO admin_notifs(title,message,created_at) VALUES({PH},{PH},{PH})",
          (title, message, NOW()))
    except Exception:
        pass

def add_activity(user_id, kind, status, title, detail="", source="", amount_syp=None, ref=""):
    try:
        w(f"INSERT INTO activity(user_id,kind,status,title,detail,source,amount_syp,ref,created_at) VALUES({PH},{PH},{PH},{PH},{PH},{PH},{PH},{PH},{PH})",
          (user_id, kind, status, title, detail, source, amount_syp, ref, NOW()))
    except Exception:
        pass

def bearer():
    h = request.headers.get("Authorization", "")
    if h.startswith("Bearer "):
        return h[7:].strip()
    return request.args.get("token", "") or ""

def current_user():
    t = bearer()
    if not t:
        return None
    return _token_user(t)

_tok_cache = {}
def _token_user(t):
    # login tokens kept in memory + persisted in settings so restarts keep working
    mp = jget("login_tokens", {}) or {}
    uid = mp.get(t)
    if not uid:
        return None
    return q(f"SELECT * FROM users WHERE id={PH}", (uid,), one=True)

def save_login_token(t, uid):
    mp = jget("login_tokens", {}) or {}
    mp[t] = uid
    set_setting("login_tokens", mp)

def drop_login_token(t):
    mp = jget("login_tokens", {}) or {}
    if t in mp:
        del mp[t]
        set_setting("login_tokens", mp)

def user_public(u):
    if not u:
        return None
    tier = q(f"SELECT * FROM tiers WHERE id={PH}", (u.get("discount_tier_id") or 0,), one=True)
    return {
        "id": u["id"], "name": u.get("name"), "email": u.get("email"),
        "phone": u.get("phone"), "country": u.get("country"),
        "balance_usd": round(float(u.get("balance_usd") or 0), 2),
        "balance": round(float(u.get("balance_usd") or 0), 2),
        "preferred_currency": u.get("preferred_currency") or "USD",
        "discount_tier_id": u.get("discount_tier_id"),
        "discount_tier_name": tier["name"] if tier else None,
        "discount_percent": float(tier["percent"]) if tier else 0,
        "is_admin": bool(is_web_admin(u.get("email"))),
        "api_enabled": bool(u.get("api_enabled")),
        "blocked": bool(u.get("blocked")),
    }

def require_user():
    u = current_user()
    if not u:
        return None, (jsonify({"message": "سجل دخولك أولاً"}), 401)
    if u.get("blocked"):
        return None, (jsonify({"message": "تم حظر حسابك"}), 403)
    return u, None

def is_admin_token(t):
    if not t:
        return False
    return bool(q(f"SELECT token FROM admin_tokens WHERE token={PH}", (t,), one=True))

def require_admin():
    t = bearer()
    if not is_admin_token(t):
        return None, (jsonify({"message": "صلاحيات الأدمن مطلوبة"}), 401)
    return t, None

def is_web_admin(email):
    if not email:
        return False
    return bool(q(f"SELECT email FROM web_admins WHERE email={PH}", (email.lower(),), one=True))

def admin_perms(email):
    r = q(f"SELECT perms FROM web_admins WHERE email={PH}", ((email or "").lower(),), one=True)
    if not r:
        return None  # full access (owner / password login)
    try:
        return json.loads(r["perms"]) if r["perms"] else None
    except Exception:
        return None

def rate():
    try:
        return float(get_setting("exchange_rate", "140") or 140)
    except Exception:
        return 140.0

def usd_to_syp(usd):
    return round(float(usd or 0) * rate(), 2)

def effective_price(sku, user=None):
    """Discounted price_usd for a user (tier + section matrix)."""
    base = float(sku.get("price_usd") or 0)
    disc = 0.0
    if user and user.get("discount_tier_id"):
        t = q(f"SELECT percent FROM tiers WHERE id={PH}", (user["discount_tier_id"],), one=True)
        if t:
            disc = float(t.get("percent") or 0)
        prod = q(f"SELECT category FROM products WHERE id={PH}", (sku.get("product_id"),), one=True)
        if prod and prod.get("category"):
            m = q(f"SELECT percent FROM tier_matrix WHERE tier_id={PH} AND section={PH}",
                  (user["discount_tier_id"], prod["category"]), one=True)
            if m and m.get("percent") is not None:
                disc = float(m["percent"])
    return round(base * (1 - disc / 100), 2), disc

def product_availability_map(pids):
    """Bulk availability: {pid: True/False}. Unavailable = admin-disabled OR (has SKUs but none available)."""
    out = {}
    if not pids:
        return out
    act = {r["id"]: r.get("active") for r in
           q(f"SELECT id,active FROM products WHERE id IN ({','.join([PH] * len(pids))})", tuple(pids))}
    agg = {r["pid"]: (r.get("n") or 0, r.get("ok") or 0) for r in
           q(f"SELECT product_id AS pid,COUNT(*) AS n,SUM(CASE WHEN available=1 AND price_usd IS NOT NULL AND price_usd>=0 THEN 1 ELSE 0 END) AS ok FROM skus WHERE product_id IN ({','.join([PH] * len(pids))}) GROUP BY product_id", tuple(pids))}
    for pid in pids:
        if act.get(pid) == 0:
            out[pid] = False
            continue
        n, ok = agg.get(pid, (0, 0))
        out[pid] = True if n == 0 else bool(ok)
    return out

def auto_tier(user_id):
    if get_setting("auto_tier_enabled", "false") != "true":
        return
    spent = q(f"SELECT COALESCE(SUM(price_usd),0) AS s FROM orders WHERE user_id={PH} AND status IN ('accepted','completed')",
              (user_id,), one=True)
    total = float((spent or {}).get("s") or 0)
    tiers = q("SELECT * FROM tiers ORDER BY min_spent DESC")
    for t in tiers:
        if total >= float(t.get("min_spent") or 0):
            w(f"UPDATE users SET discount_tier_id={PH} WHERE id={PH}", (t["id"], user_id))
            break

def store_logo_bytes():
    """Raw bytes of the store's uploaded main logo (settings logo_image), or None."""
    logo_url = get_setting("logo_image", "")
    if not logo_url:
        return None
    try:
        if logo_url.startswith("/uploads/"):
            row = q(f"SELECT data FROM blob_files WHERE name={PH}", (logo_url.rsplit("/", 1)[-1],), one=True)
            if row and row.get("data"):
                import base64 as _b64
                return _b64.b64decode(row["data"])
            p = os.path.join(BASE_DIR, logo_url.lstrip("/"))
            if os.path.isfile(p):
                return open(p, "rb").read()
            return None
        import urllib.request as _url
        req = _url.Request(logo_url, headers={"User-Agent": "ARAB-STORE/1.0"})
        with _url.urlopen(req, timeout=20) as r2:
            return r2.read()
    except Exception:
        return None

def composite_store_logo(img_bytes):
    """Paste unified store logo top-left. Returns PNG bytes or None."""
    try:
        from PIL import Image
        import io as _io
        lb = store_logo_bytes()
        if not lb:
            return None
        base = Image.open(_io.BytesIO(img_bytes)).convert("RGBA")
        logo = Image.open(_io.BytesIO(lb)).convert("RGBA")
        W, _H = base.size
        tw = max(80, W // 5)
        logo = logo.resize((tw, max(1, int(logo.height * tw / logo.width))), Image.LANCZOS)
        pad = max(14, W // 50)
        layer = Image.new("RGBA", base.size, (0, 0, 0, 0))
        layer.alpha_composite(logo, (pad, pad))
        base = Image.alpha_composite(base, layer)
        out = _io.BytesIO()
        base.save(out, "PNG")
        return out.getvalue()
    except Exception:
        return None

def create_app():
    app = Flask(__name__)

    @app.teardown_appcontext
    def close(exc):
        con = g.pop("db", None)
        if con is not None:
            try:
                con.close()
            except Exception:
                pass

    @app.get("/health")
    def health():
        return jsonify({"ok": True, "storage": "persistent-postgres" if USE_PG else "sqlite-local"})

    @app.errorhandler(ValueError)
    def _value_err(ex):
        return jsonify({"message": str(ex) or "طلب غير صالح"}), 400

    @app.get("/site-icon")
    def site_icon():
        icon = get_setting("app_icon", "")
        if icon and icon.startswith("/uploads/"):
            return send_from_directory(BASE_DIR, icon.lstrip("/"))
        return ("", 404)

    @app.get("/api/diag")
    def diag():
        want = ["index.html", "store.html", "products.html", "product.html", "orders.html", "wallet.html",
                "deposit.html", "account.html", "admin.html", "login.html", "register.html", "css/style.css",
                "js/app.js", "js/admin-data.js"]
        return jsonify({"ok": True, "base": BASE_DIR,
                        "files": {f: os.path.isfile(os.path.join(BASE_DIR, f)) for f in want}})

    @app.get("/uploads/<path:name>")
    def uploads(name):
        key = name.split("/")[-1]
        row = q(f"SELECT data,mime FROM blob_files WHERE name={PH}", (key,), one=True)
        if row and row.get("data"):
            resp = app.response_class(base64.b64decode(row["data"]), mimetype=row.get("mime") or "image/png")
            resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
            return resp
        if os.path.isfile(os.path.join(UPLOAD_DIR, name)):
            resp = send_from_directory(UPLOAD_DIR, name)
            resp.headers["Cache-Control"] = "public, max-age=86400"
            return resp
        resp = send_from_directory(os.path.join(BASE_DIR, "uploads"), name)
        resp.headers["Cache-Control"] = "public, max-age=86400"
        return resp

    # Static frontend (same design). Explicit /api routes above always win
    # over this catch-all because Werkzeug prefers more specific rules.
    @app.get("/", defaults={"filename": "index.html"})
    @app.get("/<path:filename>")
    def static_files(filename):
        if filename.startswith("api/"):
            abort(404)
        disk = os.path.join(BASE_DIR, filename)
        if os.path.isdir(disk):
            filename = filename.rstrip("/") + "/index.html"
            disk = os.path.join(BASE_DIR, filename)
        if os.path.isfile(disk):
            resp = send_from_directory(BASE_DIR, filename)
            if filename.endswith((".html",)):
                resp.headers["Cache-Control"] = "no-cache"
            return resp
        abort(404)

    # ============ AUTH ============
    @app.post("/api/auth/register")
    def register():
        d = request.get_json(force=True, silent=True) or {}
        name = (d.get("name") or "").strip()
        email = (d.get("email") or "").strip().lower()
        pw = d.get("password") or ""
        if not name or not email or len(pw) < 6:
            return err("تحقق من البيانات (الاسم والإيميل وكلمة سر 6 أحرف على الأقل)")
        if q(f"SELECT id FROM users WHERE email={PH}", (email,), one=True):
            return err("هذا الإيميل مسجل من قبل")
        uid = w(f"INSERT INTO users(name,email,phone,country,pw,created_at) VALUES({PH},{PH},{PH},{PH},{PH},{PH})",
                (name, email, (d.get("phone") or "").strip(), (d.get("country") or "").strip(), sha_pw(pw), NOW()))
        u = q(f"SELECT * FROM users WHERE id={PH}", (uid,), one=True)
        tok = new_token()
        save_login_token(tok, uid)
        log(email, "register", "", name)
        add_activity(uid, "balance", "info", "تم إنشاء الحساب", "أهلاً بك في ARAB STORE", "site")
        return jsonify({"token": tok, "user": user_public(u)})

    @app.post("/api/auth/login")
    def login():
        d = request.get_json(force=True, silent=True) or {}
        email = (d.get("email") or "").strip().lower()
        u = q(f"SELECT * FROM users WHERE email={PH}", (email,), one=True)
        if not u or not verify_pw(u.get("pw"), d.get("password")):
            return err("بيانات الدخول غير صحيحة", 401)
        if u.get("blocked"):
            return err("تم حظر حسابك، تواصل مع الدعم", 403)
        if u.get("pw", "").startswith(("scrypt:", "pbkdf2:")):
            w(f"UPDATE users SET pw={PH} WHERE id={PH}", (sha_pw(d.get("password") or ""), u["id"]))
        tok = new_token()
        save_login_token(tok, u["id"])
        log(email, "login", "", "")
        return jsonify({"token": tok, "user": user_public(u)})

    @app.post("/api/auth/forgot-password")
    def forgot():
        d = request.get_json(force=True, silent=True) or {}
        email = (d.get("email") or "").strip().lower()
        if q(f"SELECT id FROM users WHERE email={PH}", (email,), one=True):
            code = "%06d" % (secrets.randbelow(900000) + 100000)
            if q(f"SELECT email FROM reset_codes WHERE email={PH}", (email,), one=True):
                w(f"UPDATE reset_codes SET code={PH},created_at={PH} WHERE email={PH}", (code, NOW(), email))
            else:
                w(f"INSERT INTO reset_codes(email,code,created_at) VALUES({PH},{PH},{PH})", (email, code, NOW()))
            notify_admin("طلب استعادة كلمة سر", f"{email} : الكود {code}")
        return jsonify({"message": "إذا كان الإيميل مسجلاً ستصلك التعليمات"})

    @app.post("/api/auth/reset-password")
    def resetpw():
        d = request.get_json(force=True, silent=True) or {}
        code = (d.get("code") or "").strip()
        r = q(f"SELECT * FROM reset_codes WHERE code={PH}", (code,), one=True)
        if not r:
            return err("الكود غير صحيح")
        if len(d.get("new_password") or "") < 6:
            return err("كلمة السر 6 أحرف على الأقل")
        w(f"UPDATE users SET pw={PH} WHERE email={PH}", (sha_pw(d["new_password"]), r["email"]))
        w(f"DELETE FROM reset_codes WHERE email={PH}", (r["email"],))
        return jsonify({"message": "تم تغيير كلمة السر"})

    @app.get("/api/auth/me")
    def me():
        u, e = require_user()
        if e:
            return e
        return jsonify({"user": user_public(u)})

    @app.post("/api/auth/currency")
    def currency():
        u, e = require_user()
        if e:
            return e
        d = request.get_json(force=True, silent=True) or {}
        if (d.get("currency") or "").upper() in ("USD", "SYP"):
            w(f"UPDATE users SET preferred_currency={PH} WHERE id={PH}", (d["currency"].upper(), u["id"]))
        return jsonify({"message": "ok"})

    @app.post("/api/auth/update-profile")
    def update_profile():
        u, e = require_user()
        if e:
            return e
        d = request.get_json(force=True, silent=True) or {}
        name = (d.get("name") or "").strip()
        email = (d.get("email") or "").strip().lower()
        if not name or not email:
            return err("الاسم والإيميل مطلوبان")
        if email != u["email"] and q(f"SELECT id FROM users WHERE email={PH}", (email,), one=True):
            return err("الإيميل مستخدم من قبل")
        w(f"UPDATE users SET name={PH},email={PH} WHERE id={PH}", (name, email, u["id"]))
        return jsonify({"message": "تم الحفظ"})

    @app.post("/api/auth/change-password")
    def change_pw():
        u, e = require_user()
        if e:
            return e
        d = request.get_json(force=True, silent=True) or {}
        if not verify_pw(u.get("pw"), d.get("old_password")):
            return err("كلمة السر الحالية غير صحيحة")
        if len(d.get("new_password") or "") < 6:
            return err("كلمة السر الجديدة 6 أحرف على الأقل")
        w(f"UPDATE users SET pw={PH} WHERE id={PH}", (sha_pw(d["new_password"]), u["id"]))
        return jsonify({"message": "تم التغيير"})

    @app.post("/api/auth/admin-auto-login")
    def admin_auto():
        u, e = require_user()
        if e:
            return e
        if not is_web_admin(u.get("email")):
            return err("لا تملك صلاحية الأدمن", 403)
        tok = new_token("adm_")
        w(f"INSERT INTO admin_tokens(token,created_at) VALUES({PH},{PH})", (tok, NOW()))
        log(u["email"], "admin-auto-login", "", "")
        return jsonify({"token": tok})

    # ============ STORE (public) ============
    @app.get("/api/store/settings")
    def store_settings():
        try:
            banners = q("SELECT id,image FROM banners ORDER BY id")
        except Exception:
            banners = []
        contact = jget("contact", {}) or {}
        return jsonify({
            "store_name": get_setting("store_name", "ARAB STORE"),
            "exchange_rate": rate(),
            "logo_image": get_setting("logo_image", ""),
            "dev_logo": get_setting("dev_logo", ""),
            "banner_images": [b["image"] for b in banners],
            "welcome_popup_enabled": get_setting("welcome_popup_enabled", "false").strip().lower() == "true",
            "welcome_popup_text": get_setting("welcome_popup_text", ""),
            "welcome_message": get_setting("welcome_message", ""),
            "support_username": get_setting("support_username", ""),
            "support_telegram": get_setting("support_telegram", ""),
            "support_whatsapp": get_setting("support_whatsapp", ""),
            "contact": contact,
            "ai_image_api_key": get_setting("ai_image_api_key", ""),
            "ai_image_api_url": get_setting("ai_image_api_url", ""),
            "ai_image_prompt_template": get_setting("ai_image_prompt_template", ""),
        })

    @app.get("/api/store/sections")
    def store_sections():
        rows = q(f"SELECT * FROM sections WHERE active=1 ORDER BY sort_order,id")
        return jsonify([{"id": r["id"], "name": r["name"], "emoji": r.get("emoji") or "", "image": r.get("image") or ""} for r in rows])

    @app.get("/api/store/subsections")
    def store_subs():
        sid = request.args.get("section_id")
        if not sid:
            return err("section_id مطلوب")
        rows = q(f"SELECT * FROM subsections WHERE section_id={PH} AND active=1 ORDER BY sort_order,id", (sid,))
        return jsonify([{"id": r["id"], "name": r["name"], "emoji": r.get("emoji") or "", "image": r.get("image") or ""} for r in rows])

    @app.get("/api/store/products")
    def store_products():
        u = current_user()
        sub = request.args.get("subsection_id")
        sec = request.args.get("section")
        par = request.args.get("parent_id")
        if par:
            rows = q(f"SELECT * FROM products WHERE parent_id={PH} ORDER BY sort_order,id", (par,))
        elif sub:
            rows = q(f"SELECT * FROM products WHERE subsection_id={PH} ORDER BY sort_order,id", (sub,))
        elif sec:
            rows = q(f"SELECT * FROM products WHERE category={PH} AND (subsection_id IS NULL) AND (parent_id IS NULL) ORDER BY sort_order,id", (sec,))
        else:
            return err("section أو subsection_id أو parent_id مطلوب")
        out = []
        avail = product_availability_map([r["id"] for r in rows])
        for r in rows:
            out.append({"id": r["id"], "name": r["name"], "emoji": r.get("emoji") or "", "image": r.get("image") or "",
                        "available": avail.get(r["id"], True), "offer": r.get("offer") or ""})
        return jsonify(out)

    @app.get("/api/store/product/<int:pid>")
    def store_product(pid):
        r = q(f"SELECT * FROM products WHERE id={PH}", (pid,), one=True)
        if not r:
            return err("المنتج غير موجود", 404)
        kids = q(f"SELECT id,name,emoji,image FROM products WHERE parent_id={PH} ORDER BY sort_order,id", (pid,))
        avail = product_availability_map([pid] + [k["id"] for k in kids])
        return jsonify({"id": r["id"], "name": r["name"], "category": r.get("category") or "",
                        "emoji": r.get("emoji") or "", "image": r.get("image") or "", "notes": r.get("notes") or "",
                        "parent_id": r.get("parent_id"),
                        "available": avail.get(pid, True), "offer": r.get("offer") or "",
                        "has_children": bool(kids),
                        "children": [{"id": k["id"], "name": k["name"], "emoji": k.get("emoji") or "",
                                      "image": k.get("image") or "", "available": avail.get(k["id"], True)} for k in kids]})

    @app.get("/api/store/categories")
    def store_skus():
        u = current_user()
        pid = request.args.get("product_id")
        if not pid:
            return err("product_id مطلوب")
        rows = q(f"SELECT * FROM skus WHERE product_id={PH} ORDER BY price_usd,id", (pid,))
        out = []
        for s in rows:
            price, _ = effective_price(s, u)
            avail = bool(s.get("available")) and s.get("price_usd") is not None and float(s.get("price_usd") or 0) >= 0
            out.append({"id": s["id"], "public_id": s.get("public_id") or str(s["id"]), "name": s["name"],
                        "price_usd": price, "available": avail, "image": s.get("image") or "",
                        "min_qty": s.get("min_qty") or 1, "max_qty": s.get("max_qty") or 0,
                        "requires_id": False if s.get("requires_id") == 0 else True,
                        "unit_qty": s.get("unit_qty") or 1})
        return jsonify(out)

    @app.get("/api/store/check-player")
    def check_player():
        sku_id = request.args.get("sku_id")
        player_id = (request.args.get("player_id") or "").strip()
        if not sku_id or not player_id:
            return err("البيانات ناقصة")
        s = q(f"SELECT * FROM skus WHERE id={PH}", (sku_id,), one=True)
        if not s:
            return err("الباقة غير موجودة", 404)
        if not s.get("provider_id"):
            return jsonify({"supported": False, "message": "التحقق غير متوفر لهذا المنتج — تأكد من الآيدي قبل الطلب"})
        prov = q(f"SELECT * FROM providers WHERE id={PH}", (s["provider_id"],), one=True)
        if not prov:
            return jsonify({"supported": False, "message": "التحقق غير متوفر لهذا المنتج — تأكد من الآيدي قبل الطلب"})
        info, msg = provider_call(prov, "verify", {"player_id": player_id, "api_product": s.get("api_product_id"),
                                                   "product": s.get("api_product_id")})
        if not info:
            if msg == "unsupported":
                return jsonify({"supported": False, "message": "التحقق غير متوفر لهذا المنتج — تأكد من الآيدي قبل الطلب"})
            return jsonify({"supported": True, "valid": False, "message": msg or "تعذّر التحقق حالياً"})
        if info.get("valid"):
            return jsonify({"supported": True, "valid": True, "nickname": info.get("nickname") or ""})
        return jsonify({"supported": True, "valid": False, "message": info.get("message") or "الآيدي غير صحيح، تحقق وأعد المحاولة"})

    @app.get("/api/tier-discounts")
    def tier_disc():
        u, e = require_user()
        if e:
            return e
        if not u.get("discount_tier_id"):
            return jsonify({"tier_name": None, "discounts": {}})
        t = q(f"SELECT * FROM tiers WHERE id={PH}", (u["discount_tier_id"],), one=True)
        if not t:
            return jsonify({"tier_name": None, "discounts": {}})
        m = {r["section"]: float(r["percent"]) for r in q(f"SELECT section,percent FROM tier_matrix WHERE tier_id={PH}", (t["id"],))}
        return jsonify({"tier_name": t["name"], "discounts": m, "general": float(t.get("percent") or 0)})

    @app.get("/api/products/catalog")
    def catalog():
        u, e = require_user()
        if e:
            return e
        rows = q("SELECT s.*,p.name AS pname,p.category AS pcat FROM skus s LEFT JOIN products p ON p.id=s.product_id ORDER BY p.name,s.price_usd")
        out = []
        for s in rows:
            price, _ = effective_price(s, u)
            out.append({"id": s.get("public_id") or s["id"], "name": s["name"], "category_name": s.get("pcat") or "",
                        "available": bool(s.get("available")), "product_type": s.get("type") or "default", "price": price})
        return jsonify(out)

    # ============ WALLET / DEPOSIT ============
    @app.get("/api/wallet")
    def wallet():
        u, e = require_user()
        if e:
            return e
        return jsonify({"user": user_public(u)})

    @app.get("/api/wallet/deposit-methods")
    def dep_methods():
        auto = [{"id": r["id"], "title": r["title"], "description": r.get("description") or "",
                 "image": r.get("image") or "", "gateway_type": r.get("gateway_type") or "",
                 "input_currency": r.get("input_currency") or "usd"}
                for r in q("SELECT * FROM dep_auto ORDER BY id")]
        manual = [{"id": r["id"], "title": r["title"], "code": r.get("code") or "",
                   "description": r.get("description") or "", "image": r.get("image") or "",
                   "input_currency": r.get("input_currency") or "usd"}
                  for r in q("SELECT * FROM dep_manual ORDER BY id")]
        return jsonify({"auto": auto, "manual": manual})

    @app.post("/api/wallet/deposit/create-invoice")
    def create_invoice():
        u, e = require_user()
        if e:
            return e
        d = request.get_json(force=True, silent=True) or {}
        m = q(f"SELECT * FROM dep_auto WHERE id={PH}", (d.get("method_id"),), one=True)
        if not m:
            return err("طريقة الإيداع غير موجودة")
        try:
            amount = float(d.get("amount") or 0)
        except Exception:
            return err("المبلغ غير صحيح")
        if amount <= 0:
            return err("المبلغ غير صحيح")
        cur = (d.get("currency") or "USD").upper()
        usd = amount if cur == "USD" else round(amount / rate(), 2)
        import urllib.request as _url
        pay_url = ""
        try:
            base = (m.get("api_url") or "").rstrip("/")
            if base:
                payload = json.dumps({"amount": amount, "currency": cur,
                                      "order_id": f"DEP-{u['id']}-{int(time.time())}",
                                      "callback": request.host_url.rstrip("/") + "/api/wallet/deposit/callback"}).encode()
                req = _url.Request(base + "/create", data=payload,
                                   headers={"Content-Type": "application/json", "Authorization": "Bearer " + (m.get("api_token") or "")})
                with _url.urlopen(req, timeout=15) as r2:
                    info = json.loads(r2.read().decode())
                pay_url = info.get("payment_url") or info.get("url") or ""
        except Exception as ex:
            log(u["email"], "invoice-error", str(m.get("id")), str(ex)[:200])
        dep_id = w(f"INSERT INTO deposits(user_id,method_title,method_id,kind,amount_usd,amount_syp,code,status,created_at) VALUES({PH},{PH},{PH},'auto',{PH},{PH},{PH},'pending',{PH})",
                   (u["id"], m["title"], m["id"], usd, usd_to_syp(usd), "", NOW()))
        if not pay_url:
            return jsonify({"message": "تم إنشاء طلب الإيداع، بانتظار تأكيد الدفع", "deposit_id": dep_id})
        return jsonify({"payment_url": pay_url, "deposit_id": dep_id})

    @app.post("/api/wallet/deposit")
    def deposit():
        u, e = require_user()
        if e:
            return e
        d = request.get_json(force=True, silent=True) or {}
        kind = d.get("kind") or "manual"
        try:
            amount = float(d.get("amount_usd") or 0)
        except Exception:
            return err("المبلغ غير صحيح")
        if amount <= 0:
            return err("المبلغ غير صحيح")
        if kind == "manual":
            m = q(f"SELECT * FROM dep_manual WHERE id={PH}", (d.get("method_id"),), one=True)
        else:
            m = q(f"SELECT * FROM dep_auto WHERE id={PH}", (d.get("method_id"),), one=True)
        if not m:
            return err("طريقة الإيداع غير موجودة")
        code = (d.get("transaction_code") or "").strip()
        dep_id = w(f"INSERT INTO deposits(user_id,method_title,method_id,kind,amount_usd,amount_syp,code,status,created_at) VALUES({PH},{PH},{PH},{PH},{PH},{PH},{PH},'pending',{PH})",
                   (u["id"], m["title"], m["id"], kind, amount, usd_to_syp(amount), code, NOW()))
        add_activity(u["id"], "deposit", "pending", f"طلب إيداع ${amount:.2f}", m["title"], kind, usd_to_syp(amount), f"DEP-{dep_id}")
        notify_admin("طلب إيداع جديد", f"{u.get('name')} طلب ${amount:.2f} عبر {m['title']}")
        return jsonify({"message": "تم إرسال طلب الإيداع، سيتم مراجعته قريباً", "deposit_id": dep_id})

    @app.get("/api/wallet/deposit-history")
    def dep_history():
        u, e = require_user()
        if e:
            return e
        rows = q(f"SELECT amount_usd,status,created_at AS date FROM deposits WHERE user_id={PH} ORDER BY id DESC LIMIT 100", (u["id"],))
        return jsonify([{"amount_usd": float(r["amount_usd"] or 0), "status": r["status"], "date": r["date"]} for r in rows])

    # ============ ORDERS ============
    @app.post("/api/orders")
    def place_order():
        u, e = require_user()
        if e:
            return e
        d = request.get_json(force=True, silent=True) or {}
        s = q(f"SELECT * FROM skus WHERE id={PH}", (d.get("category_id"),), one=True)
        if not s:
            return err("الباقة غير موجودة")
        _prod_chk = q(f"SELECT active FROM products WHERE id={PH}", (s.get("product_id"),), one=True)
        if _prod_chk and _prod_chk.get("active") == 0:
            return err("هذا المنتج غير متوفر حالياً")
        try:
            qty = max(1, int(d.get("qty") or 1))
        except Exception:
            return err("الكمية غير صحيحة")
        if (s.get("min_qty") or 1) and qty < (s.get("min_qty") or 1):
            return err(f"أقل كمية {s['min_qty']}")
        if (s.get("max_qty") or 0) and qty > (s.get("max_qty") or 0):
            return err(f"أقصى كمية {s['max_qty']}")
        if s.get("stock_qty") is not None and int(s["stock_qty"]) < qty:
            return err("الكمية غير متوفرة بالمخزون")
        if not s.get("available"):
            return err("هذه الباقة غير متوفرة حالياً")
        price_one, _ = effective_price(s, u)
        unit = s.get("unit_qty") or 1
        total = round(price_one * qty / unit, 2)
        if float(u.get("balance_usd") or 0) < total:
            return err("رصيدك غير كافٍ، اشحن محفظتك أولاً")
        player = (d.get("player_id") or "").strip()
        p = q(f"SELECT * FROM products WHERE id={PH}", (s.get("product_id"),), one=True)
        track = "TRK-%d-%s" % (u["id"], secrets.token_hex(4).upper())
        oid = w(f"INSERT INTO orders(user_id,sku_id,product_name,category_name,player_id,qty,currency,price_usd,price_syp,cost_usd,status,source,track,raw_status,created_at) VALUES({PH},{PH},{PH},{PH},{PH},{PH},{PH},{PH},{PH},{PH},'pending','manual',{PH},'pending',{PH})",
                (u["id"], s["id"], (p or {}).get("name") or "", s["name"], player, qty, (d.get("currency") or "USD").upper(),
                 total, usd_to_syp(total), float(s.get("cost_usd") or 0), track, NOW()))
        w(f"UPDATE users SET balance_usd=balance_usd-{PH} WHERE id={PH}", (total, u["id"]))
        if s.get("stock_qty") is not None:
            w(f"UPDATE skus SET stock_qty=stock_qty-{PH} WHERE id={PH}", (qty, s["id"]))
        auto_tier(u["id"])
        add_activity(u["id"], "order", "pending", f"طلب {s['name']}", player, "manual", usd_to_syp(total), f"#{oid}")
        notify_user(u["id"], "تم استلام طلبك", f"طلبك #{oid} قيد التنفيذ", "info")
        notify_admin("طلب جديد", f"{u.get('name')} طلب {s['name']} x{qty}")
        log(u["email"], "order", str(oid), s["name"])
        if s.get("provider_id"):
            try:
                prov = q(f"SELECT * FROM providers WHERE id={PH}", (s["provider_id"],), one=True)
                if prov and (prov.get("url") or ""):
                    info, pmsg = provider_call(prov, "order", {"product": s.get("api_product_id"),
                                                               "api_product": s.get("api_product_id"),
                                                               "product_key": s.get("api_product_id"),
                                                               "product_name": s.get("name"),
                                                               "player_id": player, "qty": qty,
                                                               "order_id": oid, "buyer_ref": f"AS-{oid}"})
                    if info:
                        ext = str(info.get("order_id") or info.get("id") or "")
                        pcost = None
                        try:
                            pcost = float(info.get("price") or 0) or None
                        except Exception:
                            pcost = None
                        if pcost:
                            w(f"UPDATE orders SET cost_usd={PH} WHERE id={PH}", (round(pcost, 4), oid))
                        w(f"UPDATE orders SET source='api',ext_order_id={PH},raw_status='pending' WHERE id={PH}", (ext, oid))
                        add_activity(u["id"], "order", "pending", f"تنفيذ تلقائي #{oid}", ext, "api", None, f"#{oid}")
                        log("system", "order-autoapi", str(oid), f"{prov.get('name')} {ext}")
                        notify_user(u["id"], "تم إرسال طلبك للمزود", f"طلبك #{oid} قيد الشحن تلقائياً", "info")
                    else:
                        notify_admin("فشل تنفيذ تلقائي", f"طلب #{oid} ({s['name']}) لم يُنفذ عبر المزود وسيُدار يدوياً: {str(pmsg)[:160]}")
            except Exception as tex:
                log("system", "order-autoapi-err", str(oid), str(tex)[:200])
        return jsonify({"message": "تم إرسال طلبك بنجاح", "order_id": oid})

    @app.get("/api/orders")
    def my_orders():
        u, e = require_user()
        if e:
            return e
        rows = q(f"SELECT * FROM orders WHERE user_id={PH} ORDER BY id DESC LIMIT 200", (u["id"],))
        out = []
        for r in rows:
            out.append({"id": r["id"], "product_name": r.get("product_name") or "", "category_name": r.get("category_name") or "",
                        "player_id": r.get("player_id") or "", "track": r.get("track") or f"TRK-{r['id']}",
                        "qty": r.get("qty") or 1, "date": r.get("created_at") or "", "status": r.get("status") or "pending",
                        "raw_status": r.get("raw_status") or r.get("status") or "pending",
                        "price_syp": float(r.get("price_syp") or 0), "source": r.get("source") or "manual"})
        return jsonify(out)

    @app.get("/api/orders/<int:oid>/detail")
    def order_detail(oid):
        u, e = require_user()
        if e:
            return e
        r = q(f"SELECT * FROM orders WHERE id={PH} AND user_id={PH}", (oid, u["id"]), one=True)
        if not r:
            return err("الطلب غير موجود", 404)
        replies = []
        try:
            replies = json.loads(r.get("replies") or "[]")
        except Exception:
            replies = []
        if r.get("source") == "api" and r.get("status") == "pending" and r.get("ext_order_id"):
            try:
                _, status, sync_reps = api_sync_order(r, u["id"])
                if sync_reps:
                    replies = sync_reps
                r = q(f"SELECT * FROM orders WHERE id={PH} AND user_id={PH}", (oid, u["id"]), one=True) or r
            except Exception:
                pass
        return jsonify({"id": r["id"], "ext_order_id": r.get("ext_order_id") or "",
                        "track": r.get("track") or f"TRK-{r['id']}", "product_name": r.get("product_name") or "",
                        "category_name": r.get("category_name") or "", "qty": r.get("qty") or 1,
                        "price_usd": float(r.get("price_usd") or 0), "date": r.get("created_at") or "",
                        "player_id": r.get("player_id") or "", "raw_status": r.get("raw_status") or r.get("status"),
                        "status": r.get("status"), "source": r.get("source") or "manual",
                        "response_time_text": r.get("response_time_text") or "", "reply_items": replies})

    def api_sync_order(r, user_id):
        """جلب حالة طلب api من المزود وتطبيق التسليم أو الاسترداد تلقائياً."""
        changed = False
        fin, rep, raw = provider_order_status(r)
        if raw and raw != (r.get("raw_status") or ""):
            w(f"UPDATE orders SET raw_status={PH} WHERE id={PH}", (raw, r["id"]))
            changed = True
        if fin == "accepted":
            w(f"UPDATE orders SET status='accepted',raw_status={PH} WHERE id={PH}", (raw, r["id"]))
            notify_user(user_id, "تم شحن طلبك", f"طلبك #{r['id']} تم تنفيذه", "success")
            add_activity(user_id, "order", "accepted", f"شحن #{r['id']}", r.get("ext_order_id") or "", "api", None, f"#{r['id']}")
            log("system", "order-api-done", str(r["id"]), raw or "")
            return True, "accepted", rep or []
        if fin == "rejected":
            w(f"UPDATE orders SET status='rejected',raw_status={PH} WHERE id={PH}", (raw, r["id"]))
            w(f"UPDATE users SET balance_usd=balance_usd+{PH} WHERE id={PH}", (float(r.get("price_usd") or 0), user_id))
            notify_user(user_id, "فشل تنفيذ طلبك", f"طلبك #{r['id']} لم يكتمل وتمت إعادة رصيدك", "warning")
            add_activity(user_id, "order", "rejected", f"فشل #{r['id']}", r.get("ext_order_id") or "", "api", None, f"#{r['id']}")
            log("system", "order-api-rej", str(r["id"]), (raw or "") + " (رصيد مست)"
                if isinstance(raw, str) else "rejected")
            return True, "rejected", rep or []
        return changed, r.get("status"), rep or []

    @app.get("/api/orders/<int:oid>/refresh")
    def order_refresh(oid):
        u, e = require_user()
        if e:
            return e
        r = q(f"SELECT * FROM orders WHERE id={PH} AND user_id={PH}", (oid, u["id"]), one=True)
        if not r:
            return err("الطلب غير موجود", 404)
        try:
            replies = json.loads(r.get("replies") or "[]")
        except Exception:
            replies = []
        changed, status = False, r.get("status")
        if r.get("source") == "api" and r.get("status") == "pending" and r.get("ext_order_id"):
            changed, status, sp = api_sync_order(r, u["id"])
            if sp:
                replies = sp
        return jsonify({"changed": changed, "status": status, "reply_items": replies})

    @app.post("/api/admin/orders/refresh-api")
    def adm_refresh_api():
        t, e = require_admin()
        if e:
            return e
        rows = q("SELECT * FROM orders WHERE source='api' AND status='pending' AND COALESCE(ext_order_id,'')<>'' ORDER BY id ASC LIMIT 40")
        done = {"checked": 0, "accepted": 0, "rejected": 0, "changed": 0}
        for r in rows:
            if not r.get("ext_order_id") or len(str(r.get("ext_order_id"))) < 3:
                continue
            done["checked"] += 1
            try:
                changed, status, _ = api_sync_order(r, r["user_id"])
            except Exception:
                continue
            if status == "accepted":
                done["accepted"] += 1
            elif status == "rejected":
                done["rejected"] += 1
            if changed:
                done["changed"] += 1
        return jsonify({"message": "تم تحديث الطلبات API", **done})

    def prov_headers(prov, mode):
        h = {"Content-Type": "application/json", "User-Agent": "ARAB-STORE/1.0"}
        if mode == "recharge":
            h["X-API-Key"] = prov.get("token") or ""
        else:
            h["api-token"] = prov.get("token") or ""
        return h

    def prov_cache_mode(prov, mode):
        try:
            w(f"UPDATE providers SET api_mode={PH} WHERE id={PH}", (mode, prov.get("id")))
        except Exception:
            pass
        return mode

    def prov_detect_mode(prov):
        if (prov.get("api_mode") or "auto") in ("aloshy", "recharge", "generic"):
            return prov["api_mode"]
        import urllib.request as _url
        base = (prov.get("url") or "").rstrip("/")
        if not base or not (prov.get("token") or ""):
            return prov_cache_mode(prov, "generic")
        try:
            req = _url.Request(base + "/client/api/profile", headers=prov_headers(prov, "aloshy"))
            with _url.urlopen(req, timeout=12) as r2:
                info = json.loads(r2.read().decode() or "{}")
            if isinstance(info, dict) and (info.get("status") == "OK" or "balance" in info):
                return prov_cache_mode(prov, "aloshy")
        except Exception:
            pass
        try:
            req = _url.Request(base + "/v1/ping", headers=prov_headers(prov, "recharge"))
            with _url.urlopen(req, timeout=12) as r2:
                info = json.loads(r2.read().decode() or "{}")
            if isinstance(info, dict) and info.get("ok"):
                return prov_cache_mode(prov, "recharge")
        except Exception:
            pass
        return prov_cache_mode(prov, "generic")

    def prov_request(prov, mode, method, path, body=None):
        import urllib.request as _url
        import urllib.error as _ue
        base = (prov.get("url") or "").rstrip("/")
        req = _url.Request(base + path,
                           data=(json.dumps(body).encode() if body is not None else None),
                           headers=prov_headers(prov, mode), method=method)
        try:
            with _url.urlopen(req, timeout=25) as r2:
                return json.loads(r2.read().decode() or "{}"), ""
        except _ue.HTTPError as ex:
            try:
                detail = json.loads(ex.read().decode() or "{}")
                e2 = detail.get("error")
                msg = (e2.get("message") if isinstance(e2, dict) else e2) or detail.get("message") or f"HTTP {ex.code}"
            except Exception:
                msg = f"HTTP {ex.code}"
            return None, str(msg)[:200]
        except Exception as ex:
            return None, str(ex)[:200]

    def aloshy_call(prov, kind, p):
        import urllib.parse as _up
        if kind == "balance":
            info, err = prov_request(prov, "aloshy", "GET", "/client/api/profile")
            if not info:
                return None, err
            return {"balance": str(info.get("balance") or "")}, ""
        if kind == "catalog":
            info, err = prov_request(prov, "aloshy", "GET", "/client/api/products")
            if not info:
                return None, err
            items = info if isinstance(info, list) else info.get("products") or info.get("items") or []
            return {"products": [{"id": str(x.get("id")), "name": x.get("name"), "price": x.get("price"),
                                   "category": x.get("category_name") or ""} for x in (items if isinstance(items, list) else [])]}, ""
        if kind == "order":
            params = {"qty": p.get("qty", 1), "order_uuid": p.get("order_uuid") or p.get("buyer_ref") or ""}
            if (p.get("player_id") or "").strip():
                params["playerId"] = p["player_id"].strip()
            qs = _up.urlencode(params)
            info, err = prov_request(prov, "aloshy", "POST",
                                     "/client/api/newOrder/" + _up.quote(str(p.get("product") or "")) + "/params?" + qs)
            if not info:
                return None, err
            if info.get("status") != "OK":
                return None, str(info.get("message") or info)[:200]
            d = info.get("data") or {}
            return {"order_id": str(d.get("order_id") or ""), "price": d.get("price") or 0,
                    "status": d.get("status") or ""}, ""
        if kind == "status":
            oid = str(p.get("order_id") or "")
            info, err = prov_request(prov, "aloshy", "GET", "/client/api/check?orders=" + _up.quote("[" + oid + "]"))
            if not info:
                return None, err
            arr = info.get("data") or []
            if not arr:
                return {"status": "", "replies": []}, ""
            o = arr[0]
            return {"status": str(o.get("status") or ""),
                    "replies": [{"kind": "code", "text": str(x)} for x in (o.get("replay_api") or [])]}, ""
        if kind == "verify":
            # aloshi-style providers: no documented player-check endpoint yet
            return None, "unsupported"
        return None, "unknown kind"

    def recharge_call(prov, kind, p):
        if kind == "balance":
            info, err = prov_request(prov, "recharge", "GET", "/v1/balance")
            if not info:
                return None, err
            return {"balance": str(info.get("balance_usdt") or "")}, ""
        if kind == "catalog":
            info, err = prov_request(prov, "recharge", "GET", "/v1/products?all=true")
            if not info:
                return None, err
            flat = []
            for c in (info.get("categories") or []):
                for g in (c.get("groups") or []):
                    for x in (g.get("products") or []):
                        flat.append({"id": x.get("product_key") or x.get("name"),
                                     "name": ("%s - %s" % (c.get("name") or "", x.get("name") or "")).strip(" -"),
                                     "price": x.get("price"), "category": c.get("name") or ""})
            return {"products": flat}, ""
        if kind == "order":
            body = {"buyer_ref": p.get("buyer_ref") or p.get("order_uuid") or ("AS-%d" % int(time.time())),
                    "quantity": int(p.get("qty") or 1)}
            if p.get("product") or p.get("product_name"):
                body["product"] = p.get("product") or p.get("product_name")
            if p.get("product_key") or p.get("api_product"):
                body["product_key"] = p.get("product_key") or p.get("api_product")
            if (p.get("player_id") or "").strip():
                body["player_id"] = p["player_id"].strip()
            if p.get("test"):
                body["test"] = True
            info, err = prov_request(prov, "recharge", "POST", "/v1/orders", body)
            if not info:
                return None, err
            return {"order_id": str(info.get("order_id") or ""), "price": info.get("price_usdt") or 0,
                    "status": info.get("status") or ""}, ""
        if kind == "status":
            info, err = prov_request(prov, "recharge", "GET", "/v1/orders/" + str(p.get("order_id") or ""))
            if not info:
                return None, err
            reps = []
            if info.get("delivery_note"):
                reps.append({"kind": "code", "text": str(info["delivery_note"])})
            if info.get("failure_reason"):
                reps.append({"kind": "text", "text": str(info["failure_reason"])})
            return {"status": str(info.get("status") or ""), "replies": reps}, ""
        if kind == "verify":
            # recharge region-check needs game/region mapping which we don't store per product yet
            return None, "unsupported"
        return None, "unknown kind"

    def provider_call(prov, kind, payload=None):
        """Dual-protocol provider driver (aloshy / recharge / generic legacy)."""
        mode = prov_detect_mode(prov)
        payload = payload or {}
        if mode == "recharge":
            return recharge_call(prov, kind, payload)
        if mode == "aloshy":
            return aloshy_call(prov, kind, payload)
        import urllib.request as _url
        base = (prov.get("url") or "").rstrip("/")
        path = {"order": prov.get("order_path"), "status": prov.get("status_path"),
                "catalog": prov.get("catalog_path"), "balance": prov.get("balance_path")}.get(kind, "")
        if not base or not path:
            return None, "provider not configured"
        url = base + "/" + path.lstrip("/")
        if payload:
            for k, v in payload.items():
                url = url.replace("{" + k + "}", str(v))
        try:
            data = json.dumps(payload or {}).encode() if kind == "order" else None
            req = _url.Request(url, data=data, headers={"Content-Type": "application/json",
                                                        "User-Agent": "ARAB-STORE/1.0",
                                                        "Authorization": "Bearer " + (prov.get("token") or "")})
            with _url.urlopen(req, timeout=20) as r2:
                return json.loads(r2.read().decode() or "{}"), ""
        except Exception as ex:
            return None, str(ex)[:200]

    def provider_order_status(order):
        s = q(f"SELECT * FROM skus WHERE id={PH}", (order.get("sku_id"),), one=True)
        if not s or not s.get("provider_id"):
            return None, [], order.get("raw_status") or ""
        prov = q(f"SELECT * FROM providers WHERE id={PH}", (s["provider_id"],), one=True)
        if not prov:
            return None, [], order.get("raw_status") or ""
        info, _ = provider_call(prov, "status", {"order_id": order.get("ext_order_id"), "id": order.get("ext_order_id")})
        if not info:
            return None, [], order.get("raw_status") or ""
        st = str(info.get("status") or "").lower()
        norm = []
        for x in (info.get("replies") or []):
            if isinstance(x, dict):
                norm.append({"kind": x.get("kind", "text"), "text": str(x.get("text", ""))})
            else:
                norm.append({"kind": "text", "text": str(x)})
        if norm:
            w(f"UPDATE orders SET replies={PH} WHERE id={PH}", (json.dumps(norm, ensure_ascii=False), order["id"]))
        if st in ("delivered", "completed", "complete", "accept", "accepted"):
            return "accepted", norm, st
        if st in ("failed", "reject", "refunded", "rejected", "cancelled", "canceled"):
            return "rejected", norm, st
        return None, norm, st

    # ============ USER MISC ============
    @app.get("/api/user/activity")
    def user_activity():
        u, e = require_user()
        if e:
            return e
        rows = q(f"SELECT kind,status,title,detail,source,amount_syp,ref,created_at AS date FROM activity WHERE user_id={PH} ORDER BY id DESC LIMIT 200", (u["id"],))
        return jsonify(rows)

    @app.get("/api/user/api")
    def user_api_info():
        u, e = require_user()
        if e:
            return e
        if not u.get("api_enabled"):
            return err("API غير مفعّل لحسابك، تواصل مع الإدارة", 403)
        return jsonify({"api_key": u.get("api_key") or "", "allowed_ips": u.get("allowed_ips") or ""})

    @app.post("/api/user/api/ips")
    def user_api_ips():
        u, e = require_user()
        if e:
            return e
        d = request.get_json(force=True, silent=True) or {}
        w(f"UPDATE users SET allowed_ips={PH} WHERE id={PH}", ((d.get("allowed_ips") or "").strip(), u["id"]))
        return jsonify({"message": "تم الحفظ"})

    @app.get("/api/notifications")
    def notifs():
        u, e = require_user()
        if e:
            return e
        rows = q(f"SELECT * FROM notifs WHERE user_id={PH} OR user_id=0 ORDER BY id DESC LIMIT 50", (u["id"],))
        unread = q(f"SELECT COUNT(*) AS c FROM notifs WHERE (user_id={PH} OR user_id=0) AND is_read=0", (u["id"],), one=True)
        return jsonify({"unread": int((unread or {}).get("c") or 0),
                        "items": [{"id": r["id"], "title": r["title"], "message": r.get("message") or "",
                                   "kind": r.get("kind") or "info", "created_at": r.get("created_at") or ""} for r in rows]})

    @app.post("/api/notifications/mark-read")
    def notifs_read():
        u, e = require_user()
        if e:
            return e
        w(f"UPDATE notifs SET is_read=1 WHERE user_id={PH} OR user_id=0", (u["id"],))
        return jsonify({"message": "ok"})

    @app.get("/api/push/public-key")
    def push_key():
        return jsonify({"enabled": bool(get_setting("vapid_public", "")), "public_key": get_setting("vapid_public", "")})

    @app.post("/api/push/subscribe")
    def push_sub():
        d = request.get_json(force=True, silent=True) or {}
        ep = d.get("endpoint") or (d.get("subscription") or {}).get("endpoint") or ""
        if not ep:
            return err("endpoint مطلوب")
        u = current_user()
        uid = u["id"] if u else 0
        if q(f"SELECT endpoint FROM push_subs WHERE endpoint={PH}", (ep,), one=True):
            w(f"UPDATE push_subs SET user_id={PH},keys_json={PH} WHERE endpoint={PH}", (uid, json.dumps(d, ensure_ascii=False), ep))
        else:
            w(f"INSERT INTO push_subs(endpoint,user_id,keys_json) VALUES({PH},{PH},{PH})", (ep, uid, json.dumps(d, ensure_ascii=False)))
        return jsonify({"message": "ok"})

    @app.post("/api/push/unsubscribe")
    def push_unsub():
        d = request.get_json(force=True, silent=True) or {}
        if d.get("endpoint"):
            w(f"DELETE FROM push_subs WHERE endpoint={PH}", (d["endpoint"],))
        return jsonify({"message": "ok"})

    @app.get("/api/maintenance-status")
    def maint_status():
        m = jget("maintenance", {}) or {}
        return jsonify({"enabled": bool(m.get("enabled")), "seconds_left": int(m.get("seconds_left") or 0),
                        "reason": m.get("reason") or "", "note": m.get("note") or ""})

    @app.get("/api/ai-agent/config")
    def ai_config():
        return jsonify({"enabled": get_setting("ai_agent_enabled", "false").strip().lower() == "true",
                        "name": get_setting("ai_agent_name", "مساعد ARAB"),
                        "welcome": get_setting("ai_agent_welcome", "")})

    @app.post("/api/ai-agent/chat")
    def ai_chat():
        d = request.get_json(force=True, silent=True) or {}
        msg = (d.get("message") or "").strip()[:1000]
        if not msg:
            return err("اكتب سؤالك")
        if get_setting("ai_agent_enabled", "false").strip().lower() != "true":
            return err("المساعد غير مفعّل حالياً")
        reply, cards = ai_answer(msg, (d.get("history") or []))
        try:
            w(f"INSERT INTO ai_memory(question,reply,created_at) VALUES({PH},{PH},{PH})", (msg, reply, NOW()))
        except Exception:
            pass
        return jsonify({"reply": reply, "cards": cards})

    # ============ WHATSAPP CONNECTOR (worker-facing, secret protected) ============
    def _wa_auth():
        s = request.args.get("secret", "") or (request.headers.get("X-WA-Secret", ""))
        return s and s == wa_secret()

    @app.get("/api/wa/bootstrap")
    def wa_bootstrap():
        if not _wa_auth():
            return jsonify({"message": "unauthorized"}), 401
        pair = jget("wa_pair_req", {}) or {}
        return jsonify({
            "ok": True,
            "enabled": get_setting("wa_enabled", "false").strip().lower() == "true",
            "bot_enabled": get_setting("wa_bot_enabled", "true").strip().lower() == "true",
            "phone": wa_norm_phone(get_setting("wa_phone", "")),
            "pair_requested": bool(pair.get("requested")),
            "greeting": get_setting("wa_greeting", ""),
            "version": get_setting("wa_cfg_version", "1"),
        })

    @app.get("/api/wa/status")
    def wa_status_ep():
        if not _wa_auth():
            return jsonify({"message": "unauthorized"}), 401
        st = wa_status_get()
        pair = jget("wa_pair_req", {}) or {}
        force = wa_kv_get("wa_force_logout", False)
        if force:
            wa_kv_set("wa_force_logout", False)
        return jsonify({"ok": True, "status": st, "pair_requested": bool(pair.get("requested")),
                        "phone": wa_norm_phone(get_setting("wa_phone", "")),
                        "force_logout": bool(force),
                        "cfg_version": get_setting("wa_cfg_version", "1")})

    @app.post("/api/wa/status")
    def wa_status_post():
        if not _wa_auth():
            return jsonify({"message": "unauthorized"}), 401
        d = request.get_json(force=True, silent=True) or {}
        st = wa_status_get()
        for k in ("linked", "code", "qr", "me", "platform", "error"):
            if k in d:
                st[k] = d[k]
        st["updated"] = NOW()
        if d.get("linked") and not st.get("since"):
            st["since"] = NOW()
        wa_status_set(st)
        if d.get("linked") and d.get("code") == "":
            pass
        return jsonify({"ok": True})

    @app.post("/api/wa/incoming")
    def wa_incoming():
        if not _wa_auth():
            return jsonify({"message": "unauthorized"}), 401
        if get_setting("wa_enabled", "false").strip().lower() != "true":
            return jsonify({"ok": True, "reply": "", "disabled": True})
        d = request.get_json(force=True, silent=True) or {}
        text = (d.get("text") or "").strip()[:2000]
        number = d.get("number") or ""
        name = d.get("name") or ""
        if not text:
            return jsonify({"ok": True, "reply": ""})
        if get_setting("wa_bot_enabled", "true").strip().lower() != "true":
            wa_log_msg("in", number, name, text, "")
            return jsonify({"ok": True, "reply": ""})
        low = text.lower()
        if any(w in text for w in ("سلام", "مرحبا", "مرحباً", "اهلا", "أهلا", "هلا", "هاي")) and len(text) <= 15:
            url = wa_store_url()
            greet = get_setting("wa_greeting", "") or "أهلاً وسهلاً 👋"
            if get_setting("wa_append_link", "true").strip().lower() == "true" and url and url not in greet:
                greet = greet.rstrip() + "\n\n🔗 " + url
            wa_log_msg("in", number, name, text, greet)
            wa_log_msg("out", number, name, greet, "")
            return jsonify({"ok": True, "reply": greet})
        # طلب التحدث مع المالك/الإدارة: توجيه + إيقاف البوت لهذا الزبون حتى ينهي المالك المحادثة
        OWNER_SIGS = ("المالك", "مالك", "المدير", "مدير", "صاحب الرقم", "صاحب المتجر", "الادارة", "الإدارة",
                      "الاداري", "الإداري", "بدي اكلم", "بدي اتكلم", "بدى اكلم", "بدى اتكلم",
                      "ابغي اكلم", "ابغى اتكلم", "ابدى اكلم", "ابدى اتكلم", "بشري", "موظف",
                      "تواصل مع", "اتصل بي")
        hum = q(f"SELECT number,done FROM wa_humans WHERE number={PH}", (str(number),), one=True)
        if hum and not hum.get("done"):
            wa_log_msg("in", number, name, text, "")
            notify_admin("💬 رسالة زبون موجه للمالك", f"{name or 'زبون'} ({number}): {text[:300]}")
            return jsonify({"ok": True, "reply": ""})
        want_owner = bool(low and (any(s in low for s in OWNER_SIGS) or any(s in text for s in OWNER_SIGS)))
        if want_owner:
            fwd = get_setting("wa_owner_forward_msg", "") or "✅ تم توجيه رسالتك إلى المالك، سيتم الرد عليك قريباً 🙏"
            if not hum:
                try:
                    w(f"INSERT INTO wa_humans(number,name,first_msg,created_at,done) VALUES({PH},{PH},{PH},{PH},0)",
                      (str(number), str(name), text[:500], NOW()))
                except Exception:
                    pass
            wa_log_msg("in", number, name, text, "")
            wa_log_msg("out", number, name, "", fwd)
            notify_admin("🔔 طلب تحدث مع المالك", f"{name or 'زبون'} ({number}): {text[:300]}")
            return jsonify({"ok": True, "reply": fwd})
        hist = d.get("history") if isinstance(d.get("history"), list) else None
        reply, cards = wa_ai_reply(text, hist)
        wa_log_msg("in", number, name, text, reply)
        wa_log_msg("out", number, name, reply, "")
        return jsonify({"ok": True, "reply": reply, "cards": cards})

    @app.post("/api/wa/pair")
    def wa_pair_ack():
        if not _wa_auth():
            return jsonify({"message": "unauthorized"}), 401
        d = request.get_json(force=True, silent=True) or {}
        if d.get("done"):
            set_setting("wa_pair_req", json.dumps({"requested": False, "phone": "", "at": NOW()}, ensure_ascii=False))
        return jsonify({"ok": True})

    @app.get("/api/wa/session")
    def wa_session_get():
        if not _wa_auth():
            return jsonify({"message": "unauthorized"}), 401
        return jsonify({"ok": True, "creds": wa_kv_get("wa_creds")})

    @app.post("/api/wa/session")
    def wa_session_set():
        if not _wa_auth():
            return jsonify({"message": "unauthorized"}), 401
        d = request.get_json(force=True, silent=True) or {}
        if d.get("creds") is None and d.get("clear"):
            wa_kv_del("wa_creds")
            return jsonify({"ok": True})
        if "creds" in d:
            wa_kv_set("wa_creds", d["creds"])
        return jsonify({"ok": True})

    # ============ ADMIN AUTH ============
    @app.post("/api/admin/login")
    def admin_login():
        d = request.get_json(force=True, silent=True) or {}
        h = get_setting("admin_password_hash", "")
        if not h:
            return err("لم يتم تعيين كلمة سر الأدمن بعد. عيّنها من متغير البيئة ADMIN_PASSWORD عند أول تشغيل.", 403)
        if sha_pw(d.get("password") or "") != h:
            return err("كلمة السر غير صحيحة", 401)
        tok = new_token("adm_")
        w(f"INSERT INTO admin_tokens(token,created_at) VALUES({PH},{PH})", (tok, NOW()))
        log("admin", "login", "", "")
        return jsonify({"token": tok})

    @app.get("/api/admin/me")
    def admin_me():
        t, e = require_admin()
        if e:
            return e
        return jsonify({"stale": False, "restricted": False, "sections": [], "edit": []})

    @app.post("/api/admin/password")
    def admin_pw():
        t, e = require_admin()
        if e:
            return e
        d = request.get_json(force=True, silent=True) or {}
        if sha_pw(d.get("current") or "") != get_setting("admin_password_hash", ""):
            return err("كلمة السر الحالية غير صحيحة")
        if len(d.get("new") or "") < 6:
            return err("الجديدة 6 أحرف على الأقل")
        set_setting("admin_password_hash", sha_pw(d["new"]))
        return jsonify({"message": "تم تغيير كلمة السر"})

    # ============ ADMIN DASHBOARD ============
    @app.get("/api/admin/stats")
    def adm_stats():
        t, e = require_admin()
        if e:
            return e
        today = datetime.datetime.utcnow().strftime("%Y-%m-%d")
        g1 = lambda s, a=(): (q(s, a, one=True) or {})
        users = g1("SELECT COUNT(*) AS c FROM users").get("c", 0)
        orders = g1("SELECT COUNT(*) AS c FROM orders").get("c", 0)
        bal = g1("SELECT COALESCE(SUM(balance_usd),0) AS s FROM users").get("s", 0) or 0
        ts = g1(f"SELECT COALESCE(SUM(price_usd),0) AS s, COUNT(*) AS c FROM orders WHERE created_at LIKE {PH}", (today + "%",))
        prof = g1(f"SELECT COALESCE(SUM(price_usd-cost_usd),0) AS p FROM orders WHERE status IN ('accepted','completed') AND created_at LIKE {PH}", (today + "%",))
        return jsonify({"total_users": users, "total_orders": orders, "total_balance_syp": round(float(bal) * rate(), 2),
                        "exchange_rate": rate(), "today_sales_usd": round(float(ts.get("s") or 0), 2),
                        "today_orders": ts.get("c", 0), "today_profit_usd": round(float(prof.get("p") or 0), 2),
                        "today_margin_percent": 0})

    @app.get("/api/admin/orders")
    def adm_orders():
        t, e = require_admin()
        if e:
            return e
        rows = q("SELECT o.*,u.name AS uname FROM orders o LEFT JOIN users u ON u.id=o.user_id ORDER BY o.id DESC LIMIT 500")
        return jsonify([{"id": r["id"], "user_id": r.get("user_id"), "product_name": r.get("product_name") or "",
                         "price_syp": float(r.get("price_syp") or 0), "status": r.get("status"), "date": r.get("created_at") or "",
                         "ref": f"S{r['id']}", "track": r.get("track") or "", "source": r.get("source") or "manual",
                         "player_id": r.get("player_id") or "", "provider_order": r.get("ext_order_id") or ""} for r in rows])

    @app.post("/api/admin/orders/<ref>/status")
    def adm_order_status(ref):
        t, e = require_admin()
        if e:
            return e
        d = request.get_json(force=True, silent=True) or {}
        action = d.get("action")
        oid = int(ref[1:]) if ref.startswith("S") and ref[1:].isdigit() else (int(ref) if ref.isdigit() else None)
        if not oid:
            return err("طلب غير صالح")
        o = q(f"SELECT * FROM orders WHERE id={PH}", (oid,), one=True)
        if not o:
            return err("الطلب غير موجود", 404)
        if action == "accept":
            w(f"UPDATE orders SET status='accepted',raw_status='accepted' WHERE id={PH}", (oid,))
            notify_user(o["user_id"], "تم قبول طلبك", f"طلبك #{oid} تم قبوله", "success")
        elif action == "reject":
            w(f"UPDATE orders SET status='rejected',raw_status='rejected' WHERE id={PH}", (oid,))
            w(f"UPDATE users SET balance_usd=balance_usd+{PH} WHERE id={PH}", (float(o.get("price_usd") or 0), o["user_id"]))
            notify_user(o["user_id"], "تم رفض طلبك", f"طلبك #{oid} تم رفضه وتم استرجاع المبلغ", "danger")
        else:
            return err("action غير صالح")
        log("admin", "order-" + action, str(oid), "")
        return jsonify({"message": "تم"})

    @app.get("/api/admin/deposits")
    def adm_deposits():
        t, e = require_admin()
        if e:
            return e
        rows = q("SELECT d.*,u.name AS uname FROM deposits d LEFT JOIN users u ON u.id=d.user_id ORDER BY d.id DESC LIMIT 500")
        return jsonify([{"id": r["id"], "full_name": r.get("uname") or "", "user_id": r.get("user_id"),
                         "method_title": r.get("method_title") or "", "amount_usd": float(r.get("amount_usd") or 0),
                         "amount_syp": float(r.get("amount_syp") or 0), "code": r.get("code") or "",
                         "status": r.get("status")} for r in rows])

    @app.post("/api/admin/deposits/<int:did>/accept")
    def adm_dep_accept(did):
        t, e = require_admin()
        if e:
            return e
        d = q(f"SELECT * FROM deposits WHERE id={PH}", (did,), one=True)
        if not d or d.get("status") != "pending":
            return err("الطلب غير موجود أو تمت معالجته")
        w(f"UPDATE deposits SET status='accepted' WHERE id={PH}", (did,))
        w(f"UPDATE users SET balance_usd=balance_usd+{PH} WHERE id={PH}", (float(d.get("amount_usd") or 0), d["user_id"]))
        auto_tier(d["user_id"])
        add_activity(d["user_id"], "deposit", "accepted", f"إيداع ${float(d['amount_usd']):.2f}", d.get("method_title") or "", d.get("kind") or "", float(d.get("amount_syp") or 0), f"DEP-{did}")
        notify_user(d["user_id"], "تم قبول إيداعك", f"تمت إضافة ${float(d['amount_usd']):.2f} لمحفظتك", "success")
        log("admin", "deposit-accept", str(did), "")
        return jsonify({"message": "تم قبول الإيداع"})

    @app.post("/api/admin/deposits/<int:did>/reject")
    def adm_dep_reject(did):
        t, e = require_admin()
        if e:
            return e
        d = q(f"SELECT * FROM deposits WHERE id={PH}", (did,), one=True)
        if not d or d.get("status") != "pending":
            return err("الطلب غير موجود أو تمت معالجته")
        w(f"UPDATE deposits SET status='rejected' WHERE id={PH}", (did,))
        notify_user(d["user_id"], "تم رفض الإيداع", "تواصل مع الدعم للمراجعة", "danger")
        log("admin", "deposit-reject", str(did), "")
        return jsonify({"message": "تم الرفض"})

    @app.get("/api/admin/profits")
    def adm_profits():
        t, e = require_admin()
        if e:
            return e
        start, end = request.args.get("start") or "", request.args.get("end") or ""
        cond, args = "status IN ('accepted','completed')", []
        if start:
            cond += f" AND created_at >= {PH}"; args.append(start)
        if end:
            cond += f" AND created_at <= {PH}"; args.append(end + " 23:59:59")
        rows = q(f"SELECT * FROM orders WHERE {cond} ORDER BY id DESC LIMIT 1000", tuple(args))
        tot_s = sum(float(r.get("price_usd") or 0) for r in rows)
        tot_c = sum(float(r.get("cost_usd") or 0) for r in rows)
        return jsonify({"summary": {"total_orders": len(rows), "total_sales_usd": round(tot_s, 2),
                                    "total_cost_usd": round(tot_c, 2), "total_profit_usd": round(tot_s - tot_c, 2)},
                        "orders": [{"id": r["id"], "source": r.get("source") or "manual", "product_name": r.get("product_name") or "",
                                    "category_name": r.get("category_name") or "", "price_usd": float(r.get("price_usd") or 0),
                                    "cost_usd": float(r.get("cost_usd") or 0),
                                    "profit_usd": round(float(r.get("price_usd") or 0) - float(r.get("cost_usd") or 0), 2),
                                    "created_at": r.get("created_at") or ""} for r in rows]})

    @app.get("/api/admin/shop-orders")
    def adm_shop_orders():
        t, e = require_admin()
        if e:
            return e
        rows = q(f"SELECT * FROM orders WHERE source='manual' ORDER BY id DESC LIMIT 500")
        return jsonify([{"id": r["id"], "track": r.get("track") or "", "user_id": r.get("user_id"),
                         "product_name": r.get("product_name") or "", "category_name": r.get("category_name") or "",
                         "player_id": r.get("player_id") or "", "price_syp": float(r.get("price_syp") or 0),
                         "status": r.get("status"), "qty": r.get("qty") or 1} for r in rows])

    @app.post("/api/admin/shop-orders/<int:oid>/accept")
    def adm_shop_accept(oid):
        t, e = require_admin()
        if e:
            return e
        w(f"UPDATE orders SET status='accepted',raw_status='accepted' WHERE id={PH}", (oid,))
        return jsonify({"message": "تم"})

    @app.post("/api/admin/shop-orders/<int:oid>/reject")
    def adm_shop_reject(oid):
        t, e = require_admin()
        if e:
            return e
        o = q(f"SELECT * FROM orders WHERE id={PH}", (oid,), one=True)
        if o and o.get("status") == "pending":
            w(f"UPDATE orders SET status='rejected' WHERE id={PH}", (oid,))
            w(f"UPDATE users SET balance_usd=balance_usd+{PH} WHERE id={PH}", (float(o.get("price_usd") or 0), o["user_id"]))
        return jsonify({"message": "تم"})

    @app.post("/api/admin/shop-orders/<int:oid>/execute")
    def adm_shop_exec(oid):
        t, e = require_admin()
        if e:
            return e
        d = request.get_json(force=True, silent=True) or {}
        o = q(f"SELECT * FROM orders WHERE id={PH}", (oid,), one=True)
        if not o:
            return err("الطلب غير موجود", 404)
        prov = q(f"SELECT * FROM providers WHERE id={PH}", (d.get("provider_id"),), one=True)
        if not prov:
            return err("المزود غير موجود")
        info, msg = provider_call(prov, "order", {"product": d.get("api_product_id"), "api_product": d.get("api_product_id"),
                                                  "product_name": o.get("category_name") or o.get("product_name"),
                                                  "player_id": o.get("player_id"), "qty": o.get("qty"),
                                                  "order_id": oid, "buyer_ref": f"AS-SHOP-{oid}"})
        if not info:
            return err("فشل التنفيذ عبر المزود: " + msg)
        ext = str(info.get("order_id") or info.get("id") or "")
        w(f"UPDATE orders SET source='api',ext_order_id={PH},raw_status='pending',cost_usd={PH} WHERE id={PH}",
          (ext, float(d.get("cost_usd") or 0), oid))
        return jsonify({"message": "تم إرسال الطلب للمزود"})

    # ============ ADMIN CATALOG ============
    @app.get("/api/admin/sections")
    def adm_sections():
        t, e = require_admin()
        if e:
            return e
        rows = q("SELECT * FROM sections ORDER BY sort_order,id")
        out = []
        for r in rows:
            pc = q(f"SELECT COUNT(*) AS c FROM products WHERE category={PH} AND subsection_id IS NULL", (r['name'],), one=True)
            sc = q(f"SELECT COUNT(*) AS c FROM subsections WHERE section_id={PH}", (r['id'],), one=True)
            out.append({"id": r["id"], "name": r["name"], "emoji": r.get("emoji") or "", "image": r.get("image") or "",
                        "active": bool(r.get("active")), "products_count": (pc or {}).get("c", 0),
                        "subsections_count": (sc or {}).get("c", 0)})
        return jsonify(out)

    @app.post("/api/admin/sections")
    def adm_section_add():
        t, e = require_admin()
        if e:
            return e
        d = request.get_json(force=True, silent=True) or {}
        if not (d.get("name") or "").strip():
            return err("الاسم مطلوب")
        mx = q("SELECT COALESCE(MAX(sort_order),0) AS m FROM sections", one=True)
        w(f"INSERT INTO sections(name,emoji,sort_order) VALUES({PH},{PH},{PH})",
          (d["name"].strip(), d.get("emoji") or "", int((mx or {}).get("m") or 0) + 1))
        log("admin", "section-add", d["name"], "")
        return jsonify({"message": "تمت الإضافة"})

    @app.put("/api/admin/sections/<int:sid>")
    def adm_section_upd(sid):
        t, e = require_admin()
        if e:
            return e
        d = request.get_json(force=True, silent=True) or {}
        sets, args = [], []
        for k in ("name", "emoji", "image"):
            if k in d:
                sets.append(f"{k}={PH}"); args.append(d[k])
        if "active" in d:
            sets.append(f"active={PH}"); args.append(1 if d["active"] else 0)
        if not sets:
            return err("لا يوجد ما يُحدّث")
        args.append(sid)
        w(f"UPDATE sections SET {','.join(sets)} WHERE id={PH}", tuple(args))
        return jsonify({"message": "تم الحفظ"})

    @app.delete("/api/admin/sections/<int:sid>")
    def adm_section_del(sid):
        t, e = require_admin()
        if e:
            return e
        r = q(f"SELECT * FROM sections WHERE id={PH}", (sid,), one=True)
        if r:
            for s in q(f"SELECT id FROM subsections WHERE section_id={PH}", (sid,)):
                w(f"DELETE FROM subsections WHERE id={PH}", (s["id"],))
            w(f"DELETE FROM sections WHERE id={PH}", (sid,))
            log("admin", "section-del", r.get("name") or "", "")
        return jsonify({"message": "تم الحذف"})

    @app.post("/api/admin/sections/reorder")
    def adm_section_reorder():
        t, e = require_admin()
        if e:
            return e
        d = request.get_json(force=True, silent=True) or {}
        for i, sid in enumerate(d.get("ids") or []):
            w(f"UPDATE sections SET sort_order={PH} WHERE id={PH}", (i, sid))
        return jsonify({"message": "تم"})

    @app.get("/api/admin/sections/<int:sid>/subsections")
    def adm_subs(sid):
        t, e = require_admin()
        if e:
            return e
        rows = q(f"SELECT * FROM subsections WHERE section_id={PH} ORDER BY sort_order,id", (sid,))
        out = []
        for r in rows:
            pc = q(f"SELECT COUNT(*) AS c FROM products WHERE subsection_id={PH}", (r["id"],), one=True)
            out.append({"id": r["id"], "section_id": r["section_id"], "name": r["name"], "emoji": r.get("emoji") or "",
                        "image": r.get("image") or "", "active": bool(r.get("active")), "products_count": (pc or {}).get("c", 0)})
        return jsonify(out)

    @app.post("/api/admin/sections/<int:sid>/subsections")
    def adm_sub_add(sid):
        t, e = require_admin()
        if e:
            return e
        d = request.get_json(force=True, silent=True) or {}
        if not (d.get("name") or "").strip():
            return err("الاسم مطلوب")
        mx = q(f"SELECT COALESCE(MAX(sort_order),0) AS m FROM subsections WHERE section_id={PH}", (sid,), one=True)
        w(f"INSERT INTO subsections(section_id,name,emoji,sort_order) VALUES({PH},{PH},{PH},{PH})",
          (sid, d["name"].strip(), d.get("emoji") or "", int((mx or {}).get("m") or 0) + 1))
        return jsonify({"message": "تمت الإضافة"})

    @app.post("/api/admin/sections/<int:sid>/subsections/reorder")
    def adm_sub_reorder(sid):
        t, e = require_admin()
        if e:
            return e
        d = request.get_json(force=True, silent=True) or {}
        for i, x in enumerate(d.get("ids") or []):
            w(f"UPDATE subsections SET sort_order={PH} WHERE id={PH} AND section_id={PH}", (i, x, sid))
        return jsonify({"message": "تم"})

    @app.put("/api/admin/subsections/<int:xid>")
    def adm_sub_upd(xid):
        t, e = require_admin()
        if e:
            return e
        d = request.get_json(force=True, silent=True) or {}
        sets, args = [], []
        for k in ("name", "emoji", "image"):
            if k in d:
                sets.append(f"{k}={PH}"); args.append(d[k])
        if "active" in d:
            sets.append(f"active={PH}"); args.append(1 if d["active"] else 0)
        if not sets:
            return err("لا يوجد ما يُحدّث")
        args.append(xid)
        w(f"UPDATE subsections SET {','.join(sets)} WHERE id={PH}", tuple(args))
        return jsonify({"message": "تم الحفظ"})

    @app.delete("/api/admin/subsections/<int:xid>")
    def adm_sub_del(xid):
        t, e = require_admin()
        if e:
            return e
        w(f"UPDATE products SET subsection_id=NULL WHERE subsection_id={PH}", (xid,))
        w(f"DELETE FROM subsections WHERE id={PH}", (xid,))
        return jsonify({"message": "تم الحذف"})

    @app.post("/api/admin/subsections/<int:xid>/move")
    def adm_sub_move(xid):
        t, e = require_admin()
        if e:
            return e
        d = request.get_json(force=True, silent=True) or {}
        w(f"UPDATE subsections SET section_id={PH} WHERE id={PH}", (d.get("section_id"), xid))
        return jsonify({"message": "تم النقل"})

    @app.get("/api/admin/products")
    def adm_products():
        t, e = require_admin()
        if e:
            return e
        rows = q("SELECT p.*,s.name AS sname,par.name AS pname FROM products p LEFT JOIN subsections s ON s.id=p.subsection_id LEFT JOIN products par ON par.id=p.parent_id ORDER BY p.sort_order,p.id")
        out = []
        avail = product_availability_map([r["id"] for r in rows])
        for r in rows:
            cc = q(f"SELECT COUNT(*) AS c FROM skus WHERE product_id={PH}", (r["id"],), one=True)
            chc = q(f"SELECT COUNT(*) AS c FROM products WHERE parent_id={PH}", (r["id"],), one=True)
            out.append({"id": r["id"], "name": r["name"], "category": r.get("category") or "",
                        "subsection_name": r.get("sname") or "", "subsection_id": r.get("subsection_id"),
                        "parent_id": r.get("parent_id"), "parent_name": r.get("pname") or "",
                        "children_count": (chc or {}).get("c", 0),
                        "active": False if r.get("active") == 0 else True, "offer": r.get("offer") or "",
                        "available": avail.get(r["id"], True),
                        "image": r.get("image") or "", "emoji": r.get("emoji") or "", "notes": r.get("notes") or "",
                        "categories_count": (cc or {}).get("c", 0), "sort_order": r.get("sort_order") or 0})
        return jsonify(out)

    @app.post("/api/admin/products")
    def adm_product_add():
        t, e = require_admin()
        if e:
            return e
        d = request.get_json(force=True, silent=True) or {}
        if not (d.get("name") or "").strip():
            return err("الاسم مطلوب")
        try:
            parent_id = int(d.get("parent_id")) if d.get("parent_id") not in (None, "") else None
        except Exception:
            return err("منتج الأب غير صالح")
        sub_id = d.get("subsection_id")
        if parent_id:
            if not q(f"SELECT id FROM products WHERE id={PH} AND (parent_id IS NULL)", (parent_id,), one=True):
                return err("منتج الأب غير موجود")
            sub_id = None
        mx = q("SELECT COALESCE(MAX(sort_order),0) AS m FROM products", one=True)
        active = d.get("active", 1)
        try:
            active = 0 if str(active).strip().lower() in ("0", "false", "no", "off", "") else 1
        except Exception:
            active = 1
        pid = w(f"INSERT INTO products(name,category,emoji,subsection_id,notes,sort_order,parent_id,active,offer) VALUES({PH},{PH},{PH},{PH},{PH},{PH},{PH},{PH},{PH})",
                (d["name"].strip(), d.get("category") or "", d.get("emoji") or "", sub_id,
                 d.get("notes") or "", int((mx or {}).get("m") or 0) + 1, parent_id, active,
                 (d.get("offer") or "").strip()))
        log("admin", "product-add", d["name"], "")
        return jsonify({"message": "تمت الإضافة", "id": pid})

    @app.put("/api/admin/products/<int:pid>")
    def adm_product_upd(pid):
        t, e = require_admin()
        if e:
            return e
        d = request.get_json(force=True, silent=True) or {}
        sets, args = [], []
        for k in ("name", "category", "emoji", "image", "notes", "subsection_id", "sort_order", "parent_id", "offer"):
            if k in d:
                v = d[k]
                if k in ("subsection_id", "parent_id"):
                    if v in ("", None):
                        v = None
                    else:
                        try:
                            v = int(v)
                        except Exception:
                            return err("قيمة غير صالحة لحقل " + k)
                if k == "offer":
                    v = (v or "").strip()
                sets.append(f"{k}={PH}"); args.append(v)
        if "active" in d:
            a = d["active"]
            sets.append(f"active={PH}")
            args.append(0 if str(a).strip().lower() in ("0", "false", "no", "off", "") else 1)
        if not sets:
            return err("لا يوجد ما يُحدّث")
        if "parent_id" in d and d.get("parent_id") not in ("", None):
            try:
                new_parent = int(d["parent_id"])
            except Exception:
                return err("منتج الأب غير صالح")
            if new_parent == pid:
                return err("لا يمكن أن يكون المنتج أباً لنفسه")
            if not q(f"SELECT id FROM products WHERE id={PH} AND (parent_id IS NULL)", (new_parent,), one=True):
                return err("منتج الأب غير موجود")
            sets.append(f"subsection_id={PH}"); args.append(None)
        args.append(pid)
        w(f"UPDATE products SET {','.join(sets)} WHERE id={PH}", tuple(args))
        return jsonify({"message": "تم الحفظ"})

    @app.delete("/api/admin/products/<int:pid>")
    def adm_product_del(pid):
        t, e = require_admin()
        if e:
            return e
        w(f"UPDATE products SET parent_id=NULL WHERE parent_id={PH}", (pid,))
        w(f"DELETE FROM skus WHERE product_id={PH}", (pid,))
        w(f"DELETE FROM products WHERE id={PH}", (pid,))
        return jsonify({"message": "تم الحذف"})

    @app.post("/api/admin/products/<int:pid>/move")
    def adm_product_move(pid):
        t, e = require_admin()
        if e:
            return e
        d = request.get_json(force=True, silent=True) or {}
        if "direction" in d:
            cur = q(f"SELECT sort_order FROM products WHERE id={PH}", (pid,), one=True)
            w(f"UPDATE products SET sort_order={PH} WHERE id={PH}", (int((cur or {}).get("sort_order") or 0) + int(d["direction"]), pid))
        else:
            sets, args = [], []
            if "category" in d:
                sets.append(f"category={PH}"); args.append(d["category"])
            if "subsection_id" in d:
                sets.append(f"subsection_id={PH}"); args.append(d["subsection_id"])
            if "parent_id" in d:
                pv = d["parent_id"]
                try:
                    pv = None if pv in ("", None) else int(pv)
                except Exception:
                    return err("منتج الأب غير صالح")
                if pv == pid:
                    return err("لا يمكن أن يكون المنتج أباً لنفسه")
                sets.append(f"parent_id={PH}"); args.append(pv)
                if pv:
                    sets.append("subsection_id=NULL")
            if sets:
                args.append(pid)
                w(f"UPDATE products SET {','.join(sets)} WHERE id={PH}", tuple(args))
        return jsonify({"message": "تم"})

    @app.get("/api/admin/products/<int:pid>/categories")
    def adm_skus(pid):
        t, e = require_admin()
        if e:
            return e
        rows = q(f"SELECT s.*,p2.name AS pname FROM skus s LEFT JOIN providers p2 ON p2.id=s.provider_id WHERE s.product_id={PH} ORDER BY s.price_usd,s.id", (pid,))
        return jsonify([{"id": r["id"], "name": r["name"], "price_usd": float(r.get("price_usd") or 0),
                         "unit_qty": r.get("unit_qty") or 1, "min_qty": r.get("min_qty") or 1, "max_qty": r.get("max_qty") or 0,
                         "stock_qty": r.get("stock_qty"), "requires_id": bool(r.get("requires_id")),
                         "linked": bool(r.get("provider_id")), "provider_name": r.get("pname") or "",
                         "api_product_id": r.get("api_product_id") or "", "image": r.get("image") or ""} for r in rows])

    @app.post("/api/admin/products/<int:pid>/categories")
    def adm_sku_add(pid):
        t, e = require_admin()
        if e:
            return e
        d = request.get_json(force=True, silent=True) or {}
        if not (d.get("name") or "").strip():
            return err("الاسم مطلوب")
        try:
            price = float(d.get("price"))
        except Exception:
            return err("السعر غير صحيح")
        pub = str(d.get("public_id") or "").strip() or ("P%06d" % (secrets.randbelow(900000) + 100000))
        if q(f"SELECT id FROM skus WHERE public_id={PH}", (pub,), one=True):
            pub = "P%06d" % (secrets.randbelow(900000) + 100000)
        try:
            cost = float(d.get("cost_usd") or 0)
        except Exception:
            cost = 0
        try:
            marg = float(d.get("margin_percent") or 0)
        except Exception:
            marg = 0
        sid = w(f"INSERT INTO skus(product_id,name,price_usd,public_id,type,unit_qty,min_qty,max_qty,stock_qty,requires_id,provider_id,api_product_id,cost_usd,margin_percent) VALUES({PH},{PH},{PH},{PH},{PH},{PH},{PH},{PH},{PH},{PH},{PH},{PH},{PH},{PH})",
          (pid, d["name"].strip(), price, pub, d.get("type") or "default", int(d.get("unit_qty") or 1),
           int(d.get("min_qty") or 1), int(d.get("max_qty") or 0),
           None if d.get("stock_qty") in (None, "") else int(d.get("stock_qty")),
           0 if d.get("requires_id") is False else 1, d.get("provider_id"), d.get("api_product_id"), cost, marg))
        return jsonify({"message": "تمت الإضافة", "id": sid})

    @app.put("/api/admin/categories/<cid>")
    def adm_sku_upd(cid):
        t, e = require_admin()
        if e:
            return e
        d = request.get_json(force=True, silent=True) or {}
        sets, args = [], []
        for k in ("name", "price_usd", "type", "unit_qty", "min_qty", "max_qty", "stock_qty", "requires_id",
                  "provider_id", "api_product_id", "cost_usd", "margin_percent", "image", "available", "public_id"):
            if k in d:
                v = d[k]
                if k == "requires_id":
                    v = 0 if v is False else 1
                if k == "available":
                    v = 1 if v else 0
                sets.append(f"{k}={PH}"); args.append(v)
        if "price" in d and "price_usd" not in d:
            sets.append(f"price_usd={PH}"); args.append(float(d["price"]))
        if not sets:
            return err("لا يوجد ما يُحدّث")
        args.append(cid)
        w(f"UPDATE skus SET {','.join(sets)} WHERE id={PH}", tuple(args))
        return jsonify({"message": "تم الحفظ"})

    @app.delete("/api/admin/categories/<cid>")
    def adm_sku_del(cid):
        t, e = require_admin()
        if e:
            return e
        w(f"DELETE FROM skus WHERE id={PH}", (cid,))
        return jsonify({"message": "تم الحذف"})

    @app.get("/api/admin/categories/all-pricing")
    def adm_pricing():
        t, e = require_admin()
        if e:
            return e
        rows = q("SELECT s.*,p.name AS pname,p2.name AS prov FROM skus s LEFT JOIN products p ON p.id=s.product_id LEFT JOIN providers p2 ON p2.id=s.provider_id ORDER BY p.name,s.price_usd")
        return jsonify([{"id": r["id"], "product_name": r.get("pname") or "", "name": r["name"],
                         "linked": bool(r.get("provider_id")), "token_ok": True, "provider_name": r.get("prov") or "",
                         "cost_usd": float(r.get("cost_usd") or 0), "margin_percent": float(r.get("margin_percent") or 0),
                         "price_usd": float(r.get("price_usd") or 0)} for r in rows])

    @app.post("/api/admin/categories/apply-margin")
    def adm_margin():
        t, e = require_admin()
        if e:
            return e
        d = request.get_json(force=True, silent=True) or {}
        try:
            m = float(d.get("margin_percent") or 0)
        except Exception:
            return err("النسبة غير صحيحة")
        ids = d.get("category_ids") or []
        if not ids:
            return err("اختر باقات")
        for cid in ids:
            s = q(f"SELECT * FROM skus WHERE id={PH}", (cid,), one=True)
            if s and s.get("provider_id") and float(s.get("cost_usd") or 0) > 0:
                w(f"UPDATE skus SET margin_percent={PH},price_usd={PH} WHERE id={PH}",
                  (m, round(float(s["cost_usd"]) * (1 + m / 100), 2), cid))
        return jsonify({"message": "تم تطبيق الهامش"})

    @app.get("/api/admin/categories/<cid>/link")
    def adm_link_get(cid):
        t, e = require_admin()
        if e:
            return e
        s = q(f"SELECT * FROM skus WHERE id={PH}", (cid,), one=True)
        if not s:
            return err("غير موجود", 404)
        return jsonify({"status": {"linked": bool(s.get("provider_id")), "api_product_id": s.get("api_product_id") or "",
                                   "provider_id": s.get("provider_id")}})

    @app.post("/api/admin/categories/<cid>/link")
    def adm_link_set(cid):
        t, e = require_admin()
        if e:
            return e
        d = request.get_json(force=True, silent=True) or {}
        w(f"UPDATE skus SET provider_id={PH},api_product_id={PH} WHERE id={PH}",
          (d.get("provider_id"), d.get("provider_product"), cid))
        return jsonify({"message": "تم الربط"})

    @app.delete("/api/admin/categories/<cid>/link")
    def adm_link_del(cid):
        t, e = require_admin()
        if e:
            return e
        w(f"UPDATE skus SET provider_id=NULL,api_product_id='' WHERE id={PH}", (cid,))
        return jsonify({"message": "تم فك الربط"})

    # ============ ADMIN DEPOSIT METHODS ============
    @app.get("/api/admin/deposit-methods")
    def adm_dep_methods():
        t, e = require_admin()
        if e:
            return e
        auto = [dict(r) for r in q("SELECT * FROM dep_auto ORDER BY id")]
        manual = [dict(r) for r in q("SELECT * FROM dep_manual ORDER BY id")]
        return jsonify({"auto": auto, "manual": manual})

    @app.post("/api/admin/deposit-methods/auto")
    def adm_dep_auto_add():
        t, e = require_admin()
        if e:
            return e
        d = request.get_json(force=True, silent=True) or {}
        if not (d.get("title") or "").strip():
            return err("العنوان مطلوب")
        w(f"INSERT INTO dep_auto(title,description,api_token,api_url,gateway_type,input_currency) VALUES({PH},{PH},{PH},{PH},{PH},{PH})",
          (d["title"].strip(), d.get("description") or "", d.get("api_token") or "", d.get("api_url") or "",
           d.get("gateway_type") or "", d.get("input_currency") or "usd"))
        return jsonify({"message": "تمت الإضافة"})

    @app.delete("/api/admin/deposit-methods/auto/<int:mid>")
    def adm_dep_auto_del(mid):
        t, e = require_admin()
        if e:
            return e
        w(f"DELETE FROM dep_auto WHERE id={PH}", (mid,))
        return jsonify({"message": "تم الحذف"})

    @app.post("/api/admin/deposit-methods/manual")
    def adm_dep_man_add():
        t, e = require_admin()
        if e:
            return e
        d = request.get_json(force=True, silent=True) or {}
        if not (d.get("title") or "").strip():
            return err("العنوان مطلوب")
        w(f"INSERT INTO dep_manual(title,code,description,input_currency) VALUES({PH},{PH},{PH},{PH})",
          (d["title"].strip(), d.get("code") or "", d.get("description") or "", d.get("input_currency") or "usd"))
        return jsonify({"message": "تمت الإضافة"})

    @app.delete("/api/admin/deposit-methods/manual/<int:mid>")
    def adm_dep_man_del(mid):
        t, e = require_admin()
        if e:
            return e
        w(f"DELETE FROM dep_manual WHERE id={PH}", (mid,))
        return jsonify({"message": "تم الحذف"})

    @app.put("/api/admin/deposit-methods/manual/<int:mid>")
    @app.put("/api/admin/deposit-methods/auto/<int:mid>")
    def adm_dep_method_upd(mid):
        t, e = require_admin()
        if e:
            return e
        d = request.get_json(force=True, silent=True) or {}
        table = "dep_manual" if "manual" in request.path else "dep_auto"
        sets, args = [], []
        for k in ("title", "name", "code", "description", "input_currency", "gateway_type", "api_token", "api_url", "image"):
            if k in d:
                col = "title" if k == "name" else k
                sets.append(f"{col}={PH}"); args.append(d[k])
        if not sets:
            return err("لا يوجد ما يُحدّث")
        args.append(mid)
        w(f"UPDATE {table} SET {','.join(sets)} WHERE id={PH}", tuple(args))
        return jsonify({"message": "تم الحفظ"})

    # ============ ADMIN PROVIDERS ============
    @app.get("/api/admin/providers")
    def adm_provs():
        t, e = require_admin()
        if e:
            return e
        rows = q("SELECT * FROM providers ORDER BY id")
        out = []
        for r in rows:
            lc = q(f"SELECT COUNT(*) AS c FROM skus WHERE provider_id={PH}", (r["id"],), one=True)
            out.append({"id": r["id"], "name": r["name"], "has_token": bool(r.get("token")),
                        "api_url": r.get("url") or "", "balance": r.get("balance_manual") or "",
                        "balance_at": r.get("balance_cached_at") or "", "linked_products": (lc or {}).get("c", 0)})
        return jsonify(out)

    @app.post("/api/admin/providers")
    def adm_prov_add():
        t, e = require_admin()
        if e:
            return e
        d = request.get_json(force=True, silent=True) or {}
        if not (d.get("name") or "").strip():
            return err("الاسم مطلوب")
        w(f"INSERT INTO providers(name,token,url,order_path,status_path,catalog_path,balance_path) VALUES({PH},{PH},{PH},{PH},{PH},{PH},{PH})",
          (d["name"].strip(), d.get("token") or "", d.get("url") or "", d.get("order_path") or "order",
           d.get("status_path") or "status", d.get("catalog_path") or "products", d.get("balance_path") or "balance"))
        return jsonify({"message": "تمت الإضافة"})

    @app.delete("/api/admin/providers/<int:pid>")
    def adm_prov_del(pid):
        t, e = require_admin()
        if e:
            return e
        w(f"UPDATE skus SET provider_id=NULL WHERE provider_id={PH}", (pid,))
        w(f"DELETE FROM providers WHERE id={PH}", (pid,))
        return jsonify({"message": "تم الحذف"})

    @app.get("/api/admin/providers/<int:pid>/balance")
    def adm_prov_bal(pid):
        t, e = require_admin()
        if e:
            return e
        p = q(f"SELECT * FROM providers WHERE id={PH}", (pid,), one=True)
        if not p:
            return err("غير موجود", 404)
        info, msg = provider_call(p, "balance", {})
        tried = [{"url": (p.get("url") or "") + "/" + (p.get("balance_path") or ""), "result": ("ok" if info else msg)}]
        if info:
            bal = str(info.get("balance") or info.get("amount") or "")
            w(f"UPDATE providers SET balance_manual={PH},balance_cached_at={PH} WHERE id={PH}", (bal, NOW(), pid))
            return jsonify({"ok": True, "balance": bal, "cached_at": NOW(), "tried": tried, "note": ""})
        return jsonify({"ok": False, "balance": p.get("balance_manual") or "", "cached_at": p.get("balance_cached_at") or "",
                        "tried": tried, "note": msg})

    @app.post("/api/admin/providers/<int:pid>/balance-manual")
    def adm_prov_bal_man(pid):
        t, e = require_admin()
        if e:
            return e
        d = request.get_json(force=True, silent=True) or {}
        w(f"UPDATE providers SET balance_manual={PH},balance_cached_at={PH} WHERE id={PH}", (str(d.get("balance") or ""), NOW(), pid))
        return jsonify({"message": "تم الحفظ"})

    @app.post("/api/admin/providers/<int:pid>/test")
    def adm_prov_test(pid):
        t, e = require_admin()
        if e:
            return e
        p = q(f"SELECT * FROM providers WHERE id={PH}", (pid,), one=True)
        if not p:
            return err("غير موجود", 404)
        checks, bal, bal_note, tried, found = [], "", "", [], 0
        for kind, label in (("balance", "الرصيد"), ("catalog", "الكتالوج")):
            info, msg = provider_call(p, kind, {})
            ok = bool(info)
            checks.append({"label": label, "verdict": "ok" if ok else "fail", "url": (p.get("url") or "") + "/" + (p.get(kind + "_path") or "")})
            tried.append({"url": checks[-1]["url"], "result": "ok" if ok else msg})
            if kind == "balance" and info:
                bal = str(info.get("balance") or "")
            if kind == "catalog" and info:
                items = info.get("products") or info.get("items") or (info if isinstance(info, list) else [])
                found = len(items) if isinstance(items, list) else 0
        order_url = (p.get("url") or "") + "/" + (p.get("order_path") or "")
        return jsonify({"message": "اكتمل الفحص", "checks": checks, "balance": bal, "balance_note": bal_note,
                        "balance_tried": tried, "products_found": found, "order_url": order_url})

    @app.get("/api/admin/providers/<int:pid>/products")
    def adm_prov_prods(pid):
        t, e = require_admin()
        if e:
            return e
        p = q(f"SELECT * FROM providers WHERE id={PH}", (pid,), one=True)
        if not p:
            return err("غير موجود", 404)
        info, msg = provider_call(p, "catalog", {})
        if not info:
            return err("تعذر جلب الكتالوج: " + msg)
        items = info.get("products") or info.get("items") or (info if isinstance(info, list) else [])
        return jsonify([{"id": str(x.get("id")), "name": x.get("name"), "price": x.get("price")} for x in (items[:200] if isinstance(items, list) else [])])

    @app.get("/api/admin/providers/<int:pid>/products/export")
    def adm_prov_export(pid):
        t, e = require_admin()
        if e:
            return e
        p = q(f"SELECT * FROM providers WHERE id={PH}", (pid,), one=True)
        info, _ = provider_call(p or {}, "catalog", {})
        items = (info or {}).get("products") or []
        buf = io.StringIO()
        wr = csv.writer(buf)
        wr.writerow(["id", "name", "price"])
        for x in (items if isinstance(items, list) else []):
            wr.writerow([x.get("id"), x.get("name"), x.get("price")])
        return app.response_class(buf.getvalue(), mimetype="text/csv",
                                  headers={"Content-Disposition": f"attachment;filename=provider-{pid}.csv"})

    @app.post("/api/admin/providers/<int:pid>/import-catalog")
    def adm_prov_import(pid):
        t, e = require_admin()
        if e:
            return e
        d = request.get_json(force=True, silent=True) or {}
        try:
            margin = float(d.get("margin_percent") or 0)
        except Exception:
            margin = 0
        p = q(f"SELECT * FROM providers WHERE id={PH}", (pid,), one=True)
        info, msg = provider_call(p or {}, "catalog", {})
        if not info:
            return err("تعذر جلب الكتالوج: " + msg)
        items = info.get("products") or []
        n = 0
        for x in (items if isinstance(items, list) else []):
            try:
                cost = float(x.get("price") or 0)
            except Exception:
                continue
            prod = q(f"SELECT id FROM products WHERE name={PH}", (str(x.get("category") or x.get("name")),), one=True)
            if not prod:
                prod_id = w(f"INSERT INTO products(name,category,sort_order) VALUES({PH},{PH},0)",
                            (str(x.get("category") or "مستورد"), str(x.get("category") or "")))
            else:
                prod_id = prod["id"]
            pub = "P%06d" % (secrets.randbelow(900000) + 100000)
            w(f"INSERT INTO skus(product_id,name,price_usd,public_id,provider_id,api_product_id,cost_usd,margin_percent) VALUES({PH},{PH},{PH},{PH},{PH},{PH},{PH},{PH})",
              (prod_id, str(x.get("name")), round(cost * (1 + margin / 100), 2), pub, pid, str(x.get("id")), cost, margin))
            n += 1
        return jsonify({"message": f"تم استيراد {n} منتجاً"})

    @app.post("/api/admin/providers/import-file")
    def adm_prov_import_file():
        t, e = require_admin()
        if e:
            return e
        f = request.files.get("file")
        if not f:
            return err("الملف مطلوب")
        try:
            margin = float(request.form.get("margin") or 0)
        except Exception:
            margin = 0
        name, token, url = request.form.get("name") or "مستورد", request.form.get("token") or "", request.form.get("url") or ""
        grouping = request.form.get("grouping") or "category"
        pid = w(f"INSERT INTO providers(name,token,url,order_path,status_path,catalog_path,balance_path) VALUES({PH},{PH},{PH},'order','status','products','balance')",
                (name, token, url))
        try:
            data = f.read().decode("utf-8-sig")
        except Exception:
            return err("تعذر قراءة الملف")
        rows = list(csv.DictReader(io.StringIO(data)))
        imported, skipped, dups, seen_secs = 0, 0, 0, set()
        for r in rows[:5000]:
            nm = (r.get("name") or "").strip()
            if not nm:
                skipped += 1
                continue
            if q(f"SELECT id FROM skus WHERE name={PH} AND provider_id={PH}", (nm, pid), one=True):
                dups += 1
                continue
            sec = (r.get("category") or r.get("section") or "مستورد").strip()
            seen_secs.add(sec)
            prod = q(f"SELECT id FROM products WHERE name={PH}", (sec,), one=True)
            prod_id = prod["id"] if prod else w(f"INSERT INTO products(name,category,sort_order) VALUES({PH},{PH},0)", (sec, sec))
            try:
                cost = float(r.get("price") or 0)
            except Exception:
                cost = 0
            pub = "P%06d" % (secrets.randbelow(900000) + 100000)
            w(f"INSERT INTO skus(product_id,name,price_usd,public_id,provider_id,api_product_id,cost_usd,margin_percent) VALUES({PH},{PH},{PH},{PH},{PH},{PH},{PH},{PH})",
              (prod_id, nm, round(cost * (1 + margin / 100), 2), pub, pid, r.get("id") or "", cost, margin))
            imported += 1
        return jsonify({"imported": imported, "skipped": skipped, "duplicates": dups, "sections": sorted(seen_secs)})

    def clean_img_base(base):
        """Strips empty trailing prompt/key params from a saved image-API URL."""
        base = (base or "").strip()
        base = re.sub(r"[?&]prompt=$", "", base)
        return base

    # ============ ADMIN AI IMAGE (smart two-step luxury generation) ============
    BRAND_LOCK = ("Brand lock (apply strictly for a consistent ARAB STORE identity): deep navy background #0b0f19, "
                  "red neon glow accents #ff1a3c, rich gold highlights #ffc24b, premium glassmorphism showcase card "
                  "in the center, floating golden particles and light streaks, small gold 'AS' store logo badge in "
                  "the top-left corner, huge bold centered uppercase English title, ultra detailed, sharp focus, "
                  "high contrast, 8k commercial quality, absolutely no Arabic text, no watermark")

    def game_visual_brief(name, kind):
        """Step 1: ask the chat AI for English title + visual identity. Returns (title_en, brief)."""
        api_url = get_setting("ai_agent_api_url", "")
        api_key = get_setting("ai_agent_api_key", "")
        if not api_url:
            return "", ""
        import urllib.request as _url
        try:
            msgs = [{"role": "system", "content": "You are a game art director. English only, no Arabic."},
                    {"role": "user", "content": ("For cover art of this game/product: '%s' (%s). Reply with exactly two lines: "
                                                 "line 1 = OFFICIAL English game title in UPPERCASE (no Arabic, no extra words); "
                                                 "line 2 = iconic visual identity: main logo emblem, 2-3 iconic items/characters, "
                                                 "dominant colors. Max 30 words." % (name, kind))}]
            payload = json.dumps({"model": get_setting("ai_agent_model", "") or "openai/gpt-5-mini",
                                  "messages": msgs}).encode()
            req = _url.Request(api_url, data=payload,
                               headers={"Content-Type": "application/json", "User-Agent": "ARAB-STORE/1.0",
                                        **({"Authorization": "Bearer " + api_key} if api_key else {})})
            with _url.urlopen(req, timeout=30) as r2:
                info = json.loads(r2.read().decode() or "{}")
            text = ((info.get("choices") or [{}])[0].get("message") or {}).get("content") or ""
            lines = [ln.strip() for ln in text.strip().split("\n") if ln.strip()]
            title_en = "".join(ch for ch in (lines[0] if lines else "") if ord(ch) < 128).strip().upper()[:60]
            brief = " ".join((lines[1] if len(lines) > 1 else "").split())[:400]
            if not title_en:
                title_en = "".join(ch for ch in name if ord(ch) < 128).strip().upper()[:60]
            return title_en, brief
        except Exception:
            return "", ""

    # (moved to module level: store_logo_bytes, composite_store_logo)

    def section_visual_brief(name):
        """Section identity: English title + relevant real app names. Returns (title_en, apps)."""
        api_url = get_setting("ai_agent_api_url", "")
        api_key = get_setting("ai_agent_api_key", "")
        if not api_url:
            return "", ""
        import urllib.request as _url
        try:
            msgs = [{"role": "system", "content": "You are a mobile industry expert. English only, no Arabic."},
                    {"role": "user", "content": ("This is a digital store section named '%s'. Reply with exactly two lines: "
                                                 "line 1 = short ENGLISH section title in UPPERCASE (translate the meaning, max 4 words); "
                                                 "line 2 = comma-separated list of 10 real famous app/service/game names that belong "
                                                 "in this category (original exact names only)." % name)}]
            payload = json.dumps({"model": get_setting("ai_agent_model", "") or "openai/gpt-5-mini",
                                  "messages": msgs}).encode()
            req = _url.Request(api_url, data=payload,
                               headers={"Content-Type": "application/json", "User-Agent": "ARAB-STORE/1.0",
                                        **({"Authorization": "Bearer " + api_key} if api_key else {})})
            with _url.urlopen(req, timeout=30) as r2:
                info = json.loads(r2.read().decode() or "{}")
            text = ((info.get("choices") or [{}])[0].get("message") or {}).get("content") or ""
            lines = [ln.strip() for ln in text.strip().split("\n") if ln.strip()]
            title_en = "".join(ch for ch in (lines[0] if lines else "") if ord(ch) < 128).strip().upper()[:40]
            apps = " ".join((lines[1] if len(lines) > 1 else "").split())[:400]
            return title_en, apps
        except Exception:
            return "", ""

    def build_luxury_prompt(name, kind):
        if kind in ("section", "subsection"):
            # Phone-mockup section style: device full of the section's real apps + big English title
            title_en, apps = section_visual_brief(name)
            title_en = title_en or "".join(ch for ch in name if ord(ch) < 128).strip().upper()[:40] or "STORE"
            prompt = ("Premium smartphone product shot floating in three-quarter view, screen facing viewer, "
                      "displaying a grid of ORIGINAL authentic app icons: %s. "
                      "Dark red and black tech background with subtle grid lines, floating red translucent glass "
                      "shards, soft red glow and light streaks. "
                      "Huge bold 3D English title \"%s\" at the top in glossy white with subtle depth. " %
                      (apps or title_en, title_en))
            prompt += ("IMPORTANT: English text only — absolutely no Arabic text anywhere on the image. "
                       "Leave the top-left corner clean and empty (store badge added separately). "
                       "Ultra detailed commercial quality, sharp focus, vibrant, 8k, no watermark")
            return prompt
        if kind == "product":
            # Game-first cover style: hero + ORIGINAL logo. English text only, unified logo added later by us.
            title_en, brief = game_visual_brief(name, kind)
            title_en = title_en or "".join(ch for ch in name if ord(ch) < 128).strip().upper()[:60] or "GAME"
            prompt = ("Official %s mobile game cover art: iconic hero character in dynamic action pose, "
                      "authentic game world battleground background, dramatic cinematic lighting. "
                      "The ORIGINAL authentic official game logo emblem displayed large and centered "
                      "prominently in exact official style and colors, with the English title \"%s\" "
                      "written big and beautiful beneath it. " % (name, title_en))
            if brief:
                prompt += "Game identity details: " + brief + ". "
            prompt += ("IMPORTANT: English text only — absolutely no Arabic text anywhere. "
                       "Leave the top-left corner clean and empty (store badge added separately). "
                       "Ultra detailed AAA game key art, sharp focus, vibrant colors, 8k commercial quality, "
                       "no other text, no watermark")
            return prompt
        tmpl = get_setting("ai_image_prompt_template", "") or "Epic luxury dark gaming store hero artwork for {name}"
        prompt = tmpl.replace("{name}", name)
        _title_en, _brief = game_visual_brief(name, kind)
        if _brief:
            prompt += " | Game identity: " + _brief
        prompt += " | " + BRAND_LOCK.replace("uppercase English title",
                                             "uppercase English title \"%s\"" % name.upper())
        return prompt

    def gen_image_url(prompt):
        """Step 2: call the image service, then stamp the unified store logo top-left.
        Returns (url, error). Final image is stored permanently in our DB."""
        import urllib.request as _url
        import urllib.error as _ue
        base = clean_img_base(get_setting("ai_image_api_url", ""))
        key = get_setting("ai_image_api_key", "")
        if not base:
            return "", "عيّن رابط خدمة توليد الصور أولاً من الإعدادات"
        last_err = ""
        for _ in range(2):
            try:
                sep = "&" if "?" in base else "?"
                req = _url.Request(base + sep + "prompt=" + __import__("urllib.parse", fromlist=["quote"]).quote(prompt) +
                                   (("&key=" + key) if key and "key=" not in base else ""),
                                   headers={"User-Agent": "ARAB-STORE/1.0"})
                with _url.urlopen(req, timeout=90) as r2:
                    info = json.loads(r2.read().decode() or "{}")
                url = info.get("url") or info.get("image") or ""
                if not url:
                    last_err = "الخدمة لم ترجع صورة"
                    continue
                # download + stamp unified store logo + compress for slow networks
                try:
                    stamp_req = _url.Request(url, headers={"User-Agent": "ARAB-STORE/1.0"})
                    with _url.urlopen(stamp_req, timeout=40) as r3:
                        raw = r3.read()
                    stamped = composite_store_logo(raw)
                    if stamped:
                        opt, oext, omime = optimize_image(stamped, "final.png")
                        if opt:
                            nm = "as-" + secrets.token_hex(8) + oext
                            w(f"INSERT INTO blob_files(name,data,mime) VALUES({PH},{PH},{PH})",
                              (nm, __import__("base64").b64encode(opt).decode(), omime))
                            return "/uploads/" + nm, ""
                    # fallback: optimize original without logo stamp
                    opt, oext, omime = optimize_image(raw, "final.png")
                    if opt:
                        nm = "as-" + secrets.token_hex(8) + oext
                        w(f"INSERT INTO blob_files(name,data,mime) VALUES({PH},{PH},{PH})",
                          (nm, __import__("base64").b64encode(opt).decode(), omime))
                        return "/uploads/" + nm, ""
                except Exception:
                    pass
                return url, ""
            except _ue.HTTPError as ex:
                try:
                    last_err = ex.read().decode('utf-8', 'ignore')[:200]
                except Exception:
                    last_err = f"HTTP {ex.code}"
            except Exception as ex:
                last_err = str(ex)[:150]
        return "", ("فشل التوليد: " + (last_err or "تعذر الاتصال"))

    @app.post("/api/admin/ai-image/generate")
    def adm_ai_gen():
        t, e = require_admin()
        if e:
            return e
        d = request.get_json(force=True, silent=True) or {}
        kind, name = d.get("kind") or "product", (d.get("name") or "").strip()
        if not name:
            return err("الاسم مطلوب")
        prompt = build_luxury_prompt(name, kind)
        url, error = gen_image_url(prompt)
        if not url:
            return err(error)
        return jsonify({"url": url, "message": "تم التوليد الفاخر ✨", "name_en": name, "prompt": prompt, "brand": {}})

    @app.post("/api/admin/ai-image/apply")
    def adm_ai_apply():
        t, e = require_admin()
        if e:
            return e
        d = request.get_json(force=True, silent=True) or {}
        kind, url = d.get("kind"), d.get("url") or ""
        try:
            iid = int(d.get("id"))
        except Exception:
            return err("id غير صالح")
        table = {"section": "sections", "product": "products", "category": "skus", "subsection": "subsections"}.get(kind)
        if not table or not url:
            return err("بيانات غير صالحة")
        w(f"UPDATE {table} SET image={PH} WHERE id={PH}", (url, iid))
        return jsonify({"message": "تم التطبيق"})

    # ============ ADMIN USERS / TIERS ============
    @app.get("/api/admin/users")
    def adm_users():
        t, e = require_admin()
        if e:
            return e
        rows = q("SELECT * FROM users ORDER BY id DESC LIMIT 500")
        out = []
        for r in rows:
            tr = q(f"SELECT name FROM tiers WHERE id={PH}", (r.get("discount_tier_id") or 0,), one=True)
            out.append({"web_id": r["id"], "name": r.get("name"), "email": r.get("email"), "phone": r.get("phone") or "",
                        "site_user_id": r["id"], "balance_syp": round(float(r.get("balance_usd") or 0) * rate(), 2),
                        "discount_tier_id": r.get("discount_tier_id"), "discount_tier_name": (tr or {}).get("name"),
                        "blocked": bool(r.get("blocked")), "api_enabled": bool(r.get("api_enabled")),
                        "api_key": r.get("api_key") or ""})
        return jsonify(out)

    @app.get("/api/admin/users/<int:uid>/details")
    def adm_user_det(uid):
        t, e = require_admin()
        if e:
            return e
        u = q(f"SELECT * FROM users WHERE id={PH}", (uid,), one=True)
        if not u:
            return err("غير موجود", 404)
        tot = q(f"SELECT COALESCE(SUM(price_usd),0) AS s, COUNT(*) AS c FROM orders WHERE user_id={PH} AND status IN ('accepted','completed')", (uid,), one=True) or {}
        rec = q(f"SELECT id,product_name,qty,price_usd,status,created_at AS date FROM orders WHERE user_id={PH} ORDER BY id DESC LIMIT 10", (uid,))
        return jsonify({"name": u.get("name"), "email": u.get("email"),
                        "total_profit_usd": 0, "total_orders": int(tot.get("c") or 0),
                        "total_spent_usd": round(float(tot.get("s") or 0), 2),
                        "balance_usd": round(float(u.get("balance_usd") or 0), 2),
                        "recent_orders": [{"id": r["id"], "product_name": r.get("product_name") or "", "qty": r.get("qty") or 1,
                                           "price_usd": float(r.get("price_usd") or 0), "status": r.get("status"),
                                           "date": r.get("date") or ""} for r in rec]})

    @app.post("/api/admin/users/<int:uid>/balance")
    def adm_user_bal(uid):
        t, e = require_admin()
        if e:
            return e
        d = request.get_json(force=True, silent=True) or {}
        try:
            amt = float(d.get("amount") or 0)
        except Exception:
            return err("المبلغ غير صحيح")
        if amt <= 0:
            return err("المبلغ غير صحيح")
        if d.get("action") == "deduct":
            amt = -amt
        w(f"UPDATE users SET balance_usd=balance_usd+{PH} WHERE id={PH}", (amt, uid))
        add_activity(uid, "balance", "info", f"تعديل رصيد من الإدارة: {amt:+.2f}$", "", "admin")
        log("admin", "balance", str(uid), str(amt))
        return jsonify({"message": "تم"})

    @app.post("/api/admin/users/<int:uid>/discount-tier")
    def adm_user_tier(uid):
        t, e = require_admin()
        if e:
            return e
        d = request.get_json(force=True, silent=True) or {}
        tid = int(d.get("tier_id") or 0) or None
        w(f"UPDATE users SET discount_tier_id={PH} WHERE id={PH}", (tid, uid))
        return jsonify({"message": "تم"})

    @app.post("/api/admin/users/<int:uid>/block")
    def adm_user_block(uid):
        t, e = require_admin()
        if e:
            return e
        w(f"UPDATE users SET blocked=1 WHERE id={PH}", (uid,))
        return jsonify({"message": "تم الحظر"})

    @app.post("/api/admin/users/<int:uid>/unblock")
    def adm_user_unblock(uid):
        t, e = require_admin()
        if e:
            return e
        w(f"UPDATE users SET blocked=0 WHERE id={PH}", (uid,))
        return jsonify({"message": "تم فك الحظر"})

    @app.post("/api/admin/users/<int:uid>/api/enable")
    def adm_user_api_en(uid):
        t, e = require_admin()
        if e:
            return e
        u = q(f"SELECT api_key FROM users WHERE id={PH}", (uid,), one=True)
        key = (u or {}).get("api_key") or ("ak_" + secrets.token_hex(16))
        w(f"UPDATE users SET api_enabled=1,api_key={PH} WHERE id={PH}", (key, uid))
        return jsonify({"message": "تم التفعيل"})

    @app.post("/api/admin/users/<int:uid>/api/disable")
    def adm_user_api_dis(uid):
        t, e = require_admin()
        if e:
            return e
        w(f"UPDATE users SET api_enabled=0 WHERE id={PH}", (uid,))
        return jsonify({"message": "تم التعطيل"})

    @app.post("/api/admin/users/<int:uid>/api/regenerate")
    def adm_user_api_reg(uid):
        t, e = require_admin()
        if e:
            return e
        w(f"UPDATE users SET api_key={PH} WHERE id={PH}", ("ak_" + secrets.token_hex(16), uid))
        return jsonify({"message": "تم توليد مفتاح جديد"})

    @app.get("/api/admin/discount-tiers")
    def adm_tiers():
        t, e = require_admin()
        if e:
            return e
        return jsonify([dict(r) for r in q("SELECT * FROM tiers ORDER BY sort_order,min_spent")])

    @app.post("/api/admin/discount-tiers")
    def adm_tier_add():
        t, e = require_admin()
        if e:
            return e
        d = request.get_json(force=True, silent=True) or {}
        w(f"INSERT INTO tiers(name,percent,min_spent,sort_order) VALUES({PH},{PH},{PH},{PH})",
          ((d.get("name") or "").strip(), float(d.get("percent") or 0), float(d.get("min_spent") or 0), int(d.get("sort_order") or 0)))
        return jsonify({"message": "تمت الإضافة"})

    @app.put("/api/admin/discount-tiers/<int:tid>")
    def adm_tier_upd(tid):
        t, e = require_admin()
        if e:
            return e
        d = request.get_json(force=True, silent=True) or {}
        sets, args = [], []
        for k in ("name", "percent", "min_spent", "sort_order"):
            if k in d:
                sets.append(f"{k}={PH}"); args.append(d[k])
        if not sets:
            return err("لا يوجد ما يُحدّث")
        args.append(tid)
        w(f"UPDATE tiers SET {','.join(sets)} WHERE id={PH}", tuple(args))
        return jsonify({"message": "تم الحفظ"})

    @app.delete("/api/admin/discount-tiers/<int:tid>")
    def adm_tier_del(tid):
        t, e = require_admin()
        if e:
            return e
        w(f"UPDATE users SET discount_tier_id=NULL WHERE discount_tier_id={PH}", (tid,))
        w(f"DELETE FROM tier_matrix WHERE tier_id={PH}", (tid,))
        w(f"DELETE FROM tiers WHERE id={PH}", (tid,))
        return jsonify({"message": "تم الحذف"})

    @app.get("/api/admin/tier-section-discounts")
    def adm_matrix_get():
        t, e = require_admin()
        if e:
            return e
        tiers = [dict(r) for r in q("SELECT * FROM tiers ORDER BY sort_order")]
        secs = [r["name"] for r in q("SELECT name FROM sections ORDER BY sort_order")]
        mat = {}
        for r in q("SELECT tier_id,section,percent FROM tier_matrix"):
            mat.setdefault(str(r["tier_id"]), {})[r["section"]] = float(r["percent"])
        return jsonify({"tiers": tiers, "sections": secs, "matrix": mat})

    @app.post("/api/admin/tier-section-discounts")
    def adm_matrix_set():
        t, e = require_admin()
        if e:
            return e
        d = request.get_json(force=True, silent=True) or {}
        if d.get("percent") is None:
            w(f"DELETE FROM tier_matrix WHERE tier_id={PH} AND section={PH}", (d.get("tier_id"), d.get("section")))
        elif q(f"SELECT 1 FROM tier_matrix WHERE tier_id={PH} AND section={PH}", (d.get("tier_id"), d.get("section")), one=True):
            w(f"UPDATE tier_matrix SET percent={PH} WHERE tier_id={PH} AND section={PH}",
              (float(d["percent"]), d.get("tier_id"), d.get("section")))
        else:
            w(f"INSERT INTO tier_matrix(tier_id,section,percent) VALUES({PH},{PH},{PH})",
              (d.get("tier_id"), d.get("section"), float(d["percent"])))
        return jsonify({"message": "تم الحفظ"})

    # ============ ADMIN SETTINGS / MAINTENANCE ============
    @app.get("/api/admin/settings")
    def adm_settings_get():
        t, e = require_admin()
        if e:
            return e
        banners = [{"id": b["id"], "image": b["image"]} for b in q("SELECT id,image FROM banners ORDER BY id")]
        contact = jget("contact", {}) or {}
        out = {
            "exchange_rate": get_setting("exchange_rate", "140"),
            "welcome_message": get_setting("welcome_message", ""),
            "support_username": get_setting("support_username", ""),
            "welcome_popup_enabled": get_setting("welcome_popup_enabled", "false").strip().lower() == "true",
            "welcome_popup_text": get_setting("welcome_popup_text", ""),
            "ai_image_api_url": get_setting("ai_image_api_url", ""),
            "ai_image_api_key": "***" if get_setting("ai_image_api_key", "") else "",
            "ai_image_prompt_template": get_setting("ai_image_prompt_template", ""),
            "ai_image_api_type": get_setting("ai_image_api_type", ""),
            "ai_image_model": get_setting("ai_image_model", ""),
            "ai_image_prompt_product": get_setting("ai_image_prompt_product", ""),
            "ai_image_prompt_section": get_setting("ai_image_prompt_section", ""),
            "admin_notify_chat_ids": get_setting("admin_notify_chat_ids", ""),
            "dev_logo": get_setting("dev_logo", ""),
            "logo_image": get_setting("logo_image", ""),
            "app_icon": get_setting("app_icon", ""),
            "notif_icon": get_setting("notif_icon", ""),
            "banner_images": banners,
            "auto_tier_enabled": get_setting("auto_tier_enabled", "false") == "true",
        }
        for k in ("support_whatsapp_number", "whatsapp_number"):
            out[k] = contact.get("whatsapp_number", "")
        out.update({"support_whatsapp_url": contact.get("whatsapp_url", ""),
                    "support_telegram_url": contact.get("telegram_url", ""),
                    "whatsapp_channel_url": contact.get("whatsapp_channel_url", ""),
                    "telegram_channel_url": contact.get("telegram_channel_url", "")})
        return jsonify(out)

    @app.post("/api/admin/settings")
    def adm_settings_set():
        t, e = require_admin()
        if e:
            return e
        d = request.get_json(force=True, silent=True) or {}
        if set(d.keys()) == {"auto_tier_enabled"}:
            set_setting("auto_tier_enabled", "true" if str(d["auto_tier_enabled"]).lower() == "true" else "false")
            return jsonify({"message": "تم"})
        for k in ("exchange_rate", "welcome_message", "support_username", "welcome_popup_text",
                  "ai_image_api_url", "ai_image_prompt_template", "ai_image_api_type", "ai_image_model",
                  "ai_image_prompt_product", "ai_image_prompt_section", "admin_notify_chat_ids"):
            if k in d:
                set_setting(k, str(d[k]))
        if "ai_image_api_key" in d and d["ai_image_api_key"] not in ("", "***"):
            set_setting("ai_image_api_key", d["ai_image_api_key"])
        if "welcome_popup_enabled" in d:
            v = d["welcome_popup_enabled"]
            set_setting("welcome_popup_enabled", "true" if v is True or str(v).lower() == "true" else "false")
        contact = jget("contact", {}) or {}
        mapping = {"support_whatsapp_number": "whatsapp_number", "whatsapp_number": "whatsapp_number",
                   "support_whatsapp_url": "whatsapp_url", "support_telegram_url": "telegram_url",
                   "whatsapp_channel_url": "whatsapp_channel_url", "telegram_channel_url": "telegram_channel_url"}
        for src, dst in mapping.items():
            if src in d:
                contact[dst] = d[src]
        set_setting("contact", contact)
        log("admin", "settings", "", "")
        return jsonify({"message": "تم الحفظ"})

    @app.get("/api/admin/maintenance")
    def adm_maint_get():
        t, e = require_admin()
        if e:
            return e
        return jsonify(jget("maintenance", {"enabled": False, "seconds_left": 0, "reason": "", "note": ""}))

    @app.post("/api/admin/maintenance")
    def adm_maint_set():
        t, e = require_admin()
        if e:
            return e
        d = request.get_json(force=True, silent=True) or {}
        if not d.get("enabled"):
            set_setting("maintenance", {"enabled": False, "seconds_left": 0, "reason": "", "note": ""})
            return jsonify({"message": "تم إيقاف الصيانة"})
        secs = int(d.get("months") or 0) * 30 * 86400 + int(d.get("days") or 0) * 86400 + \
            int(d.get("hours") or 0) * 3600 + int(d.get("minutes") or 0) * 60
        set_setting("maintenance", {"enabled": True, "seconds_left": secs, "reason": d.get("reason") or "",
                                    "note": d.get("note") or ""})
        return jsonify({"message": "تم تفعيل الصيانة"})

    # ============ ADMIN ADMINS ============
    @app.get("/api/admin/admins")
    def adm_tg_list():
        t, e = require_admin()
        if e:
            return e
        return jsonify([{"user_id": r["user_id"], "main": bool(r.get("main"))} for r in q("SELECT * FROM tg_admins")])

    @app.post("/api/admin/admins")
    def adm_tg_add():
        t, e = require_admin()
        if e:
            return e
        d = request.get_json(force=True, silent=True) or {}
        uid = str(d.get("user_id") or "").strip()
        if not uid:
            return err("user_id مطلوب")
        if not q(f"SELECT user_id FROM tg_admins WHERE user_id={PH}", (uid,), one=True):
            w(f"INSERT INTO tg_admins(user_id,main) VALUES({PH},0)", (uid,))
        return jsonify({"message": "تمت الإضافة"})

    @app.delete("/api/admin/admins/<uid>")
    def adm_tg_del(uid):
        t, e = require_admin()
        if e:
            return e
        w(f"DELETE FROM tg_admins WHERE user_id={PH}", (uid,))
        return jsonify({"message": "تم الحذف"})

    @app.get("/api/admin/web-admins")
    def adm_web_list():
        t, e = require_admin()
        if e:
            return e
        secs = [r["name"] for r in q("SELECT name FROM sections ORDER BY sort_order")]
        admins = [{"email": r["email"], "owner": False,
                   "perms": (json.loads(r["perms"]) if r.get("perms") else None),
                   "added_at": r.get("added_at") or "", "removable": True}
                  for r in q("SELECT * FROM web_admins ORDER BY added_at")]
        return jsonify({"is_owner": True, "admins": admins, "sections": secs})

    @app.post("/api/admin/web-admins")
    def adm_web_add():
        t, e = require_admin()
        if e:
            return e
        d = request.get_json(force=True, silent=True) or {}
        email = (d.get("email") or "").strip().lower()
        if not email:
            return err("الإيميل مطلوب")
        if not q(f"SELECT email FROM web_admins WHERE email={PH}", (email,), one=True):
            w(f"INSERT INTO web_admins(email,perms,added_at) VALUES({PH},NULL,{PH})", (email, NOW()))
        return jsonify({"message": "تمت الإضافة"})

    @app.put("/api/admin/web-admins/<email>/perms")
    def adm_web_perms(email):
        t, e = require_admin()
        if e:
            return e
        d = request.get_json(force=True, silent=True) or {}
        perms = d.get("perms")
        w(f"UPDATE web_admins SET perms={PH} WHERE email={PH}",
          (None if perms is None else json.dumps(perms, ensure_ascii=False), email.lower()))
        return jsonify({"message": "تم الحفظ"})

    @app.delete("/api/admin/web-admins/<email>")
    def adm_web_del(email):
        t, e = require_admin()
        if e:
            return e
        w(f"DELETE FROM web_admins WHERE email={PH}", (email.lower(),))
        return jsonify({"message": "تم الحذف"})

    # ============ ADMIN ALERTS / PUSH ============
    @app.get("/api/admin/alerts-count")
    def adm_alerts():
        t, e = require_admin()
        if e:
            return e
        pd = q("SELECT COUNT(*) AS c FROM deposits WHERE status='pending'", one=True) or {}
        so = q("SELECT COUNT(*) AS c FROM orders WHERE status='pending' AND source='manual'", one=True) or {}
        return jsonify({"total": int(pd.get("c", 0)) + int(so.get("c", 0)),
                        "pending_deposits": int(pd.get("c", 0)), "pending_shop_orders": int(so.get("c", 0))})

    @app.get("/api/admin/notifications")
    def adm_notifs():
        t, e = require_admin()
        if e:
            return e
        rows = q("SELECT * FROM admin_notifs ORDER BY id DESC LIMIT 50")
        return jsonify({"items": [{"id": r["id"], "title": r["title"], "message": r.get("message") or ""} for r in rows]})

    @app.post("/api/admin/notifications/mark-read")
    def adm_notifs_read():
        t, e = require_admin()
        if e:
            return e
        w("UPDATE admin_notifs SET is_read=1")
        return jsonify({"message": "ok"})

    @app.post("/api/admin/push/subscribe")
    def adm_push_sub():
        t, e = require_admin()
        if e:
            return e
        d = request.get_json(force=True, silent=True) or {}
        ep = d.get("endpoint") or ""
        if ep:
            if q(f"SELECT endpoint FROM push_subs WHERE endpoint={PH}", (ep,), one=True):
                w(f"UPDATE push_subs SET is_admin=1,keys_json={PH} WHERE endpoint={PH}", (json.dumps(d, ensure_ascii=False), ep))
            else:
                w(f"INSERT INTO push_subs(endpoint,user_id,keys_json,is_admin) VALUES({PH},0,{PH},1)", (ep, json.dumps(d, ensure_ascii=False)))
        return jsonify({"message": "ok"})

    @app.get("/api/admin/push/status")
    def adm_push_status():
        t, e = require_admin()
        if e:
            return e
        tot = q("SELECT COUNT(*) AS c FROM push_subs", one=True) or {}
        us = q("SELECT COUNT(*) AS c FROM push_subs WHERE user_id<>0", one=True) or {}
        gu = q("SELECT COUNT(*) AS c FROM push_subs WHERE user_id=0", one=True) or {}
        return jsonify({"enabled": bool(get_setting("vapid_public", "")), "subscribers": int(tot.get("c", 0)),
                        "users": int(us.get("c", 0)), "guests": int(gu.get("c", 0))})

    @app.post("/api/admin/push/broadcast")
    def adm_push_cast():
        t, e = require_admin()
        if e:
            return e
        d = request.get_json(force=True, silent=True) or {}
        subs = q("SELECT endpoint FROM push_subs")
        for s in subs:
            notify_user(0, d.get("title") or "", d.get("message") or "", "info")
            break
        n = len(subs)
        w(f"INSERT INTO notifs(user_id,title,message,kind,created_at) VALUES(0,{PH},{PH},'info',{PH})",
          (d.get("title") or "", (d.get("message") or "") + (f" ({d['url']})" if d.get("url") else ""), NOW()))
        return jsonify({"message": f"تم الإرسال لـ {n} مشترك"})

    # ============ ADMIN AI / SEARCH / LOGS ============
    @app.get("/api/admin/ai-agent")
    def adm_ai_get():
        t, e = require_admin()
        if e:
            return e
        return jsonify({"ai_agent_enabled": get_setting("ai_agent_enabled", "false"),
                        "ai_agent_name": get_setting("ai_agent_name", ""),
                        "ai_agent_api_url": get_setting("ai_agent_api_url", ""),
                        "ai_agent_api_key": "***" if get_setting("ai_agent_api_key", "") else "",
                        "ai_agent_model": get_setting("ai_agent_model", ""),
                        "ai_agent_prompt": get_setting("ai_agent_prompt", ""),
                        "ai_agent_welcome": get_setting("ai_agent_welcome", "")})

    @app.post("/api/admin/ai-agent")
    def adm_ai_set():
        t, e = require_admin()
        if e:
            return e
        d = request.get_json(force=True, silent=True) or {}
        for k in ("ai_agent_enabled", "ai_agent_name", "ai_agent_api_url", "ai_agent_model",
                  "ai_agent_prompt", "ai_agent_welcome"):
            if k in d:
                set_setting(k, d[k] if isinstance(d[k], str) else ("true" if d[k] else "false"))
        if d.get("ai_agent_api_key") not in (None, "", "***"):
            set_setting("ai_agent_api_key", d["ai_agent_api_key"])
        return jsonify({"message": "تم الحفظ"})

    @app.post("/api/admin/ai-agent/test")
    def adm_ai_test():
        t, e = require_admin()
        if e:
            return e
        reply, _ = ai_answer("مرحباً، عرّف عن نفسك باختصار")
        return jsonify({"message": "تم", "reply": reply})

    @app.get("/api/admin/ai-memory")
    def adm_ai_mem():
        t, e = require_admin()
        if e:
            return e
        try:
            lim = min(int(request.args.get("limit") or 150), 500)
        except Exception:
            lim = 150
        items = q(f"SELECT id,question,reply,created_at AS date FROM ai_memory ORDER BY id DESC LIMIT {lim}")
        tot = q("SELECT COUNT(*) AS c FROM ai_memory", one=True) or {}
        return jsonify({"items": items, "total": int(tot.get("c", 0))})

    @app.delete("/api/admin/ai-memory")
    def adm_ai_mem_del():
        t, e = require_admin()
        if e:
            return e
        d = request.get_json(force=True, silent=True) or {}
        if d.get("id"):
            w(f"DELETE FROM ai_memory WHERE id={PH}", (d["id"],))
        else:
            w("DELETE FROM ai_memory")
        return jsonify({"message": "تم الحذف"})

    # ============ ADMIN: WHATSAPP BOT ============
    @app.get("/api/admin/whatsapp")
    def adm_wa_get():
        t, e = require_admin()
        if e:
            return e
        st = wa_status_get()
        return jsonify({
            "enabled": get_setting("wa_enabled", "false").strip().lower() == "true",
            "bot_enabled": get_setting("wa_bot_enabled", "true").strip().lower() == "true",
            "phone": get_setting("wa_phone", ""),
            "bot_name": get_setting("wa_bot_name", ""),
            "store_url": get_setting("wa_store_url", ""),
            "greeting": get_setting("wa_greeting", ""),
            "append_link": get_setting("wa_append_link", "true").strip().lower() == "true",
            "reply_unknown": get_setting("wa_reply_unknown", ""),
            "secret": wa_secret(),
            "status": st,
            "pair": jget("wa_pair_req", {}) or {},
        })

    @app.post("/api/admin/whatsapp")
    def adm_wa_set():
        t, e = require_admin()
        if e:
            return e
        d = request.get_json(force=True, silent=True) or {}
        for k in ("wa_enabled", "wa_bot_enabled", "wa_phone", "wa_bot_name", "wa_store_url",
                  "wa_greeting", "wa_append_link", "wa_reply_unknown"):
            if k in d:
                v = d[k]
                if k in ("wa_enabled", "wa_bot_enabled", "wa_append_link"):
                    v = "true" if (v is True or str(v).strip().lower() in ("true", "1", "on", "yes")) else "false"
                else:
                    v = "" if v is None else str(v)
                set_setting(k, v)
        set_setting("wa_cfg_version", str(int(time.time())))
        log(t, "wa_config", detail="تحديث إعدادات واتساب")
        return jsonify({"message": "تم الحفظ"})

    @app.post("/api/admin/whatsapp/pair")
    def adm_wa_pair():
        t, e = require_admin()
        if e:
            return e
        d = request.get_json(force=True, silent=True) or {}
        phone = wa_norm_phone(d.get("phone") or get_setting("wa_phone", ""))
        if len(phone) < 8:
            return err("أدخل رقم واتساب صحيح مع رمز الدولة بدون + (مثال: 9639xxxxxxxx)")
        set_setting("wa_phone", phone)
        set_setting("wa_pair_req", json.dumps({"requested": True, "phone": phone, "at": NOW()}, ensure_ascii=False))
        st = wa_status_get()
        st.update({"linked": False, "code": "", "qr": "", "error": "", "updated": NOW()})
        wa_status_set(st)
        return jsonify({"message": "تم إرسال طلب الربط. رح يظهر الكود خلال لحظات.",
                        "phone": phone})

    @app.post("/api/admin/whatsapp/logout")
    def adm_wa_logout():
        t, e = require_admin()
        if e:
            return e
        wa_kv_del("wa_creds")
        wa_status_set({"linked": False, "code": "", "qr": "", "me": "", "platform": "",
                       "since": "", "updated": NOW(), "error": ""})
        set_setting("wa_pair_req", json.dumps({"requested": False, "phone": "", "at": NOW()}, ensure_ascii=False))
        # ask the worker to drop its session on next heartbeat
        wa_kv_set("wa_force_logout", True)
        log(t, "wa_logout")
        return jsonify({"message": "تم فصل الجهاز"})

    @app.post("/api/admin/whatsapp/test")
    def adm_wa_test():
        t, e = require_admin()
        if e:
            return e
        reply, _ = wa_ai_reply("مرحباً، عرّف عن المتجر بجملة قصيرة وأرسل رابط الموقع")
        return jsonify({"message": "تم", "reply": reply})

    @app.get("/api/admin/whatsapp/messages")
    def adm_wa_msgs():
        t, e = require_admin()
        if e:
            return e
        try:
            lim = min(int(request.args.get("limit") or 100), 400)
        except Exception:
            lim = 100
        items = q(f"SELECT id,direction,number,name,body,reply,created_at AS date FROM wa_messages ORDER BY id DESC LIMIT {lim}")
        tot = q("SELECT COUNT(*) AS c FROM wa_messages", one=True) or {}
        return jsonify({"items": items, "total": int(tot.get("c", 0))})

    @app.delete("/api/admin/whatsapp/messages")
    def adm_wa_msgs_del():
        t, e = require_admin()
        if e:
            return e
        w("DELETE FROM wa_messages")
        return jsonify({"message": "تم الحذف"})

    @app.get("/api/admin/whatsapp/humans")
    def adm_wa_humans():
        t, e = require_admin()
        if e:
            return e
        rows = q("SELECT number,name,first_msg,created_at AS date FROM wa_humans WHERE done=0 ORDER BY created_at DESC")
        return jsonify({"items": rows})

    @app.post("/api/admin/whatsapp/humans/close")
    def adm_wa_humans_close():
        t, e = require_admin()
        if e:
            return e
        d = request.get_json(force=True, silent=True) or {}
        num = str(d.get("number") or "")
        if not num:
            return err("رقم غير صحيح")
        w(f"UPDATE wa_humans SET done=1 WHERE number={PH}", (num,))
        add_activity(0, "wa", "info", f"إنهاء توجيه محادثة واتساب: {num}", "", "admin")
        return jsonify({"message": "تم إنهاء التوجيه، البوت سيرد له مجدداً"})

    @app.get("/api/admin/search")
    def adm_search():
        t, e = require_admin()
        if e:
            return e
        x = f"%{request.args.get('q') or ''}%"
        orders = q(f"SELECT id,product_name AS product,player_id AS player,track FROM orders WHERE product_name LIKE {PH} OR player_id LIKE {PH} OR track LIKE {PH} ORDER BY id DESC LIMIT 20", (x, x, x))
        users = q(f"SELECT id AS web_id,name,email FROM users WHERE name LIKE {PH} OR email LIKE {PH} ORDER BY id DESC LIMIT 20", (x, x))
        deps = q(f"SELECT d.id,m.title AS method,d.amount_syp,d.code FROM deposits d LEFT JOIN dep_manual m ON m.id=d.method_id WHERE m.title LIKE {PH} OR d.code LIKE {PH} ORDER BY d.id DESC LIMIT 20", (x, x))
        return jsonify({"orders": orders, "users": users,
                        "deposits": [{"id": r["id"], "method": r.get("title") or "", "amount_syp": float(r.get("amount_syp") or 0), "code": r.get("code") or ""} for r in deps]})

    @app.get("/api/admin/logs")
    def adm_logs():
        t, e = require_admin()
        if e:
            return e
        try:
            lim = min(int(request.args.get("limit") or 300), 1000)
        except Exception:
            lim = 300
        return jsonify(q(f"SELECT created_at AS date,actor,action,target,detail FROM logs ORDER BY id DESC LIMIT {lim}"))

    # ============ ADMIN SNAPSHOTS / BACKUPS ============
    def dump_all():
        # NOTE: blob_files intentionally excluded — images are permanent separately.
        # Including them made snapshots/backups hundreds of MB and killed the free DB quota.
        tables = ["users", "web_admins", "tg_admins", "sections", "subsections", "products", "skus",
                  "orders", "deposits", "dep_manual", "dep_auto", "providers", "tiers", "tier_matrix",
                  "settings", "banners", "notifs", "admin_notifs", "push_subs", "activity", "ai_memory",
                  "logs", "batches", "reset_codes", "admin_tokens"]
        return {tb: q(f"SELECT * FROM {tb}") for tb in tables}

    @app.get("/api/admin/snapshots")
    def adm_snaps():
        t, e = require_admin()
        if e:
            return e
        return jsonify([{"id": r["id"], "reason": r.get("reason") or "", "created_at": r.get("created_at") or "",
                         "size_kb": float(r.get("size_kb") or 0)} for r in q("SELECT id,reason,created_at,size_kb FROM snapshots ORDER BY created_at DESC")])

    def take_snapshot(reason):
        data = json.dumps(dump_all(), ensure_ascii=False, default=str)
        sid = "snap-%d-%s" % (int(time.time()), secrets.token_hex(3))
        w(f"INSERT INTO snapshots(id,reason,created_at,size_kb,data_json) VALUES({PH},{PH},{PH},{PH},{PH})",
          (sid, reason, NOW(), round(len(data) / 1024, 1), data))
        return sid

    @app.post("/api/admin/snapshots/<sid>/restore")
    def adm_snap_restore(sid):
        t, e = require_admin()
        if e:
            return e
        r = q(f"SELECT data_json FROM snapshots WHERE id={PH}", (sid,), one=True)
        if not r:
            return err("النسخة غير موجودة", 404)
        restore_all(json.loads(r["data_json"]))
        return jsonify({"message": "تمت الاستعادة"})

    @app.delete("/api/admin/snapshots/<sid>")
    def adm_snap_del(sid):
        t, e = require_admin()
        if e:
            return e
        w(f"DELETE FROM snapshots WHERE id={PH}", (sid,))
        return jsonify({"message": "تم الحذف"})

    @app.get("/api/admin/backup-json")
    def adm_backup_dl():
        if not is_admin_token(bearer()):
            return err("غير مصرح", 401)
        data = json.dumps(dump_all(), ensure_ascii=False, default=str)
        return app.response_class(data, mimetype="application/json",
                                  headers={"Content-Disposition": "attachment;filename=arabstore-backup.json"})

    @app.post("/api/admin/restore-json")
    def adm_restore_json():
        t, e = require_admin()
        if e:
            return e
        f = request.files.get("file")
        if not f:
            return err("الملف مطلوب")
        try:
            restore_all(json.loads(f.read().decode("utf-8")))
        except Exception as ex:
            return err("ملف غير صالح: " + str(ex)[:150])
        return jsonify({"message": "تمت الاستعادة"})

    def restore_all(data):
        take_snapshot("auto-before-restore")
        tables = ["reset_codes", "batches", "logs", "ai_memory", "activity", "push_subs", "admin_notifs",
                  "notifs", "banners", "tier_matrix", "tiers", "providers", "dep_auto", "dep_manual",
                  "deposits", "orders", "skus", "products", "subsections", "sections", "tg_admins",
                  "web_admins", "users", "settings", "admin_tokens"]
        for tb in tables:
            try:
                w(f"DELETE FROM {tb}")
                for row in (data.get(tb) or []):
                    cols = [c for c in row.keys() if c != "_x"]
                    w(f"INSERT INTO {tb}({','.join(cols)}) VALUES({','.join([PH] * len(cols))})",
                      tuple(row[c] for c in cols))
                if USE_PG and tb in ID_TABLES:
                    con = db()
                    cur = con.cursor()
                    cur.execute(f"SELECT setval(pg_get_serial_sequence('{tb}','id'), COALESCE(MAX(id),1)) FROM {tb}")
                    con.commit()
            except Exception:
                continue

    @app.get("/api/admin/storage")
    def adm_storage():
        t, e = require_admin()
        if e:
            return e
        try:
            if USE_PG:
                tot = q("SELECT pg_database_size(current_database()) AS s", one=True) or {}
                total = int(tot.get("s") or 0)
            else:
                total = os.path.getsize(os.path.join(DATA_DIR, "data.db"))
        except Exception:
            total = 0
        try:
            blobs = q("SELECT COALESCE(SUM(LENGTH(data)),0) AS s FROM blob_files", one=True) or {}
            blob_bytes = int(blobs.get("s") or 0)
        except Exception:
            blob_bytes = 0
        try:
            bk = q("SELECT COALESCE(SUM(size_kb),0) AS s FROM backups", one=True) or {}
            sn = q("SELECT COALESCE(SUM(size_kb),0) AS s FROM snapshots", one=True) or {}
            backup_bytes = int(float(bk.get("s") or 0) * 1024 + float(sn.get("s") or 0) * 1024)
        except Exception:
            backup_bytes = 0
        limit = 512 * 1024 * 1024
        def fmt(n):
            n = float(n or 0)
            return ("%g MB" % round(n / 1048576, 1)) if n >= 1048576 else ("%g KB" % round(n / 1024, 1))
        return jsonify({"total_bytes": total, "total": fmt(total), "blob_bytes": blob_bytes,
                        "blobs": fmt(blob_bytes), "backup_bytes": backup_bytes, "backups": fmt(backup_bytes),
                        "tables": fmt(max(0, total - blob_bytes - backup_bytes)),
                        "limit_bytes": limit, "limit": "512 MB",
                        "pct": round(total / limit * 100, 1) if limit else 0})

    @app.get("/api/admin/backups")
    def adm_backups():
        t, e = require_admin()
        if e:
            return e
        return jsonify({"backups": [{"name": r["name"], "size_kb": float(r.get("size_kb") or 0),
                                     "created_at": r.get("created_at") or "",
                                     "download_url": f"/admin/backups/{r['name']}/download"} for r in
                                     q("SELECT name,size_kb,created_at FROM backups ORDER BY created_at DESC")]})

    @app.post("/api/admin/backups")
    def adm_backup_new():
        t, e = require_admin()
        if e:
            return e
        data = json.dumps(dump_all(), ensure_ascii=False, default=str)
        nm = "backup-%s.json" % datetime.datetime.utcnow().strftime("%Y%m%d-%H%M%S")
        w(f"INSERT INTO backups(name,size_kb,created_at,data_json) VALUES({PH},{PH},{PH},{PH})",
          (nm, round(len(data) / 1024, 1), NOW(), data))
        return jsonify({"message": "تم إنشاء النسخة " + nm})

    @app.get("/api/admin/backups/<name>/download")
    def adm_backup_get(name):
        if not is_admin_token(bearer()):
            return err("غير مصرح", 401)
        r = q(f"SELECT data_json FROM backups WHERE name={PH}", (name,), one=True)
        if not r:
            return err("غير موجود", 404)
        return app.response_class(r["data_json"], mimetype="application/json",
                                  headers={"Content-Disposition": f"attachment;filename={name}"})

    @app.delete("/api/admin/backups/<name>")
    def adm_backup_del(name):
        t, e = require_admin()
        if e:
            return e
        w(f"DELETE FROM backups WHERE name={PH}", (name,))
        return jsonify({"message": "تم الحذف"})

    @app.post("/api/admin/restore")
    def adm_restore():
        t, e = require_admin()
        if e:
            return e
        if request.files.get("file"):
            try:
                restore_all(json.loads(request.files["file"].read().decode("utf-8")))
                return jsonify({"message": "تمت الاستعادة"})
            except Exception as ex:
                return err("ملف غير صالح: " + str(ex)[:150])
        nm = (request.form.get("name") or "").strip()
        r = q(f"SELECT data_json FROM backups WHERE name={PH}", (nm,), one=True)
        if not r:
            return err("النسخة غير موجودة", 404)
        restore_all(json.loads(r["data_json"]))
        return jsonify({"message": "تمت الاستعادة"})

    @app.post("/api/admin/wipe-data")
    def adm_wipe():
        t, e = require_admin()
        if e:
            return e
        d = request.get_json(force=True, silent=True) or {}
        if d.get("confirm") != "حذف":
            return err("اكتب كلمة التأكيد: حذف")
        take_snapshot("before-wipe")
        for tb in ["orders", "deposits", "activity", "notifs", "admin_notifs", "ai_memory", "logs"]:
            try:
                w(f"DELETE FROM {tb}")
            except Exception:
                pass
        if (d.get("scope") or "") == "all":
            for tb in ["users", "products", "skus", "sections", "subsections"]:
                try:
                    w(f"DELETE FROM {tb}")
                except Exception:
                    pass
        return jsonify({"message": "تم المسح"})

    # ============ ADMIN CATALOG CSV / BRAND ============
    @app.post("/api/admin/catalog/import-csv")
    def adm_csv():
        t, e = require_admin()
        if e:
            return e
        f = request.files.get("file")
        if not f:
            return err("الملف مطلوب")
        try:
            rows = list(csv.DictReader(io.StringIO(f.read().decode("utf-8-sig"))))
        except Exception:
            return err("تعذر قراءة CSV")
        bid = "B%06d" % (secrets.randbelow(900000) + 100000)
        w(f"INSERT INTO batches(batch_id,created_at) VALUES({PH},{PH})", (bid, NOW()))
        skipped_unknown, skipped_dup = 0, 0
        for r in rows:
            nm = (r.get("name") or "").strip()
            sec = (r.get("section") or r.get("category") or "").strip()
            if not nm or not sec:
                skipped_unknown += 1
                continue
            if q(f"SELECT s.id FROM skus s JOIN products p ON p.id=s.product_id WHERE s.name={PH} AND p.name={PH}", (nm, sec), one=True):
                skipped_dup += 1
                continue
            prod = q(f"SELECT id FROM products WHERE name={PH}", (sec,), one=True)
            if not prod:
                secrow = q(f"SELECT id FROM sections WHERE name={PH}", (sec,), one=True)
                if not secrow:
                    skipped_unknown += 1
                    continue
                pid = w(f"INSERT INTO products(name,category,sort_order) VALUES({PH},{PH},0)", (sec, sec))
            else:
                pid = prod["id"]
            try:
                price = float(r.get("price") or 0)
            except Exception:
                price = 0
            pub = "P%06d" % (secrets.randbelow(900000) + 100000)
            w(f"INSERT INTO skus(product_id,name,price_usd,public_id) VALUES({PH},{PH},{PH},{PH})", (pid, nm, price, pub))
        return jsonify({"message": f"تم الاستيراد (دفعة {bid})", "batch_id": bid,
                        "skipped_unknown": skipped_unknown, "skipped_duplicate": skipped_dup})

    @app.delete("/api/admin/catalog/import/<bid>")
    def adm_csv_undo(bid):
        t, e = require_admin()
        if e:
            return e
        w(f"DELETE FROM batches WHERE batch_id={PH}", (bid,))
        return jsonify({"message": "تم حذف الدفعة من السجل (المنتجات المستوردة تبقى، احذفها يدوياً عند الحاجة)"})

    @app.post("/api/admin/catalog/clear")
    def adm_catalog_clear():
        t, e = require_admin()
        if e:
            return e
        take_snapshot("before-catalog-clear")
        w("DELETE FROM skus")
        w("DELETE FROM products")
        return jsonify({"message": "تم مسح الكتالوج"})

    @app.post("/api/admin/catalog/brand-images")
    @app.post("/api/admin/catalog/brand-images/bulk")
    def adm_brand_images():
        t, e = require_admin()
        if e:
            return e
        d = request.get_json(force=True, silent=True) or {}
        limit = int(d.get("limit") or 20)
        offset = int(d.get("offset") or 0)
        prods = q(f"SELECT id,name FROM products WHERE (image IS NULL OR image='') ORDER BY id LIMIT {limit} OFFSET {offset}")
        tot = q("SELECT COUNT(*) AS c FROM products WHERE (image IS NULL OR image='')", one=True) or {}
        updated, failed = 0, []
        for p in prods:
            try:
                r, _ = ai_image_for("product", p["name"]), None
                if r:
                    w(f"UPDATE products SET image={PH} WHERE id={PH}", (r, p["id"]))
                    updated += 1
                else:
                    failed.append({"id": p["id"], "name": p["name"], "error": "no url"})
            except Exception as ex:
                failed.append({"id": p["id"], "name": p["name"], "error": str(ex)[:100]})
        done = (offset + limit) >= int(tot.get("c", 0))
        return jsonify({"message": f"تم تحديث {updated}", "updated": updated, "total": int(tot.get("c", 0)),
                        "failed": failed, "done": done})

    def ai_image_for(kind, name):
        url, _ = gen_image_url(build_luxury_prompt(name, kind))
        return url

    # ============ ADMIN IMAGE UPLOADS ============
    MIME_BY_EXT = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
                   ".webp": "image/webp", ".svg": "image/svg+xml", ".gif": "image/gif", ".ico": "image/x-icon"}

    def detect_image(raw, filename):
        """Returns (ext, mime) from magic bytes, or (None, None) if unsupported."""
        if raw[:4] == b"\x89PNG":
            return ".png", "image/png"
        if raw[:3] == b"\xff\xd8\xff":
            return ".jpg", "image/jpeg"
        if raw[:6] in (b"GIF87a", b"GIF89a"):
            return ".gif", "image/gif"
        if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
            return ".webp", "image/webp"
        head = raw[:600].lstrip(b"\x00 \t\r\n").lower()
        if head.startswith(b"<svg") or b"<svg" in head[:200]:
            return ".svg", "image/svg+xml"
        if len(raw) > 12 and raw[4:8] == b"ftyp" and raw[8:12] in (
                b"heic", b"heix", b"hevc", b"hevx", b"heim", b"heis", b"hevm", b"hevs", b"mif1", b"msf1"):
            return "HEIC", "image/heic"
        return None, None

    def optimize_image(raw, filename=""):
        """Compress to fast-loading WebP (GIF/SVG/ICO kept as-is). Returns (bytes, ext, mime) or (None, None, None)."""
        ext, mime = detect_image(raw, filename)
        if not ext or ext == "HEIC":
            return None, None, None
        if ext in (".gif", ".svg", ".ico"):
            return raw, ext, mime
        try:
            from PIL import Image
            import io as _io
            im = Image.open(_io.BytesIO(raw))
            if im.mode not in ("RGBA", "LA"):
                im = im.convert("RGB")
            w, h = im.size
            if max(w, h) > 900:
                r = 900 / max(w, h)
                im = im.resize((max(1, int(w * r)), max(1, int(h * r))), Image.LANCZOS)
            out = _io.BytesIO()
            im.save(out, "WEBP", quality=78, method=6)
            return out.getvalue(), ".webp", "image/webp"
        except Exception:
            return None, None, None

    def save_upload(f):
        """Permanent + optimized image storage inside the database (survives redeploys)."""
        raw = f.read()
        if not raw:
            raise ValueError("ملف فارغ")
        if len(raw) > 4 * 1024 * 1024:
            raise ValueError("الصورة أكبر من 4MB — صغّرها وحاول مجدداً")
        data, ext, mime = optimize_image(raw, f.filename or "")
        if not data:
            if (f.filename or "").lower().endswith((".heic", ".heif")):
                raise ValueError("صيغة HEIC غير مدعومة — من الآيفون: الإعدادات > الكاميرا > الصيغ > الأكثر توافقية، أو حوّل الصورة إلى JPG")
            raise ValueError("صيغة الصورة غير مدعومة — استخدم PNG أو JPG أو WEBP أو GIF أو SVG")
        nm = secrets.token_hex(8) + ext
        b64 = base64.b64encode(data).decode()
        if q(f"SELECT name FROM blob_files WHERE name={PH}", (nm,), one=True):
            w(f"UPDATE blob_files SET data={PH},mime={PH} WHERE name={PH}", (b64, mime, nm))
        else:
            w(f"INSERT INTO blob_files(name,data,mime) VALUES({PH},{PH},{PH})", (nm, b64, mime))
        return "/uploads/" + nm

    def upload_route(path, apply):
        @app.post(path, endpoint="upl_" + apply.replace("/", "_"))
        def _upl(apply=apply):
            t, e = require_admin()
            if e:
                return e
            f = request.files.get("file")
            if not f:
                return err("الملف مطلوب")
            url = save_upload(f)
            apply(url)
            return jsonify({"message": "تم الرفع", "url": url})
        return _upl

    @app.post("/api/admin/sections/<int:xid>/image")
    def upl_section(xid):
        t, e = require_admin()
        if e:
            return e
        f = request.files.get("file")
        if not f:
            return err("الملف مطلوب")
        url = save_upload(f)
        w(f"UPDATE sections SET image={PH} WHERE id={PH}", (url, xid))
        return jsonify({"message": "تم", "url": url})

    @app.post("/api/admin/products/<int:xid>/image")
    def upl_product(xid):
        t, e = require_admin()
        if e:
            return e
        f = request.files.get("file")
        if not f:
            return err("الملف مطلوب")
        url = save_upload(f)
        w(f"UPDATE products SET image={PH} WHERE id={PH}", (url, xid))
        return jsonify({"message": "تم", "url": url})

    @app.post("/api/admin/categories/<int:xid>/image")
    def upl_sku(xid):
        t, e = require_admin()
        if e:
            return e
        f = request.files.get("file")
        if not f:
            return err("الملف مطلوب")
        url = save_upload(f)
        w(f"UPDATE skus SET image={PH} WHERE id={PH}", (url, xid))
        return jsonify({"message": "تم", "url": url})

    @app.post("/api/admin/subsections/<int:xid>/image")
    def upl_sub(xid):
        t, e = require_admin()
        if e:
            return e
        f = request.files.get("file")
        if not f:
            return err("الملف مطلوب")
        url = save_upload(f)
        w(f"UPDATE subsections SET image={PH} WHERE id={PH}", (url, xid))
        return jsonify({"message": "تم", "url": url})

    @app.post("/api/admin/deposit-methods/manual/<int:xid>/image")
    def upl_man(xid):
        t, e = require_admin()
        if e:
            return e
        f = request.files.get("file")
        if not f:
            return err("الملف مطلوب")
        url = save_upload(f)
        w(f"UPDATE dep_manual SET image={PH} WHERE id={PH}", (url, xid))
        return jsonify({"message": "تم", "url": url})

    @app.post("/api/admin/deposit-methods/auto/<int:xid>/image")
    def upl_auto(xid):
        t, e = require_admin()
        if e:
            return e
        f = request.files.get("file")
        if not f:
            return err("الملف مطلوب")
        url = save_upload(f)
        w(f"UPDATE dep_auto SET image={PH} WHERE id={PH}", (url, xid))
        return jsonify({"message": "تم", "url": url})

    def setting_image_route(path, key):
        @app.post(path, endpoint="setimg_" + key)
        def _s():
            t, e = require_admin()
            if e:
                return e
            f = request.files.get("file")
            if not f:
                return err("الملف مطلوب")
            url = save_upload(f)
            set_setting(key, url)
            return jsonify({"message": "تم", "url": url})
        return _s

    @app.post("/api/admin/settings/banner-image")
    def upl_banner():
        t, e = require_admin()
        if e:
            return e
        f = request.files.get("file")
        if not f:
            return err("الملف مطلوب")
        url = save_upload(f)
        w(f"INSERT INTO banners(image) VALUES({PH})", (url,))
        return jsonify({"message": "تم", "url": url})

    @app.post("/api/admin/settings/logo")
    def upl_logo():
        t, e = require_admin()
        if e:
            return e
        f = request.files.get("file")
        if not f:
            return err("الملف مطلوب")
        set_setting("logo_image", save_upload(f))
        return jsonify({"message": "تم"})

    @app.post("/api/admin/settings/app-icon")
    def upl_appicon():
        t, e = require_admin()
        if e:
            return e
        f = request.files.get("file")
        if not f:
            return err("الملف مطلوب")
        set_setting("app_icon", save_upload(f))
        return jsonify({"message": "تم"})

    @app.post("/api/admin/settings/dev-logo")
    def upl_devlogo():
        t, e = require_admin()
        if e:
            return e
        f = request.files.get("file")
        if not f:
            return err("الملف مطلوب")
        set_setting("dev_logo", save_upload(f))
        return jsonify({"message": "تم"})

    @app.post("/api/admin/settings/notif-icon")
    def upl_notificon():
        t, e = require_admin()
        if e:
            return e
        f = request.files.get("file")
        if not f:
            return err("الملف مطلوب")
        set_setting("notif_icon", save_upload(f))
        return jsonify({"message": "تم"})

    @app.delete("/api/admin/settings/banner-image/<int:bid>")
    def del_banner(bid):
        t, e = require_admin()
        if e:
            return e
        w(f"DELETE FROM banners WHERE id={PH}", (bid,))
        return jsonify({"message": "تم الحذف"})

    @app.delete("/api/admin/banners/all")
    def del_banners():
        t, e = require_admin()
        if e:
            return e
        w("DELETE FROM banners")
        return jsonify({"message": "تم الحذف"})

    @app.delete("/api/admin/settings/logo")
    def del_logo():
        t, e = require_admin()
        if e:
            return e
        set_setting("logo_image", "")
        return jsonify({"message": "تم"})

    @app.delete("/api/admin/settings/dev-logo")
    def del_devlogo():
        t, e = require_admin()
        if e:
            return e
        set_setting("dev_logo", "")
        return jsonify({"message": "تم"})

    @app.delete("/api/admin/settings/app-icon")
    def del_appicon():
        t, e = require_admin()
        if e:
            return e
        set_setting("app_icon", "")
        return jsonify({"message": "تم"})

    @app.delete("/api/admin/settings/notif-icon")
    def del_notificon():
        t, e = require_admin()
        if e:
            return e
        set_setting("notif_icon", "")
        return jsonify({"message": "تم"})

    # ============ RESELLER API (/client/api + /api/v1) ============
    def reseller_auth():
        key = request.headers.get("api-token") or (request.headers.get("Authorization", "")[7:] if request.headers.get("Authorization", "").startswith("Bearer ") else "")
        if not key:
            return None, (jsonify({"status": "error", "code": 120, "message": "token required"}), 401)
        u = q(f"SELECT * FROM users WHERE api_key={PH}", (key,), one=True)
        if not u or not u.get("api_enabled"):
            return None, (jsonify({"status": "error", "code": 121, "message": "token error"}), 403)
        if u.get("blocked"):
            return None, (jsonify({"status": "error", "code": 122, "message": "API not allowed"}), 403)
        allowed = (u.get("allowed_ips") or "").strip()
        if allowed:
            ips = [x.strip() for x in allowed.split(",") if x.strip()]
            if request.remote_addr not in ips:
                return None, (jsonify({"status": "error", "code": 123, "message": "IP not allowed"}), 403)
        m = jget("maintenance", {}) or {}
        if m.get("enabled"):
            return None, (jsonify({"status": "error", "code": 130, "message": "site in maintenance"}), 503)
        return u, None

    def sku_public(s, u):
        price, _ = effective_price(s, u)
        return {"id": str(s.get("public_id") or s["id"]), "name": s["name"], "price": price,
                "params": ["Enter Player ID"] if s.get("requires_id") else [],
                "category_name": (q(f"SELECT name FROM products WHERE id={PH}", (s.get("product_id"),), one=True) or {}).get("name") or "",
                "available": bool(s.get("available")),
                "qty_values": {"min": s.get("min_qty") or 1, "max": s.get("max_qty") or 15000},
                "product_type": s.get("type") or "default", "parent_id": str(s.get("product_id"))}

    @app.get("/client/api/profile")
    def r_profile():
        u, e = reseller_auth()
        if e:
            return e
        return jsonify({"status": "OK", "balance": str(round(float(u.get("balance_usd") or 0), 3)), "email": u.get("email")})

    @app.get("/client/api/products")
    def r_products():
        u, e = reseller_auth()
        if e:
            return e
        ids = request.args.get("products_id")
        base_only = request.args.get("base")
        sql, args = "SELECT * FROM skus", []
        if ids:
            want = [x.strip() for x in ids.split(",") if x.strip()]
            sql += f" WHERE public_id IN ({ph(len(want))})"
            args = want
        rows = q(sql + " ORDER BY id", tuple(args))
        if base_only:
            return jsonify([{"id": str(s.get("public_id") or s["id"]), "name": s["name"]} for s in rows])
        return jsonify([sku_public(s, u) for s in rows])

    @app.get("/client/api/content/<cid>")
    def r_content(cid):
        u, e = reseller_auth()
        if e:
            return e
        prod = q(f"SELECT * FROM products WHERE id={PH}", (cid,), one=True)
        rows = q(f"SELECT * FROM skus WHERE product_id={PH}", (cid,))
        return jsonify({"status": "OK",
                        "categories": [{"id": str(cid), "name": (prod or {}).get("name") or ""}],
                        "products": [sku_public(s, u) for s in rows]})

    def reseller_order(u, prod_ref, player_id, qty, uuid):
        player_id = (player_id or "").strip()
        if player_id == "—":
            player_id = ""
        s = q(f"SELECT * FROM skus WHERE public_id={PH} OR CAST(id AS TEXT)={PH}", (str(prod_ref), str(prod_ref)), one=True)
        if USE_PG:
            s = q(f"SELECT * FROM skus WHERE public_id={PH} OR id::text={PH}", (str(prod_ref), str(prod_ref)), one=True)
        if not s:
            return None, (jsonify({"status": "error", "code": 114, "message": "unknown product"}), 404)
        _pch = q(f"SELECT active FROM products WHERE id={PH}", (s.get("product_id"),), one=True)
        if _pch and _pch.get("active") == 0:
            return None, (jsonify({"status": "error", "code": 105, "message": "product unavailable"}), 400)
        try:
            qty = int(qty or 1)
        except Exception:
            return None, (jsonify({"status": "error", "code": 106, "message": "qty not allowed"}), 400)
        if qty < (s.get("min_qty") or 1):
            return None, (jsonify({"status": "error", "code": 112, "message": "qty too small"}), 400)
        if (s.get("max_qty") or 0) and qty > s["max_qty"]:
            return None, (jsonify({"status": "error", "code": 113, "message": "qty too large"}), 400)
        if not s.get("available"):
            return None, (jsonify({"status": "error", "code": 105, "message": "qty unavailable"}), 400)
        price_one, _ = effective_price(s, u)
        total = round(price_one * qty / (s.get("unit_qty") or 1), 5)
        if float(u.get("balance_usd") or 0) < total:
            return None, (jsonify({"status": "error", "code": 100, "message": "insufficient balance"}), 400)
        if uuid and q(f"SELECT id FROM orders WHERE uuid={PH}", (uuid,), one=True):
            old = q(f"SELECT * FROM orders WHERE uuid={PH}", (uuid,), one=True)
            return {"order_id": f"ID_{old['id']}", "status": "processing", "price": float(old.get("price_usd") or 0),
                    "data": {"playerId": player_id}, "replay_api": []}, None
        p = q(f"SELECT name FROM products WHERE id={PH}", (s.get("product_id"),), one=True)
        track = "TRK-%d-%s" % (u["id"], secrets.token_hex(4).upper())
        oid = w(f"INSERT INTO orders(user_id,sku_id,product_name,category_name,player_id,qty,currency,price_usd,price_syp,cost_usd,status,source,track,uuid,raw_status,created_at) VALUES({PH},{PH},{PH},{PH},{PH},{PH},'USD',{PH},{PH},{PH},'pending','api',{PH},{PH},'pending',{PH})",
                (u["id"], s["id"], (p or {}).get("name") or "", s["name"], player_id or "", qty,
                 total, usd_to_syp(total), float(s.get("cost_usd") or 0), track, uuid, NOW()))
        w(f"UPDATE users SET balance_usd=balance_usd-{PH} WHERE id={PH}", (total, u["id"]))
        if s.get("provider_id"):
            prov = q(f"SELECT * FROM providers WHERE id={PH}", (s["provider_id"],), one=True)
            if prov:
                info, _ = provider_call(prov, "order", {"product": s.get("api_product_id"), "api_product": s.get("api_product_id"),
                                                        "product_name": s["name"], "player_id": player_id,
                                                        "qty": qty, "order_id": oid,
                                                        "buyer_ref": f"AS-API-{oid}"})
                if info:
                    w(f"UPDATE orders SET ext_order_id={PH} WHERE id={PH}", (str(info.get("order_id") or info.get("id") or ""), oid))
        auto_tier(u["id"])
        return {"order_id": f"ID_{oid}", "status": "processing", "price": total,
                "data": {"playerId": player_id}, "replay_api": []}, None

    @app.route("/client/api/newOrder/<prod>", methods=["GET", "POST"])
    @app.route("/client/api/newOrder/<prod>/params", methods=["GET", "POST"])
    def r_new_order(prod):
        u, e = reseller_auth()
        if e:
            return e
        src = request.values.to_dict()
        body = request.get_json(force=True, silent=True) or {}
        src.update(body)
        data, errr = reseller_order(u, prod, src.get("playerId") or src.get("player_id"),
                                    src.get("qty"), src.get("order_uuid"))
        if errr:
            return errr
        return jsonify({"status": "OK", "data": data})

    @app.get("/client/api/check")
    def r_check():
        u, e = reseller_auth()
        if e:
            return e
        raw = request.args.get("orders") or "[]"
        try:
            want = json.loads(raw)
        except Exception:
            want = []
        by_uuid = request.args.get("uuid") == "1"
        out = []
        for ref in want:
            if by_uuid:
                r = q(f"SELECT * FROM orders WHERE uuid={PH} AND user_id={PH}", (str(ref), u["id"]), one=True)
            else:
                num = str(ref).replace("ID_", "")
                r = q(f"SELECT * FROM orders WHERE id={PH} AND user_id={PH}", (int(num) if num.isdigit() else -1, u["id"]), one=True)
            if not r:
                continue
            reps = []
            try:
                reps = [x.get("text", "") if isinstance(x, dict) else str(x) for x in json.loads(r.get("replies") or "[]")]
            except Exception:
                reps = []
            out.append({"order_id": f"ID_{r['id']}", "quantity": r.get("qty") or 1,
                        "data": {"playerId": r.get("player_id") or ""}, "created_at": r.get("created_at") or "",
                        "product_name": r.get("product_name") or "", "price": str(r.get("price_usd") or 0),
                        "status": "accept" if r.get("status") == "accepted" else r.get("status"), "replay_api": reps})
        return jsonify({"status": "OK", "data": out})

    @app.post("/api/v1/order")
    def r_v1_order():
        u, e = reseller_auth()
        if e:
            return e
        src = request.values.to_dict()
        body = request.get_json(force=True, silent=True) or {}
        src.update(body)
        data, errr = reseller_order(u, src.get("product_id"), src.get("player_id"), src.get("qty"), src.get("order_uuid"))
        if errr:
            return errr
        return jsonify({"status": "OK", "data": data})

    return app

def search_cards(m):
    """Local catalog search -> product cards for the AI assistant."""
    try:
        words = [w2 for w2 in re.split(r"\s+", m.strip()) if len(w2) > 1][:5]
        found, seen = [], set()
        for wd in words:
            rows = q(f"SELECT s.id,s.name,s.price_usd,s.public_id,s.product_id,p.name AS pname FROM skus s LEFT JOIN products p ON p.id=s.product_id WHERE s.name LIKE {PH} OR p.name LIKE {PH} ORDER BY s.price_usd LIMIT 6", (f"%{wd}%", f"%{wd}%"))
            for r in rows:
                if r["id"] in seen:
                    continue
                seen.add(r["id"])
                found.append({"product_id": r.get("product_id"),
                              "product_name": r.get("pname") or r["name"], "sku_id": str(r.get("public_id") or r["id"]),
                              "sku_name": r["name"], "price": float(r.get("price_usd") or 0), "mode": "both"})
            if len(found) >= 6:
                break
        return found[:6]
    except Exception:
        return []

def ai_answer(msg, history=None, extra=None):
    """Smart local assistant: searches catalog, returns reply + product cards.
    If an external AI API is configured, tries it first, falls back to local."""
    import urllib.request as _url
    api_url = get_setting("ai_agent_api_url", "")
    api_key = get_setting("ai_agent_api_key", "")
    if api_url:
        try:
            msgs = []
            syst = get_setting("ai_agent_prompt", "") or None
            if extra:
                syst = ((syst + "\n") if syst else "") + str(extra)
            try:
                cat = q("SELECT s.name,s.price_usd,p.name AS pname FROM skus s LEFT JOIN products p ON p.id=s.product_id WHERE s.available=1 ORDER BY s.price_usd LIMIT 40")
                if cat:
                    lines = [f"- {(r.get('pname') or '').strip()} / {r['name']}: ${float(r.get('price_usd') or 0):.2f}" for r in cat]
                    syst = ((syst + "\n") if syst else "") + "منتجات المتجر وأسعارها (أجب منها عند السؤال عن المنتجات والأسعار):\n" + "\n".join(lines)
            except Exception:
                pass
            if syst:
                msgs.append({"role": "system", "content": syst})
            for h in (history or [])[-8:]:
                if isinstance(h, dict) and h.get("role") in ("user", "assistant") and h.get("content"):
                    msgs.append({"role": h["role"], "content": str(h["content"])[:1000]})
            msgs.append({"role": "user", "content": msg})
            payload = json.dumps({"model": get_setting("ai_agent_model", "") or "openai/gpt-5-mini",
                                  "messages": msgs}).encode()
            req = _url.Request(api_url, data=payload,
                               headers={"Content-Type": "application/json",
                                        "User-Agent": "ARAB-STORE/1.0",
                                        **({"Authorization": "Bearer " + api_key} if api_key else {})})
            with _url.urlopen(req, timeout=40) as r2:
                info = json.loads(r2.read().decode() or "{}")
            text = ((info.get("choices") or [{}])[0].get("message") or {}).get("content") or info.get("reply") or ""
            if text.strip():
                return text.strip(), search_cards(msg)
        except Exception:
            pass
    m = msg.strip()
    low = m.lower()
    if any(w in m for w in ("سلام", "مرحبا", "اهلا", "أهلا", "هلا", "hello", "hi")) and len(m) < 30:
        return ("أهلاً فيك في ARAB STORE ⚡\nوجهتك الأولى لشحن الألعاب والخدمات الرقمية 🎮\n\n✅ شحن فوري خلال دقائق\n✅ أسعار منافسة وضمان كامل\n✅ دعم متواصل\n\nاكتب اسم اللعبة أو الخدمة اللي تدور عليها.", [])
    if any(w in low for w in ("رصيد", "اشحن", "ايداع", "إيداع", "شحن رصيد", "balance", "deposit")):
        return ("💳 لشحن رصيدك:\n1. ادخل صفحة «إيداع» من القائمة\n2. اختر طريقة الدفع المناسبة\n3. أدخل المبلغ وأرسل الطلب\n4. بعد قبول الإدارة ينضاف الرصيد لمحفظتك ✅", [])
    if any(w in low for w in ("طلب", "تتبع", "وين", "order", "track")):
        return ("📦 لتتبع طلبك:\nافتح صفحة «طلباتي» وشوف حالة كل طلب (قيد التنفيذ / تم الشحن / فشل).\nلو طلبك من مزود API اضغط زر التحديث 🔄", [])
    if any(w in low for w in ("دعم", "تواصل", "ادارة", "إدارة", "support", "telegram")):
        return ("📞 للدعم والاستفسار:\nتيليجرام: @aboudy2312\nمتواجدون على مدار الساعة لخدمتك 🌟", [])
    if any(w in low for w in ("سعر", "اسعار", "أسعار", "بكم", "price")):
        pass  # fall through to catalog search
    # catalog search (runs inside the request's DB context)
    found = search_cards(m)
    if found:
        lines = ["🔍 لقيت لك هالمنتجات:"]
        for c in found[:6]:
            lines.append(f"- {c['product_name']} / {c['sku_name']} — ${c['price']:.2f}")
        lines.append("\nاضغط «عرض المنتج» للتفاصيل أو «شراء» للطلب مباشرة 👇")
        return ("\n".join(lines), found[:6])
    return ("لم أفهم — جرّب صياغة أخرى 🤖\nمثال: اكتب اسم اللعبة (ببجي، فري فاير...) أو اسأل عن شحن الرصيد 📦", [])


# ================= WhatsApp bot helpers (module level) =================
def wa_secret():
    """Shared secret between this server and the WhatsApp connector worker."""
    s = get_setting("wa_secret", "")
    if not s:
        s = secrets.token_urlsafe(24)
        set_setting("wa_secret", s)
    return s


def wa_kv_get(k, default=None):
    try:
        r = q(f"SELECT v FROM wa_kv WHERE k={PH}", (k,), one=True)
        if r and r.get("v") is not None:
            return json.loads(r["v"])
    except Exception:
        pass
    return default


def wa_kv_set(k, v):
    data = json.dumps(v, ensure_ascii=False)
    try:
        if q(f"SELECT k FROM wa_kv WHERE k={PH}", (k,), one=True):
            w(f"UPDATE wa_kv SET v={PH},updated_at={PH} WHERE k={PH}", (data, NOW(), k))
        else:
            w(f"INSERT INTO wa_kv(k,v,updated_at) VALUES({PH},{PH},{PH})", (k, data, NOW()))
    except Exception:
        pass


def wa_kv_del(k):
    try:
        w(f"DELETE FROM wa_kv WHERE k={PH}", (k,))
    except Exception:
        pass


def wa_store_url():
    url = (get_setting("wa_store_url", "") or "").strip()
    if not url:
        url = (get_setting("site_url", "") or "").strip()
    if not url:
        try:
            url = request.host_url.rstrip("/")
        except Exception:
            url = ""
    return url


def wa_status_get():
    return jget("wa_status", {}) or {}


def wa_status_set(d):
    set_setting("wa_status", d if isinstance(d, str) else json.dumps(d, ensure_ascii=False))


def wa_site_context(url):
    name = get_setting("store_name", "ARAB STORE")
    tg = get_setting("support_telegram", "")
    rows = []
    rows.append(f"اسم المتجر: {name}.")
    if url:
        rows.append(f"رابط المتجر الرسمي: {url}")
    if tg:
        rows.append(f"دعم تيليجرام: {tg}")
    rows.append("النشاط: بيع و شحن الألعاب والتطبيقات والخدمات الرقمية.")
    rows.append("الشحن فوري غالباً خلال دقائق، ويتم عبر رقم الآيدي/المعرّف الخاص بحساب اللاعب.")
    rows.append("الدفع يتم عبر رصيد المحفظة، وتغذية الرصيد عبر صفحة الإيداع بطرق الدفع المتاحة.")
    rows.append("عند عدم معرفة معلومة، لا تخترعها ووجّه المستخدم لزيارة رابط المتجر.")
    return "\n".join(rows)


def wa_ai_reply(text, history=None):
    """Reply for an incoming WhatsApp message: AI answer + store link footer."""
    url = wa_store_url()
    try:
        reply, cards = ai_answer(text, history, extra=wa_site_context(url))
    except Exception:
        reply, cards = ("حدث خطأ مؤقت، جرّب بعد قليل 🙏", [])
    unknown = get_setting("wa_reply_unknown", "").strip()
    if not reply or not reply.strip():
        reply = unknown or "ما وصلني سؤالك بوضوح 🤔 اكتب اسم اللعبة أو الخدمة اللي بدك ياها."
    if get_setting("wa_append_link", "true").strip().lower() == "true" and url and url not in reply:
        reply = reply.rstrip() + "\n\n🔗 " + url
    return reply, cards


def wa_log_msg(direction, number, name, body, reply=""):
    try:
        w(f"INSERT INTO wa_messages(direction,number,name,body,reply,created_at) VALUES({PH},{PH},{PH},{PH},{PH},{PH})",
          (direction, str(number or ""), str(name or ""), str(body or "")[:2000], str(reply or "")[:4000], NOW()))
    except Exception:
        pass


def wa_norm_phone(p):
    p = re.sub(r"[^\d]", "", str(p or ""))
    return p


app = create_app()

_db_ready = False
_db_dead_until = 0

@app.before_request
def _ensure_db():
    global _db_ready, _db_dead_until
    import time as _t
    if _db_ready:
        return None
    if _t.time() < _db_dead_until:
        return jsonify({"message": "قاعدة البيانات غير متاحة حالياً، حاول بعد قليل"}), 503
    try:
        init_db(app)
        _db_ready = True
    except Exception:
        _db_dead_until = _t.time() + 60
        return jsonify({"message": "تعذّر الاتصال بقاعدة البيانات، حاول بعد قليل"}), 503
    return None

@app.errorhandler(500)
def _json_500(ex):
    return jsonify({"message": "خطأ مؤقت بالسيرفر، حاول بعد قليل"}), 500

@app.errorhandler(404)
def _json_404(ex):
    if (request.path or "").startswith(("/api", "/client", "/uploads", "/health", "/site-icon")):
        return jsonify({"message": "غير موجود"}), 404
    return ex

if __name__ == "__main__":
    init_db(app)
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "5000")))

