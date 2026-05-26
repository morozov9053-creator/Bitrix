const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const querystring = require('querystring');

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '127.0.0.1';
const publicDir = path.join(__dirname, 'public');
const dataDir = path.join(__dirname, 'data');
const leadsPath = path.join(dataDir, 'leads.json');

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.ico': 'image/x-icon'
};

function ensureStorage() {
  fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(leadsPath)) {
    fs.writeFileSync(leadsPath, '[]\n', 'utf8');
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 100_000) {
        reject(new Error('Payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(payload));
}

function clean(value, maxLength = 160) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

function validateLead(input) {
  const lead = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    name: clean(input.name, 80),
    phone: clean(input.phone, 40),
    level: clean(input.level, 40),
    date: clean(input.date, 40),
    message: clean(input.message, 500),
    source: 'morozov-kite-site'
  };

  const phoneDigits = lead.phone.replace(/\D/g, '');
  if (lead.name.length < 2) return { error: 'Введите имя.' };
  if (phoneDigits.length < 10) return { error: 'Введите телефон для связи.' };
  if (!lead.level) return { error: 'Выберите уровень.' };

  return { lead };
}

function saveLead(lead) {
  ensureStorage();
  const current = JSON.parse(fs.readFileSync(leadsPath, 'utf8'));
  current.unshift(lead);
  fs.writeFileSync(leadsPath, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const safePath = path.normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
  const requestedPath = safePath === '/' ? '/index.html' : safePath;
  const filePath = path.join(publicDir, requestedPath);

  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      fs.readFile(path.join(publicDir, 'index.html'), (fallbackError, fallbackData) => {
        if (fallbackError) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }
        res.writeHead(200, { 'Content-Type': mimeTypes['.html'] });
        res.end(fallbackData);
      });
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const cacheControl = ['.html', '.css', '.js'].includes(ext)
      ? 'no-store'
      : 'public, max-age=3600';

    res.writeHead(200, {
      'Content-Type': mimeTypes[ext] || 'application/octet-stream',
      'Cache-Control': cacheControl
    });
    res.end(data);
  });
}

function parseLeadBody(body, contentType) {
  if (contentType.includes('application/x-www-form-urlencoded')) {
    return querystring.parse(body);
  }

  return JSON.parse(body || '{}');
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'POST' && (req.url === '/api/leads' || req.url === '/')) {
    try {
      const body = await readBody(req);
      const input = parseLeadBody(body, req.headers['content-type'] || '');
      const result = validateLead(input);

      if (result.error) {
        sendJson(res, 400, { ok: false, error: result.error });
        return;
      }

      saveLead(result.lead);
      sendJson(res, 201, { ok: true, leadId: result.lead.id });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: 'Не удалось принять заявку.' });
    }
    return;
  }

  if (req.method === 'GET') {
    serveStatic(req, res);
    return;
  }

  res.writeHead(405);
  res.end('Method not allowed');
});

server.listen(PORT, HOST, () => {
  console.log(`Морозофф Кайт: http://${HOST}:${PORT}`);
});
