const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data', 'wiki');

function sendJSON(res, obj, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function listPages() {
  try {
    return fs.readdirSync(DATA_DIR)
      .filter(f => f.endsWith('.md'))
      .map(f => ({ slug: f.replace(/\.md$/, ''), title: f.replace(/\.md$/, '').replace(/-/g, ' ') }));
  } catch (e) {
    return [];
  }
}

function readPage(name) {
  try {
    return fs.readFileSync(path.join(DATA_DIR, name + '.md'), 'utf8');
  } catch (e) {
    return null;
  }
}

function savePage(slug, content) {
  if (!slug) return false;
  if (slug.includes('..') || /[\\/]/.test(slug)) return false;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(path.join(DATA_DIR, slug + '.md'), content, 'utf8');
    return true;
  } catch (e) {
    return false;
  }
}

function serveStatic(req, res, pathname) {
  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  // if directory, serve index.html
  if (filePath.endsWith(path.sep)) filePath = path.join(filePath, 'index.html');
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const map = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
    res.writeHead(200, { 'Content-Type': map[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname || '/';

  if (pathname.startsWith('/api/')) {
    // API: list pages
    if (req.method === 'GET' && pathname === '/api/pages') {
      sendJSON(res, listPages());
      return;
    }

    // API: get page by name query param
    if (req.method === 'GET' && pathname === '/api/page') {
      const name = parsed.query.name;
      if (!name) { sendJSON(res, { error: 'name required' }, 400); return; }
      const content = readPage(name);
      if (content === null) { sendJSON(res, { error: 'not found' }, 404); return; }
      sendJSON(res, { name, content });
      return;
    }

    // API: save page
    if (req.method === 'POST' && pathname === '/api/page') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const j = JSON.parse(body);
          if (!j.name || typeof j.content !== 'string') { sendJSON(res, { error: 'name and content required' }, 400); return; }
          const ok = savePage(j.name, j.content);
          if (!ok) { sendJSON(res, { error: 'failed to save' }, 500); return; }
          sendJSON(res, { ok: true, name: j.name });
        } catch (e) {
          sendJSON(res, { error: 'invalid json' }, 400);
        }
      });
      return;
    }

    sendJSON(res, { error: 'api not found' }, 404);
    return;
  }

  // else serve static
  serveStatic(req, res, pathname);
});

function ensureWelcome() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const welcome = path.join(DATA_DIR, 'welcome.md');
    if (!fs.existsSync(welcome)) {
      fs.writeFileSync(welcome, '# Welcome\n\nThis is your personal local wiki. Use the web UI to create and edit pages.\n', 'utf8');
    }
  } catch (e) {
    console.error('ensureWelcome error', e);
  }
}

ensureWelcome();

server.listen(PORT, () => { console.log('Listening on port ' + PORT); });
