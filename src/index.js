const HTML = { "content-type": "text/html; charset=UTF-8" };
const JSONH = { "content-type": "application/json; charset=UTF-8" };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/") return new Response(storePage(), { headers: HTML });

    if (path === "/admin") {
      if (!isAdmin(request, env)) return unauthorized();
      return new Response(adminPage(), { headers: HTML });
    }

    if (path.startsWith("/api/")) {
      if (!isAdmin(request, env)) return unauthorized();

      if (path === "/api/files" && request.method === "GET") {
        const listed = await env.FILES.list({ limit: 500, include: ["customMetadata"] });
        return json(listed.objects.map((o) => {
          const base = o.key.split("/").pop() || o.key;
          const fallbackOriginal = base.replace(/^\d{10,}-/, "");
          const originalName = o.customMetadata?.originalName || fallbackOriginal;
          const displayName = o.customMetadata?.displayName || removeExtension(originalName);
          const format = extensionOf(originalName);
          return {
            key: o.key,
            name: displayName,
            originalName,
            format,
            size: o.size,
            uploaded: o.uploaded,
            url: fileUrl(o.key),
          };
        }));
      }

      if (path === "/api/upload" && request.method === "POST") {
        try {
          const form = await request.formData();
          const file = form.get("file");
          if (!(file instanceof File)) return json({ error: "Arquivo não enviado" }, 400);

          const folder = sanitizeFolder(form.get("folder") || inferFolder(file.name));
          const clean = sanitizeFilename(file.name);
          const displayNameRaw = String(form.get("displayName") || "").trim();
          const displayName = displayNameRaw || removeExtension(file.name);
          const key = `${folder}/${clean}`;
          const existed = await env.FILES.head(key);

          await env.FILES.put(key, file.stream(), {
            httpMetadata: { contentType: file.type || "application/octet-stream" },
            customMetadata: {
              originalName: file.name,
              displayName: displayName.slice(0, 160),
            },
          });

          return json({
            ok: true,
            replaced: Boolean(existed),
            key,
            name: displayName,
            originalName: file.name,
            format: extensionOf(file.name),
            url: fileUrl(key),
          });
        } catch (err) {
          return json({ error: "Falha ao enviar arquivo", detail: String(err?.message || err) }, 500);
        }
      }

      if (path.startsWith("/api/files/") && request.method === "DELETE") {
        const key = decodeURIComponent(path.slice("/api/files/".length));
        if (!key) return json({ error: "Arquivo inválido" }, 400);
        await env.FILES.delete(key);
        return json({ ok: true });
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

function storePage() {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>TVON Store</title>
<style>
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;font-family:Inter,system-ui,Arial;background:#080b12;color:#f5f7fb}.wrap{max-width:1120px;margin:auto;padding:32px 20px}.top{display:flex;justify-content:space-between;align-items:center;margin-bottom:34px}.brand{font-size:26px;font-weight:800}.brand span{color:#6da8ff}.muted{color:#8f9aab}.hero{padding:34px;border:1px solid #20283a;border-radius:24px;background:linear-gradient(135deg,#111827,#0b1020);margin-bottom:26px}.hero h1{font-size:38px;margin:0 0 8px}.empty{text-align:center;padding:55px 20px;color:#8993a5;border:1px dashed #273149;border-radius:18px}.admin{font-size:13px;color:#8993a5;text-decoration:none}
</style>
</head>
<body>
<div class="wrap">
  <div class="top"><div class="brand">TVON <span>Store</span></div><a class="admin" href="/admin">Admin</a></div>
  <section class="hero"><h1>Aplicativos em um só lugar.</h1><div class="muted">Downloads rápidos e organizados.</div></section>
  <div class="empty">Nenhum aplicativo publicado ainda.</div>
</div>
</body>
</html>`;
}

function adminPage() {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>TVON Store • Admin</title>
<style>
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;font-family:Inter,system-ui,Arial;background:#080b12;color:#f4f7fb}.wrap{max-width:1100px;margin:auto;padding:30px 18px}.top{display:flex;justify-content:space-between;align-items:center;margin-bottom:24px}h1{margin:0;font-size:25px}.sub{color:#8793a7;margin-top:5px}.box{border:1px solid #20283a;background:#0e1421;border-radius:20px;padding:20px;margin-bottom:20px}.drop{border:1px dashed #384764;border-radius:16px;padding:28px;text-align:center}select,input,button{font:inherit}.controls{display:grid;grid-template-columns:minmax(220px,1.3fr) minmax(180px,1fr) 150px auto;gap:10px;margin-top:15px}select,input[type=file],input[type=text]{background:#0a0f19;color:#fff;border:1px solid #2a3449;padding:11px;border-radius:10px;min-width:0}button{background:#2878ff;color:white;border:0;padding:11px 18px;border-radius:10px;font-weight:700;cursor:pointer}button:disabled{opacity:.55;cursor:not-allowed}button.danger{background:#2a1014;color:#ff8a95}.toolbar{display:flex;gap:12px;align-items:center;justify-content:space-between;margin-bottom:12px}.search{width:min(100%,360px)}.row{display:grid;grid-template-columns:minmax(0,1fr) 90px 100px 110px;gap:12px;align-items:center;padding:14px 0;border-bottom:1px solid #1b2333}.row:last-child{border:0}.name{font-weight:700;overflow:hidden;text-overflow:ellipsis;word-break:break-word}.filename{font-size:12px;color:#8793a7;margin-top:4px;overflow-wrap:anywhere}.badge{display:inline-flex;align-items:center;justify-content:center;border:1px solid #2a3449;background:#0a0f19;border-radius:999px;padding:6px 9px;font-size:12px;color:#b9c4d7}.small{font-size:12px;color:#8d98aa}.link{color:#7eacff;text-decoration:none}.status{margin-top:12px;color:#9eabc0;min-height:18px}.status.ok{color:#78e59a}.status.err{color:#ff8a95}.empty{padding:20px 0;color:#8793a7}@media(max-width:760px){.controls{grid-template-columns:1fr}.row{grid-template-columns:1fr 1fr}.row .info{grid-column:1/-1}.toolbar{align-items:stretch;flex-direction:column}.search{width:100%}}
</style>
</head>
<body>
<div class="wrap">
  <div class="top"><div><h1>TVON Store • Admin</h1><div class="sub">Upload e gerenciamento de arquivos no R2</div></div><a class="link" href="/">Ver loja</a></div>
  <div class="box">
    <div class="drop">
      <strong>Enviar arquivo</strong>
      <div class="sub">O nome do arquivo será mantido no link. Enviar o mesmo nome novamente substitui o arquivo e mantém o endereço.</div>
      <div class="controls">
        <input id="file" type="file">
        <input id="displayName" type="text" maxlength="160" placeholder="Nome para identificar (opcional)">
        <select id="folder"><option value="apks">APK</option><option value="images">Imagem</option><option value="files">Outro arquivo</option></select>
        <button id="uploadBtn" type="button">Enviar</button>
      </div>
      <div id="status" class="status"></div>
    </div>
  </div>
  <div class="box">
    <div class="toolbar"><strong>Arquivos enviados</strong><input id="search" class="search" type="text" placeholder="Pesquisar por nome, arquivo ou formato..."></div>
    <div id="list" class="sub">Carregando...</div>
  </div>
</div>
<script>
const fileInput = document.getElementById('file');
const displayNameInput = document.getElementById('displayName');
const folderInput = document.getElementById('folder');
const uploadBtn = document.getElementById('uploadBtn');
const statusEl = document.getElementById('status');
const listEl = document.getElementById('list');
const searchInput = document.getElementById('search');
let allFiles = [];

function fmt(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

function setStatus(text, type) {
  statusEl.textContent = text || '';
  statusEl.className = 'status' + (type ? ' ' + type : '');
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { error: text }; }
}

function renderFiles() {
  const q = searchInput.value.trim().toLowerCase();
  const data = !q ? allFiles : allFiles.filter(function(item) {
    return [item.name, item.originalName, item.format, item.key].join(' ').toLowerCase().includes(q);
  });

  listEl.replaceChildren();
  if (!data.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = q ? 'Nenhum arquivo encontrado.' : 'Nenhum arquivo enviado.';
    listEl.appendChild(empty);
    return;
  }

  data.forEach(function(item) {
    const row = document.createElement('div');
    row.className = 'row';

    const info = document.createElement('div');
    info.className = 'info';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = item.name || item.originalName;
    const filename = document.createElement('div');
    filename.className = 'filename';
    filename.textContent = item.originalName + ' • ' + fmt(item.size);
    info.append(name, filename);

    const format = document.createElement('span');
    format.className = 'badge';
    format.textContent = item.format || 'ARQUIVO';

    const copy = document.createElement('button');
    copy.type = 'button';
    copy.textContent = 'Copiar link';
    copy.addEventListener('click', async function() {
      const full = location.origin + item.url;
      try {
        await navigator.clipboard.writeText(full);
        setStatus('Link copiado: ' + item.originalName, 'ok');
      } catch {
        prompt('Copie o link:', full);
      }
    });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'danger';
    remove.textContent = 'Excluir';
    remove.addEventListener('click', async function() {
      if (!confirm('Excluir ' + item.originalName + '?')) return;
      remove.disabled = true;
      try {
        const response = await fetch('/api/files/' + encodeURIComponent(item.key), { method: 'DELETE', credentials: 'same-origin' });
        const result = await readJson(response);
        if (!response.ok) throw new Error(result.error || 'Falha ao excluir');
        setStatus('Arquivo excluído.', 'ok');
        await loadFiles();
      } catch (err) {
        setStatus(err.message || 'Falha ao excluir.', 'err');
        remove.disabled = false;
      }
    });

    row.append(info, format, copy, remove);
    listEl.appendChild(row);
  });
}

async function loadFiles() {
  listEl.textContent = 'Carregando...';
  try {
    const response = await fetch('/api/files', { credentials: 'same-origin' });
    const data = await readJson(response);
    if (!response.ok) throw new Error(data.error || 'Falha ao carregar arquivos');
    allFiles = Array.isArray(data) ? data : [];
    allFiles.sort(function(a, b) { return String(a.name || a.originalName).localeCompare(String(b.name || b.originalName), 'pt-BR'); });
    renderFiles();
  } catch (err) {
    listEl.textContent = err.message || 'Falha ao carregar arquivos.';
  }
}

fileInput.addEventListener('change', function() {
  const file = fileInput.files[0];
  if (file && !displayNameInput.value.trim()) {
    displayNameInput.value = file.name.replace(/\.[^.]+$/, '');
  }
});

searchInput.addEventListener('input', renderFiles);

uploadBtn.addEventListener('click', async function() {
  const file = fileInput.files[0];
  if (!file) {
    setStatus('Selecione um arquivo.', 'err');
    return;
  }

  const form = new FormData();
  form.append('file', file);
  form.append('folder', folderInput.value);
  form.append('displayName', displayNameInput.value.trim());

  uploadBtn.disabled = true;
  setStatus('Enviando...');

  try {
    const response = await fetch('/api/upload', { method: 'POST', body: form, credentials: 'same-origin' });
    const result = await readJson(response);
    if (!response.ok) throw new Error(result.error || 'Falha no upload');
    fileInput.value = '';
    displayNameInput.value = '';
    setStatus(result.replaced ? 'Arquivo atualizado. O link foi mantido.' : 'Enviado com sucesso.', 'ok');
    await loadFiles();
  } catch (err) {
    setStatus(err.message || 'Falha no upload.', 'err');
  } finally {
    uploadBtn.disabled = false;
  }
});

loadFiles();
</script>
</body>
</html>`;
}
