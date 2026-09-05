const HTML = { "content-type": "text/html; charset=UTF-8" };
const JSONH = { "content-type": "application/json; charset=UTF-8" };
const CATALOG_KEY = "_system/store.json";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/") return new Response(storePage(), { headers: HTML });

    if (path === "/api/store" && request.method === "GET") {
      const apps = (await readCatalog(env))
        .filter((app) => app.published)
        .sort((a, b) => String(a.name).localeCompare(String(b.name), "pt-BR"))
        .map(publicApp);
      return json(apps);
    }

    if (path === "/admin") {
      if (!isAdmin(request, env)) return unauthorized();
      return new Response(adminPage(), { headers: HTML });
    }

    if (path.startsWith("/api/")) {
      if (!isAdmin(request, env)) return unauthorized();

      if (path === "/api/files" && request.method === "GET") {
        const listed = await env.FILES.list({ limit: 500, include: ["customMetadata"] });
        return json(listed.objects
          .filter((o) => !o.key.startsWith("_system/") && !o.key.startsWith("store/"))
          .map(fileInfo));
      }

      if (path === "/api/upload" && request.method === "POST") {
        try {
          const form = await request.formData();
          const file = form.get("file");
          if (!(file instanceof File)) return json({ error: "Arquivo não enviado" }, 400);

          const clean = sanitizeFilename(file.name);
          const realFormat = extensionOf(file.name);
          const folder = sanitizeFolder(form.get("folder") || inferFolder(file.name));
          const displayName = String(form.get("displayName") || removeExtension(file.name)).trim().slice(0, 160);
          const shortUrl = normalizeOptionalUrl(form.get("shortUrl"), "Link encurtado");
          if (shortUrl.error) return json({ error: shortUrl.error }, 400);
          const downloaderCode = realFormat === "APK" ? String(form.get("downloaderCode") || "").trim().slice(0, 80) : "";
          const key = `${folder}/${clean}`;
          const existed = await env.FILES.head(key);

          await env.FILES.put(key, file.stream(), {
            httpMetadata: { contentType: file.type || "application/octet-stream" },
            customMetadata: {
              originalName: file.name,
              displayName: displayName || removeExtension(file.name),
              shortUrl: shortUrl.value,
              downloaderCode,
            },
          });

          return json({ ok: true, replaced: Boolean(existed), key, url: fileUrl(key) });
        } catch (err) {
          return json({ error: "Falha ao enviar arquivo", detail: String(err?.message || err) }, 500);
        }
      }

      if (path === "/api/file-meta" && request.method === "PATCH") {
        try {
          const body = await request.json();
          const key = String(body.key || "");
          if (!key || key.startsWith("store/") || key.startsWith("_system/")) return json({ error: "Arquivo inválido" }, 400);
          const object = await env.FILES.get(key);
          if (!object) return json({ error: "Arquivo não encontrado" }, 404);
          const old = object.customMetadata || {};
          const originalName = old.originalName || key.split("/").pop() || "arquivo";
          const shortUrl = normalizeOptionalUrl(body.shortUrl, "Link encurtado");
          if (shortUrl.error) return json({ error: shortUrl.error }, 400);
          const downloaderCode = extensionOf(originalName) === "APK" ? String(body.downloaderCode || "").trim().slice(0, 80) : "";
          await env.FILES.put(key, object.body, {
            httpMetadata: object.httpMetadata,
            customMetadata: {
              ...old,
              originalName,
              displayName: String(body.displayName || removeExtension(originalName)).trim().slice(0, 160),
              shortUrl: shortUrl.value,
              downloaderCode,
            },
          });
          return json({ ok: true });
        } catch (err) {
          return json({ error: "Falha ao atualizar informações", detail: String(err?.message || err) }, 500);
        }
      }

      if (path.startsWith("/api/files/") && request.method === "DELETE") {
        const key = decodeURIComponent(path.slice("/api/files/".length));
        if (!key || key.startsWith("store/") || key.startsWith("_system/")) return json({ error: "Arquivo inválido" }, 400);
        await env.FILES.delete(key);
        return json({ ok: true });
      }

      if (path === "/api/apps" && request.method === "GET") {
        return json(await readCatalog(env));
      }

      if (path === "/api/apps" && request.method === "POST") {
        return handleCreateApp(request, env);
      }

      if (path.startsWith("/api/apps/") && request.method === "PATCH") {
        const id = decodeURIComponent(path.slice("/api/apps/".length));
        return handleUpdateApp(request, env, id);
      }

      if (path.startsWith("/api/apps/") && request.method === "DELETE") {
        const id = decodeURIComponent(path.slice("/api/apps/".length));
        return handleDeleteApp(env, id);
      }

      return json({ error: "Rota não encontrada" }, 404);
    }

    if (path.startsWith("/files/") && request.method === "GET") {
      const key = decodeURIComponent(path.slice("/files/".length));
      const object = await env.FILES.get(key);
      if (!object) return new Response("Arquivo não encontrado", { status: 404 });
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set("etag", object.httpEtag);
      headers.set("cache-control", "public, max-age=3600");
      const originalName = object.customMetadata?.originalName || key.split("/").pop();
      const disposition = String(originalName).toLowerCase().endsWith(".apk") ? "attachment" : "inline";
      headers.set("content-disposition", `${disposition}; filename*=UTF-8''${encodeURIComponent(originalName)}`);
      return new Response(object.body, { headers });
    }

    return new Response("Not found", { status: 404 });
  },
};

async function handleCreateApp(request, env) {
  const createdKeys = [];
  try {
    const form = await request.formData();
    const name = String(form.get("name") || "").trim().slice(0, 160);
    const apk = form.get("apk");
    const logo = form.get("logo");
    const layout = form.get("layout");
    if (!name) return json({ error: "Informe o nome do aplicativo" }, 400);
    if (!(apk instanceof File) || extensionOf(apk.name) !== "APK") return json({ error: "Selecione um arquivo APK" }, 400);

    const shortUrl = normalizeOptionalUrl(form.get("shortUrl"), "Link Abrela");
    if (shortUrl.error) return json({ error: shortUrl.error }, 400);
    const id = crypto.randomUUID();
    const prefix = `store/${id}`;

    const apkKey = `${prefix}/apk/${sanitizeFilename(apk.name)}`;
    await putStoreFile(env, apkKey, apk);
    createdKeys.push(apkKey);

    let logoKey = "";
    if (logo instanceof File && logo.size > 0) {
      logoKey = `${prefix}/logo/${sanitizeFilename(logo.name)}`;
      await putStoreFile(env, logoKey, logo);
      createdKeys.push(logoKey);
    }

    let layoutKey = "";
    if (layout instanceof File && layout.size > 0) {
      layoutKey = `${prefix}/layout/${sanitizeFilename(layout.name)}`;
      await putStoreFile(env, layoutKey, layout);
      createdKeys.push(layoutKey);
    }

    const now = new Date().toISOString();
    const app = {
      id,
      name,
      version: String(form.get("version") || "").trim().slice(0, 60),
      description: String(form.get("description") || "").trim().slice(0, 700),
      shortUrl: shortUrl.value,
      downloaderCode: String(form.get("downloaderCode") || "").trim().slice(0, 80),
      published: truthy(form.get("published")),
      apkKey,
      apkName: apk.name,
      apkSize: apk.size,
      logoKey,
      layoutKey,
      createdAt: now,
      updatedAt: now,
    };

    const catalog = await readCatalog(env);
    catalog.push(app);
    await writeCatalog(env, catalog);
    return json({ ok: true, app });
  } catch (err) {
    if (createdKeys.length) await env.FILES.delete(createdKeys).catch(() => {});
    return json({ error: "Falha ao criar aplicativo", detail: String(err?.message || err) }, 500);
  }
}

async function handleUpdateApp(request, env, id) {
  const newKeys = [];
  try {
    const catalog = await readCatalog(env);
    const index = catalog.findIndex((x) => x.id === id);
    if (index < 0) return json({ error: "Aplicativo não encontrado" }, 404);
    const old = catalog[index];
    const form = await request.formData();
    const name = String(form.get("name") || "").trim().slice(0, 160);
    if (!name) return json({ error: "Informe o nome do aplicativo" }, 400);
    const shortUrl = normalizeOptionalUrl(form.get("shortUrl"), "Link Abrela");
    if (shortUrl.error) return json({ error: shortUrl.error }, 400);

    const prefix = `store/${id}`;
    let apkKey = old.apkKey;
    let apkName = old.apkName;
    let apkSize = old.apkSize || 0;
    let logoKey = old.logoKey || "";
    let layoutKey = old.layoutKey || "";

    const apk = form.get("apk");
    if (apk instanceof File && apk.size > 0) {
      if (extensionOf(apk.name) !== "APK") return json({ error: "O arquivo do aplicativo precisa ser APK" }, 400);
      const nextKey = `${prefix}/apk/${sanitizeFilename(apk.name)}`;
      await putStoreFile(env, nextKey, apk);
      newKeys.push(nextKey);
      apkKey = nextKey;
      apkName = apk.name;
      apkSize = apk.size;
    }

    const logo = form.get("logo");
    if (logo instanceof File && logo.size > 0) {
      const nextKey = `${prefix}/logo/${sanitizeFilename(logo.name)}`;
      await putStoreFile(env, nextKey, logo);
      newKeys.push(nextKey);
      logoKey = nextKey;
    }

    const layout = form.get("layout");
    if (layout instanceof File && layout.size > 0) {
      const nextKey = `${prefix}/layout/${sanitizeFilename(layout.name)}`;
      await putStoreFile(env, nextKey, layout);
      newKeys.push(nextKey);
      layoutKey = nextKey;
    }

    if (truthy(form.get("removeLogo"))) logoKey = "";
    if (truthy(form.get("removeLayout"))) layoutKey = "";

    const updated = {
      ...old,
      name,
      version: String(form.get("version") || "").trim().slice(0, 60),
      description: String(form.get("description") || "").trim().slice(0, 700),
      shortUrl: shortUrl.value,
      downloaderCode: String(form.get("downloaderCode") || "").trim().slice(0, 80),
      published: truthy(form.get("published")),
      apkKey,
      apkName,
      apkSize,
      logoKey,
      layoutKey,
      updatedAt: new Date().toISOString(),
    };

    catalog[index] = updated;
    await writeCatalog(env, catalog);

    const stale = [old.apkKey, old.logoKey, old.layoutKey]
      .filter(Boolean)
      .filter((key) => ![apkKey, logoKey, layoutKey].includes(key));
    if (stale.length) await env.FILES.delete(stale).catch(() => {});
    return json({ ok: true, app: updated });
  } catch (err) {
    if (newKeys.length) await env.FILES.delete(newKeys).catch(() => {});
    return json({ error: "Falha ao atualizar aplicativo", detail: String(err?.message || err) }, 500);
  }
}

async function handleDeleteApp(env, id) {
  try {
    const catalog = await readCatalog(env);
    const app = catalog.find((x) => x.id === id);
    if (!app) return json({ error: "Aplicativo não encontrado" }, 404);
    await deletePrefix(env, `store/${id}/`);
    await writeCatalog(env, catalog.filter((x) => x.id !== id));
    return json({ ok: true });
  } catch (err) {
    return json({ error: "Falha ao excluir aplicativo", detail: String(err?.message || err) }, 500);
  }
}

async function putStoreFile(env, key, file) {
  await env.FILES.put(key, file.stream(), {
    httpMetadata: { contentType: file.type || "application/octet-stream" },
    customMetadata: { originalName: file.name },
  });
}

async function deletePrefix(env, prefix) {
  let cursor;
  do {
    const page = await env.FILES.list({ prefix, limit: 1000, cursor });
    const keys = page.objects.map((o) => o.key);
    if (keys.length) await env.FILES.delete(keys);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

async function readCatalog(env) {
  const object = await env.FILES.get(CATALOG_KEY);
  if (!object) return [];
  try {
    const data = JSON.parse(await object.text());
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function writeCatalog(env, apps) {
  await env.FILES.put(CATALOG_KEY, JSON.stringify(apps), {
    httpMetadata: { contentType: "application/json; charset=UTF-8" },
  });
}

function publicApp(app) {
  return {
    id: app.id,
    name: app.name,
    version: app.version || "",
    description: app.description || "",
    shortUrl: app.shortUrl || "",
    downloaderCode: app.downloaderCode || "",
    apkName: app.apkName || "app.apk",
    apkSize: app.apkSize || 0,
    apkUrl: app.apkKey ? fileUrl(app.apkKey) : "",
    logoUrl: app.logoKey ? fileUrl(app.logoKey) : "",
    layoutUrl: app.layoutKey ? fileUrl(app.layoutKey) : "",
  };
}

function fileInfo(o) {
  const base = o.key.split("/").pop() || o.key;
  const fallbackOriginal = base.replace(/^\d{10,}-/, "");
  const originalName = o.customMetadata?.originalName || fallbackOriginal;
  return {
    key: o.key,
    name: o.customMetadata?.displayName || removeExtension(originalName),
    originalName,
    format: extensionOf(originalName),
    shortUrl: o.customMetadata?.shortUrl || "",
    downloaderCode: o.customMetadata?.downloaderCode || "",
    size: o.size,
    uploaded: o.uploaded,
    url: fileUrl(o.key),
  };
}

function truthy(value) {
  return value === "1" || value === "true" || value === "on" || value === true;
}

function normalizeOptionalUrl(value, label) {
  const v = String(value || "").trim();
  if (!v) return { value: "" };
  if (!/^https?:\/\//i.test(v)) return { value: "", error: `${label || "Link"} precisa começar com http:// ou https://` };
  if (v.length > 500) return { value: "", error: `${label || "Link"} muito longo` };
  return { value: v };
}

function fileUrl(key) {
  return "/files/" + String(key).split("/").map(encodeURIComponent).join("/");
}

function extensionOf(name) {
  const base = String(name).split("/").pop() || "";
  const i = base.lastIndexOf(".");
  return i > 0 && i < base.length - 1 ? base.slice(i + 1).toUpperCase() : "ARQUIVO";
}

function removeExtension(name) {
  const base = String(name).split("/").pop() || "";
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(0, i) : base;
}

function sanitizeFilename(name) {
  return String(name)
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "arquivo";
}

function sanitizeFolder(value) {
  const v = String(value).toLowerCase();
  return ["apks", "images", "files"].includes(v) ? v : "files";
}

function inferFolder(name) {
  const lower = String(name).toLowerCase();
  if (lower.endsWith(".apk")) return "apks";
  if (/\.(png|jpe?g|webp|gif|svg)$/i.test(lower)) return "images";
  return "files";
}

function isAdmin(request, env) {
  if (!env.ADMIN_PASSWORD) return false;
  const auth = request.headers.get("authorization") || "";
  if (!auth.startsWith("Basic ")) return false;
  try {
    const decoded = atob(auth.slice(6));
    const i = decoded.indexOf(":");
    const user = i >= 0 ? decoded.slice(0, i) : "";
    const pass = i >= 0 ? decoded.slice(i + 1) : "";
    return user === "admin" && pass === env.ADMIN_PASSWORD;
  } catch {
    return false;
  }
}

function unauthorized() {
  return new Response("Acesso restrito", {
    status: 401,
    headers: { "www-authenticate": 'Basic realm="TVON Store Admin", charset="UTF-8"' },
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSONH });
}

function storePage() {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#080b12"><title>TVON Store</title><style>:root{color-scheme:dark;--bg:#080b12;--panel:#0e1421;--line:#20283a;--muted:#8f9aab;--blue:#2d7cff}*{box-sizing:border-box}body{margin:0;font-family:Inter,system-ui,-apple-system,Segoe UI,Arial;background:radial-gradient(circle at 20% -10%,#152449 0,transparent 32%),var(--bg);color:#f5f7fb;min-height:100vh}.wrap{max-width:1180px;margin:auto;padding:30px 20px 60px}.top{display:flex;justify-content:space-between;align-items:center;margin-bottom:28px}.brand{font-size:28px;font-weight:900}.brand span{color:#6fa7ff}.tag{font-size:12px;color:#aab5c7;border:1px solid #26324a;background:#0d1422;padding:7px 10px;border-radius:999px}.hero{border:1px solid var(--line);border-radius:28px;padding:36px;background:linear-gradient(135deg,#111827,#0a1020 70%)}.hero h1{font-size:clamp(30px,6vw,48px);letter-spacing:-1.5px;margin:0 0 10px}.hero p{margin:0;color:#9ba7ba}.search{margin-top:22px;width:100%;border:1px solid #2a3650;background:#090f1a;color:#fff;border-radius:14px;padding:14px 16px;font:inherit}.section{display:flex;justify-content:space-between;align-items:end;margin:28px 0 15px}.section h2{margin:0;font-size:20px}.count{font-size:13px;color:var(--muted)}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:18px}.card{border:1px solid var(--line);background:linear-gradient(180deg,#0f1625,#0c121e);border-radius:22px;overflow:hidden;display:flex;flex-direction:column}.shot{aspect-ratio:16/9;background:#111a2b;overflow:hidden}.shot img{width:100%;height:100%;object-fit:cover}.body{padding:18px;display:flex;flex-direction:column;flex:1}.head{display:flex;gap:13px;align-items:center}.logo{width:62px;height:62px;border-radius:16px;border:1px solid #283550;background:#111a2b;display:grid;place-items:center;overflow:hidden;flex:0 0 auto;font-weight:900;font-size:24px;color:#76aaff}.logo img{width:100%;height:100%;object-fit:cover}.title{min-width:0}.title h3{margin:0 0 5px;font-size:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.meta{font-size:12px;color:#8996aa}.desc{color:#aab5c6;font-size:13px;line-height:1.45;margin:15px 0;min-height:38px}.code{display:flex;align-items:center;justify-content:space-between;gap:8px;border:1px dashed #34425d;background:#0a101b;padding:10px 12px;border-radius:12px;margin-top:auto}.code span{font-size:12px;color:#8d99aa}.code strong{font-size:17px}.code button{border:0;background:transparent;color:#74a8ff;cursor:pointer;font-weight:700}.actions{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-top:12px}.btn{display:flex;align-items:center;justify-content:center;text-decoration:none;border-radius:12px;padding:12px 10px;font-weight:800;font-size:13px;border:1px solid #2a3650;color:#cad7eb;background:#121c2d}.btn.primary{background:var(--blue);border-color:var(--blue);color:#fff}.btn.full{grid-column:1/-1}.empty{padding:55px 20px;border:1px dashed #2a3650;border-radius:18px;text-align:center;color:#8895a8}.footer{text-align:center;color:#657186;font-size:12px;margin-top:34px}@media(max-width:560px){.wrap{padding:20px 14px 45px}.hero{padding:25px 20px}.actions{grid-template-columns:1fr}.btn.full{grid-column:auto}.tag{display:none}}</style></head><body><div class="wrap"><div class="top"><div class="brand">TVON <span>Store</span></div><div class="tag">APKs para Android</div></div><section class="hero"><h1>Aplicativos em um só lugar.</h1><p>Baixe seus apps com acesso rápido e organizado.</p><input id="search" class="search" type="search" placeholder="Pesquisar aplicativo..."></section><div class="section"><h2>Aplicativos</h2><div id="count" class="count"></div></div><div id="grid" class="grid"><div class="empty">Carregando aplicativos...</div></div><div class="footer">TVON Store</div></div><script>const grid=document.getElementById('grid'),search=document.getElementById('search'),count=document.getElementById('count');let apps=[];function fmt(n){if(n<1024)return n+' B';if(n<1048576)return(n/1024).toFixed(1)+' KB';return(n/1048576).toFixed(1)+' MB'}function initials(n){return String(n||'A').trim().slice(0,2).toUpperCase()}async function copyText(t,b){try{await navigator.clipboard.writeText(t);const x=b.textContent;b.textContent='Copiado!';setTimeout(function(){b.textContent=x},1200)}catch{prompt('Copie:',t)}}function render(){const q=search.value.trim().toLowerCase();const list=!q?apps:apps.filter(function(a){return[a.name,a.version,a.description,a.downloaderCode].join(' ').toLowerCase().includes(q)});grid.replaceChildren();count.textContent=list.length+(list.length===1?' aplicativo':' aplicativos');if(!list.length){const e=document.createElement('div');e.className='empty';e.textContent=q?'Nenhum aplicativo encontrado.':'Nenhum aplicativo publicado ainda.';grid.appendChild(e);return}list.forEach(function(a){const card=document.createElement('article');card.className='card';if(a.layoutUrl){const shot=document.createElement('div');shot.className='shot';const si=document.createElement('img');si.src=a.layoutUrl;si.alt='';si.loading='lazy';shot.appendChild(si);card.appendChild(shot)}const body=document.createElement('div');body.className='body';const head=document.createElement('div');head.className='head';const logo=document.createElement('div');logo.className='logo';if(a.logoUrl){const im=document.createElement('img');im.src=a.logoUrl;im.alt='';im.loading='lazy';im.onerror=function(){logo.replaceChildren(document.createTextNode(initials(a.name)))};logo.appendChild(im)}else{logo.textContent=initials(a.name)}const title=document.createElement('div');title.className='title';const h=document.createElement('h3');h.textContent=a.name;const meta=document.createElement('div');meta.className='meta';meta.textContent=(a.version?'Versão '+a.version+' • ':'')+fmt(a.apkSize);title.append(h,meta);head.append(logo,title);body.appendChild(head);const d=document.createElement('div');d.className='desc';d.textContent=a.description||'Aplicativo disponível para download.';body.appendChild(d);if(a.downloaderCode){const c=document.createElement('div');c.className='code';const s=document.createElement('span');s.textContent='Código Downloader';const st=document.createElement('strong');st.textContent=a.downloaderCode;const cb=document.createElement('button');cb.type='button';cb.textContent='Copiar';cb.addEventListener('click',function(){copyText(a.downloaderCode,cb)});c.append(s,st,cb);body.appendChild(c)}const act=document.createElement('div');act.className='actions';const dl=document.createElement('a');dl.className='btn primary'+(a.shortUrl?'':' full');dl.href=a.apkUrl;dl.textContent='Baixar APK';act.appendChild(dl);if(a.shortUrl){const sh=document.createElement('a');sh.className='btn';sh.href=a.shortUrl;sh.target='_blank';sh.rel='noopener';sh.textContent='Link rápido';act.appendChild(sh)}body.appendChild(act);card.appendChild(body);grid.appendChild(card)})}fetch('/api/store').then(function(r){if(!r.ok)throw new Error();return r.json()}).then(function(d){apps=Array.isArray(d)?d:[];render()}).catch(function(){grid.innerHTML='<div class="empty">Não foi possível carregar os aplicativos.</div>';count.textContent=''});search.addEventListener('input',render);</script></body></html>`;
}

function adminPage() {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TVON Store • Admin</title><style>:root{color-scheme:dark;--bg:#080b12;--panel:#0e1421;--panel2:#0a101b;--line:#20283a;--muted:#8793a7;--blue:#2878ff}*{box-sizing:border-box}body{margin:0;font-family:Inter,system-ui,-apple-system,Segoe UI,Arial;background:var(--bg);color:#f4f7fb}.shell{min-height:100vh;display:grid;grid-template-columns:230px 1fr}.side{border-right:1px solid var(--line);background:#090e18;padding:24px 16px;position:sticky;top:0;height:100vh}.brand{font-size:22px;font-weight:900;padding:0 10px 22px}.brand span{color:#6fa7ff}.nav{display:grid;gap:7px}.nav button,.nav a{width:100%;border:0;background:transparent;color:#98a6bb;text-align:left;padding:12px 13px;border-radius:11px;font:inherit;font-weight:700;text-decoration:none;cursor:pointer}.nav button.active{background:#17233a;color:#fff}.nav a{margin-top:14px;border-top:1px solid #1d2637;border-radius:0;padding-top:18px}.main{padding:30px;max-width:1250px;width:100%;margin:0 auto}.heading{display:flex;justify-content:space-between;align-items:end;gap:15px;margin-bottom:22px}.heading h1{margin:0;font-size:27px}.sub{color:var(--muted);font-size:13px;margin-top:5px}.section{display:none}.section.active{display:block}.box{border:1px solid var(--line);background:var(--panel);border-radius:20px;padding:20px;margin-bottom:18px}.toolbar{display:flex;gap:12px;align-items:center;justify-content:space-between;margin-bottom:14px}.toolbar input{width:min(100%,420px)}input,select,textarea,button{font:inherit}input[type=text],input[type=url],input[type=file],select,textarea{background:var(--panel2);color:#fff;border:1px solid #2a3449;padding:11px;border-radius:10px;min-width:0}textarea{resize:vertical;min-height:100px}button{border:0;border-radius:10px;background:var(--blue);color:#fff;padding:11px 15px;font-weight:750;cursor:pointer}button.secondary{background:#182338;color:#bed2f6}button.danger{background:#2a1014;color:#ff8a95}button.ghost{background:#111a2b;color:#aebbd0}button:disabled{opacity:.55;cursor:not-allowed}.uploadgrid{display:grid;grid-template-columns:1.2fr 1fr 150px auto;gap:10px}.metagrid{display:grid;grid-template-columns:1.2fr .8fr;gap:10px;margin-top:10px}.status{min-height:19px;color:#96a3b7;font-size:13px;margin-top:10px}.status.ok{color:#80e6a2}.status.err{color:#ff8e99}.file-row,.app-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:14px;align-items:center;padding:15px 0;border-bottom:1px solid #1b2333}.file-row:last-child,.app-row:last-child{border-bottom:0}.name{font-weight:800}.meta{font-size:12px;color:var(--muted);margin-top:4px;overflow-wrap:anywhere}.actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}.badge{display:inline-flex;border:1px solid #2c3950;border-radius:999px;padding:4px 8px;font-size:11px;color:#aebbd0;margin-left:7px}.badge.live{border-color:#2e6844;color:#8de8ad;background:#10271a}.empty{padding:22px 0;color:var(--muted)}.editor-shell{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(280px,.7fr);gap:18px}.editor{display:none}.editor.active{display:block}.formgrid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.field{display:grid;gap:6px}.field.full{grid-column:1/-1}.field label{font-size:12px;color:#9ba8bb}.check{display:flex;gap:9px;align-items:center;color:#dce5f2;font-size:14px}.preview{border:1px solid #26324a;background:#0a101b;border-radius:18px;overflow:hidden;align-self:start;position:sticky;top:25px}.preview-shot{aspect-ratio:16/9;background:#111a2b;display:grid;place-items:center;color:#66738a;overflow:hidden}.preview-shot img{width:100%;height:100%;object-fit:cover}.preview-body{padding:16px}.preview-head{display:flex;gap:12px;align-items:center}.preview-logo{width:58px;height:58px;border-radius:14px;background:#111a2b;border:1px solid #2a3650;display:grid;place-items:center;overflow:hidden;font-weight:900;color:#75a7ff}.preview-logo img{width:100%;height:100%;object-fit:cover}.preview h3{margin:0 0 4px}.preview p{color:#97a4b7;font-size:13px;line-height:1.45}.preview-code{border:1px dashed #34425d;border-radius:11px;padding:10px 12px;margin-top:12px;color:#bdc8d8}.editor-actions{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-top:16px}.left-actions,.right-actions{display:flex;gap:8px;flex-wrap:wrap}.current{font-size:12px;color:#8492a8;margin-top:5px}.apps-top{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:15px}@media(max-width:850px){.shell{grid-template-columns:1fr}.side{position:static;height:auto;border-right:0;border-bottom:1px solid var(--line);padding:14px}.brand{padding-bottom:10px}.nav{grid-template-columns:1fr 1fr}.nav a{grid-column:1/-1;margin-top:0;border-top:0;padding-top:12px}.main{padding:20px 14px}.editor-shell{grid-template-columns:1fr}.preview{position:static}.uploadgrid,.metagrid,.formgrid{grid-template-columns:1fr}.field.full{grid-column:auto}.file-row,.app-row{grid-template-columns:1fr}.actions{justify-content:flex-start}.heading{align-items:flex-start;flex-direction:column}}</style></head><body><div class="shell"><aside class="side"><div class="brand">TVON <span>Store</span></div><nav class="nav"><button id="navFiles" class="active" type="button">Arquivos</button><button id="navApps" type="button">Loja de APKs</button><a href="/" target="_blank">Ver loja pública ↗</a></nav></aside><main class="main"><section id="filesSection" class="section active"><div class="heading"><div><h1>Gerenciador de arquivos</h1><div class="sub">Arquivos gerais no R2. Esta área é independente da loja.</div></div></div><div class="box"><div class="uploadgrid"><input id="file" type="file"><input id="displayName" type="text" placeholder="Nome para identificar"><select id="folder"><option value="files">Arquivo</option><option value="images">Imagem</option><option value="apks">APK</option></select><button id="uploadBtn" type="button">Enviar</button></div><div class="metagrid"><input id="shortUrl" type="url" placeholder="Link encurtado (opcional)"><input id="downloaderCode" type="text" placeholder="Código Downloader (se APK)"></div><div id="fileStatus" class="status"></div></div><div class="box"><div class="toolbar"><strong>Arquivos enviados</strong><input id="fileSearch" type="text" placeholder="Pesquisar arquivo..."></div><div id="fileList">Carregando...</div></div></section><section id="appsSection" class="section"><div class="heading"><div><h1>Loja de APKs</h1><div class="sub">Cadastre e publique aplicativos sem misturar com os arquivos gerais.</div></div></div><div id="appsListView"><div class="box"><div class="apps-top"><strong>Aplicativos cadastrados</strong><button id="newAppBtn" type="button">+ Novo aplicativo</button></div><div id="appsList">Carregando...</div></div></div><div id="appEditor" class="editor"><div class="editor-shell"><div class="box"><div class="apps-top"><div><strong id="editorTitle">Novo aplicativo</strong><div class="sub">APK, logo, imagem de layout e dados públicos.</div></div><button id="closeEditor" class="ghost" type="button">Fechar</button></div><form id="appForm"><div class="formgrid"><div class="field"><label>Nome do aplicativo</label><input id="appName" name="name" type="text" maxlength="160" required></div><div class="field"><label>Versão</label><input id="appVersion" name="version" type="text" maxlength="60" placeholder="Ex.: 1.4.2"></div><div class="field full"><label>Descrição</label><textarea id="appDescription" name="description" maxlength="700"></textarea></div><div class="field"><label>Link Abrela</label><input id="appShortUrl" name="shortUrl" type="url" maxlength="500" placeholder="https://abrela.me/..."></div><div class="field"><label>Código Downloader</label><input id="appCode" name="downloaderCode" type="text" maxlength="80"></div><div class="field full"><label>APK <span id="apkHint"></span></label><input id="appApk" name="apk" type="file" accept=".apk,application/vnd.android.package-archive"><div id="currentApk" class="current"></div></div><div class="field"><label>Logo</label><input id="appLogo" name="logo" type="file" accept="image/*"><div id="currentLogo" class="current"></div><label id="removeLogoWrap" class="check" style="display:none"><input id="removeLogo" name="removeLogo" type="checkbox"> Remover logo atual</label></div><div class="field"><label>Imagem de layout</label><input id="appLayout" name="layout" type="file" accept="image/*"><div id="currentLayout" class="current"></div><label id="removeLayoutWrap" class="check" style="display:none"><input id="removeLayout" name="removeLayout" type="checkbox"> Remover imagem atual</label></div><div class="field full"><label class="check"><input id="appPublished" name="published" type="checkbox"> Publicar na loja</label></div></div><div class="editor-actions"><div class="left-actions"><button id="deleteAppBtn" class="danger" type="button" style="display:none">Excluir aplicativo</button></div><div class="right-actions"><button id="cancelAppBtn" class="ghost" type="button">Cancelar</button><button id="saveAppBtn" type="submit">Salvar aplicativo</button></div></div><div id="appStatus" class="status"></div></form></div><aside class="preview"><div id="previewShot" class="preview-shot">Imagem de layout</div><div class="preview-body"><div class="preview-head"><div id="previewLogo" class="preview-logo">AP</div><div><h3 id="previewName">Nome do app</h3><div id="previewVersion" class="meta">Versão</div></div></div><p id="previewDescription">Descrição do aplicativo.</p><div id="previewCode" class="preview-code">Código Downloader</div></div></aside></div></div></section></main></div><script>const navFiles=document.getElementById('navFiles'),navApps=document.getElementById('navApps'),filesSection=document.getElementById('filesSection'),appsSection=document.getElementById('appsSection');function showSection(which){const apps=which==='apps';filesSection.classList.toggle('active',!apps);appsSection.classList.toggle('active',apps);navFiles.classList.toggle('active',!apps);navApps.classList.toggle('active',apps);if(apps)loadApps()}navFiles.addEventListener('click',function(){showSection('files')});navApps.addEventListener('click',function(){showSection('apps')});function fmt(n){if(n<1024)return n+' B';if(n<1048576)return(n/1024).toFixed(1)+' KB';return(n/1048576).toFixed(1)+' MB'}async function readJson(r){const t=await r.text();if(!t)return{};try{return JSON.parse(t)}catch{return{error:t}}}async function copyText(t){try{await navigator.clipboard.writeText(t)}catch{prompt('Copie:',t)}}const fileInput=document.getElementById('file'),displayNameInput=document.getElementById('displayName'),folderInput=document.getElementById('folder'),shortUrlInput=document.getElementById('shortUrl'),downloaderCodeInput=document.getElementById('downloaderCode'),uploadBtn=document.getElementById('uploadBtn'),fileStatus=document.getElementById('fileStatus'),fileSearch=document.getElementById('fileSearch'),fileList=document.getElementById('fileList');let allFiles=[];function setFileStatus(t,c){fileStatus.textContent=t||'';fileStatus.className='status'+(c?' '+c:'')}function renderFiles(){const q=fileSearch.value.trim().toLowerCase();const data=!q?allFiles:allFiles.filter(function(x){return[x.name,x.originalName,x.format,x.shortUrl,x.downloaderCode].join(' ').toLowerCase().includes(q)});fileList.replaceChildren();if(!data.length){const e=document.createElement('div');e.className='empty';e.textContent=q?'Nenhum arquivo encontrado.':'Nenhum arquivo enviado.';fileList.appendChild(e);return}data.forEach(function(x){const row=document.createElement('div');row.className='file-row';const info=document.createElement('div');const n=document.createElement('div');n.className='name';n.textContent=x.name||x.originalName;const b=document.createElement('span');b.className='badge';b.textContent=x.format;n.appendChild(b);const m=document.createElement('div');m.className='meta';m.textContent=x.originalName+' • '+fmt(x.size)+(x.downloaderCode?' • Código '+x.downloaderCode:'');info.append(n,m);const a=document.createElement('div');a.className='actions';const direct=document.createElement('button');direct.type='button';direct.className='secondary';direct.textContent='Link direto';direct.onclick=function(){copyText(location.origin+x.url);setFileStatus('Link copiado.','ok')};const edit=document.createElement('button');edit.type='button';edit.className='ghost';edit.textContent='Editar';edit.onclick=function(){editFile(x)};const del=document.createElement('button');del.type='button';del.className='danger';del.textContent='Excluir';del.onclick=async function(){if(!confirm('Excluir '+x.originalName+' do R2?'))return;const r=await fetch('/api/files/'+encodeURIComponent(x.key),{method:'DELETE'});const j=await readJson(r);if(!r.ok){setFileStatus(j.error||'Falha ao excluir','err');return}setFileStatus('Arquivo excluído do R2.','ok');loadFiles()};a.append(direct,edit,del);row.append(info,a);fileList.appendChild(row)})}async function editFile(x){const name=prompt('Nome:',x.name||'');if(name===null)return;const short=prompt('Link encurtado:',x.shortUrl||'');if(short===null)return;let code=x.downloaderCode||'';if(x.format==='APK'){const c=prompt('Código Downloader:',code);if(c===null)return;code=c}else code='';const r=await fetch('/api/file-meta',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({key:x.key,displayName:name,shortUrl:short,downloaderCode:code})});const j=await readJson(r);if(!r.ok){setFileStatus(j.error||'Falha ao salvar','err');return}setFileStatus('Dados atualizados.','ok');loadFiles()}async function loadFiles(){fileList.textContent='Carregando...';const r=await fetch('/api/files');const j=await readJson(r);if(!r.ok){fileList.textContent=j.error||'Falha ao carregar';return}allFiles=Array.isArray(j)?j:[];renderFiles()}uploadBtn.addEventListener('click',async function(){const f=fileInput.files[0];if(!f){setFileStatus('Selecione um arquivo.','err');return}const fd=new FormData();fd.append('file',f);fd.append('displayName',displayNameInput.value);fd.append('folder',folderInput.value);fd.append('shortUrl',shortUrlInput.value);fd.append('downloaderCode',downloaderCodeInput.value);uploadBtn.disabled=true;setFileStatus('Enviando...');const r=await fetch('/api/upload',{method:'POST',body:fd});const j=await readJson(r);uploadBtn.disabled=false;if(!r.ok){setFileStatus(j.error||'Falha ao enviar','err');return}fileInput.value='';displayNameInput.value='';shortUrlInput.value='';downloaderCodeInput.value='';setFileStatus(j.replaced?'Arquivo substituído mantendo o link.':'Arquivo enviado.','ok');loadFiles()});fileSearch.addEventListener('input',renderFiles);loadFiles();const appsList=document.getElementById('appsList'),appsListView=document.getElementById('appsListView'),appEditor=document.getElementById('appEditor'),newAppBtn=document.getElementById('newAppBtn'),closeEditor=document.getElementById('closeEditor'),cancelAppBtn=document.getElementById('cancelAppBtn'),deleteAppBtn=document.getElementById('deleteAppBtn'),appForm=document.getElementById('appForm'),appStatus=document.getElementById('appStatus'),editorTitle=document.getElementById('editorTitle'),appName=document.getElementById('appName'),appVersion=document.getElementById('appVersion'),appDescription=document.getElementById('appDescription'),appShortUrl=document.getElementById('appShortUrl'),appCode=document.getElementById('appCode'),appApk=document.getElementById('appApk'),appLogo=document.getElementById('appLogo'),appLayout=document.getElementById('appLayout'),appPublished=document.getElementById('appPublished'),currentApk=document.getElementById('currentApk'),currentLogo=document.getElementById('currentLogo'),currentLayout=document.getElementById('currentLayout'),removeLogo=document.getElementById('removeLogo'),removeLayout=document.getElementById('removeLayout'),removeLogoWrap=document.getElementById('removeLogoWrap'),removeLayoutWrap=document.getElementById('removeLayoutWrap'),apkHint=document.getElementById('apkHint'),previewShot=document.getElementById('previewShot'),previewLogo=document.getElementById('previewLogo'),previewName=document.getElementById('previewName'),previewVersion=document.getElementById('previewVersion'),previewDescription=document.getElementById('previewDescription'),previewCode=document.getElementById('previewCode');let appsData=[],editingApp=null,logoObjectUrl='',layoutObjectUrl='';function setAppStatus(t,c){appStatus.textContent=t||'';appStatus.className='status'+(c?' '+c:'')}async function loadApps(){appsList.textContent='Carregando...';const r=await fetch('/api/apps');const j=await readJson(r);if(!r.ok){appsList.textContent=j.error||'Falha ao carregar';return}appsData=Array.isArray(j)?j:[];renderApps()}function renderApps(){appsList.replaceChildren();if(!appsData.length){const e=document.createElement('div');e.className='empty';e.textContent='Nenhum aplicativo cadastrado.';appsList.appendChild(e);return}appsData.forEach(function(a){const row=document.createElement('div');row.className='app-row';const info=document.createElement('div');const n=document.createElement('div');n.className='name';n.textContent=a.name;const b=document.createElement('span');b.className='badge '+(a.published?'live':'');b.textContent=a.published?'PUBLICADO':'RASCUNHO';n.appendChild(b);const m=document.createElement('div');m.className='meta';m.textContent=(a.version?'Versão '+a.version+' • ':'')+(a.apkName||'APK');info.append(n,m);const ac=document.createElement('div');ac.className='actions';const edit=document.createElement('button');edit.type='button';edit.className='secondary';edit.textContent='Editar';edit.onclick=function(){openEditor(a)};const del=document.createElement('button');del.type='button';del.className='danger';del.textContent='Excluir';del.onclick=function(){deleteApp(a)};ac.append(edit,del);row.append(info,ac);appsList.appendChild(row)})}function resetPreviewUrls(){if(logoObjectUrl)URL.revokeObjectURL(logoObjectUrl);if(layoutObjectUrl)URL.revokeObjectURL(layoutObjectUrl);logoObjectUrl='';layoutObjectUrl=''}function openEditor(app){resetPreviewUrls();editingApp=app||null;appForm.reset();editorTitle.textContent=app?'Editar aplicativo':'Novo aplicativo';deleteAppBtn.style.display=app?'inline-flex':'none';apkHint.textContent=app?'(deixe vazio para manter o atual)':'(obrigatório)';currentApk.textContent=app&&app.apkName?'Atual: '+app.apkName:'';currentLogo.textContent=app&&app.logoKey?'Logo atual cadastrada':'';currentLayout.textContent=app&&app.layoutKey?'Imagem atual cadastrada':'';removeLogoWrap.style.display=app&&app.logoKey?'flex':'none';removeLayoutWrap.style.display=app&&app.layoutKey?'flex':'none';if(app){appName.value=app.name||'';appVersion.value=app.version||'';appDescription.value=app.description||'';appShortUrl.value=app.shortUrl||'';appCode.value=app.downloaderCode||'';appPublished.checked=Boolean(app.published)}appsListView.style.display='none';appEditor.classList.add('active');syncPreview()}function closeAppEditor(){resetPreviewUrls();editingApp=null;appEditor.classList.remove('active');appsListView.style.display='block';setAppStatus('');loadApps()}newAppBtn.onclick=function(){openEditor(null)};closeEditor.onclick=closeAppEditor;cancelAppBtn.onclick=closeAppEditor;function syncPreview(){previewName.textContent=appName.value||'Nome do app';previewVersion.textContent=appVersion.value?'Versão '+appVersion.value:'Versão';previewDescription.textContent=appDescription.value||'Descrição do aplicativo.';previewCode.textContent=appCode.value?'Código Downloader: '+appCode.value:'Código Downloader';const logoSrc=logoObjectUrl||(editingApp&&editingApp.logoKey?fileUrlClient(editingApp.logoKey):'');previewLogo.replaceChildren();if(logoSrc){const im=document.createElement('img');im.src=logoSrc;previewLogo.appendChild(im)}else previewLogo.textContent=(appName.value||'AP').slice(0,2).toUpperCase();const layoutSrc=layoutObjectUrl||(editingApp&&editingApp.layoutKey?fileUrlClient(editingApp.layoutKey):'');previewShot.replaceChildren();if(layoutSrc){const im=document.createElement('img');im.src=layoutSrc;previewShot.appendChild(im)}else previewShot.textContent='Imagem de layout'}function fileUrlClient(key){return'/files/'+String(key).split('/').map(encodeURIComponent).join('/')}[appName,appVersion,appDescription,appCode].forEach(function(el){el.addEventListener('input',syncPreview)});appLogo.addEventListener('change',function(){if(logoObjectUrl)URL.revokeObjectURL(logoObjectUrl);logoObjectUrl=this.files[0]?URL.createObjectURL(this.files[0]):'';syncPreview()});appLayout.addEventListener('change',function(){if(layoutObjectUrl)URL.revokeObjectURL(layoutObjectUrl);layoutObjectUrl=this.files[0]?URL.createObjectURL(this.files[0]):'';syncPreview()});appForm.addEventListener('submit',async function(e){e.preventDefault();if(!editingApp&&!appApk.files[0]){setAppStatus('Selecione o APK.','err');return}const fd=new FormData();fd.append('name',appName.value);fd.append('version',appVersion.value);fd.append('description',appDescription.value);fd.append('shortUrl',appShortUrl.value);fd.append('downloaderCode',appCode.value);fd.append('published',appPublished.checked?'1':'0');if(appApk.files[0])fd.append('apk',appApk.files[0]);if(appLogo.files[0])fd.append('logo',appLogo.files[0]);if(appLayout.files[0])fd.append('layout',appLayout.files[0]);if(removeLogo.checked)fd.append('removeLogo','1');if(removeLayout.checked)fd.append('removeLayout','1');setAppStatus('Salvando...');const url=editingApp?'/api/apps/'+encodeURIComponent(editingApp.id):'/api/apps';const method=editingApp?'PATCH':'POST';const r=await fetch(url,{method,body:fd});const j=await readJson(r);if(!r.ok){setAppStatus(j.error||'Falha ao salvar','err');return}setAppStatus('Aplicativo salvo.','ok');setTimeout(closeAppEditor,350)});async function deleteApp(app){if(!confirm('Excluir '+app.name+' e TODOS os arquivos dele do R2?'))return;const r=await fetch('/api/apps/'+encodeURIComponent(app.id),{method:'DELETE'});const j=await readJson(r);if(!r.ok){alert(j.error||'Falha ao excluir');return}if(editingApp&&editingApp.id===app.id)closeAppEditor();else loadApps()}deleteAppBtn.onclick=function(){if(editingApp)deleteApp(editingApp)};</script></body></html>`;
}
