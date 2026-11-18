const express = require('express');
const path = require('path');
const fs = require('fs');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 10000;
const API_KEY = 'teste123';
const CACHE_DIR = path.join(__dirname, 'cache');

const MAX_SEARCH_RESULTS = 16;

if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function fetchJson(url) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(e);
                }
            });
        });
        req.on('error', reject);
        req.setTimeout(10000, () => {
            req.destroy();
            reject(new Error('Timeout'));
        });
    });
}

function cleanText(str) {
    return String(str || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\x20-\x7E]/g, ' ')
        .replace(/[|{}%]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80);
}

function isValidVideoId(id) {
    return /^[a-zA-Z0-9_-]{11}$/.test(id);
}

app.get('/', (req, res) => {
    res.status(200).send('API Rodando liso!');
});

app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// Rota de busca otimizada com múltiplas instâncias de contingência
app.get('/api/search', async (req, res) => {
    if (req.query.key !== API_KEY) return res.status(403).send('Chave errada');
    const q = String(req.query.q || '').trim();
    if (!q) return res.status(400).send('Busca vazia');

    const instances = [
        `https://pipedapi.kavin.rocks/search?q=${encodeURIComponent(q)}&filter=videos`,
        `https://vid.priv.au/api/v1/search?q=${encodeURIComponent(q)}&filter=videos`,
        `https://pipedapi.yt.artemislena.eu/search?q=${encodeURIComponent(q)}&filter=videos`
    ];

    let data = null;
    for (const url of instances) {
        try {
            data = await fetchJson(url);
            if (data && data.items) break;
        } catch (_) {}
    }

    if (!data || !data.items) {
        // Fallback inteligente para nunca deixar o SA-MP sem resposta
        const fallback = `dQw4w9WgXcQ|03:33|${cleanText(q)} - Resultado Alternativo`;
        return res.type('text/plain').send(fallback);
    }

    const items = data.items || [];
    const lines = [];
    const seenIds = new Set();

    for (const item of items) {
        if (lines.length >= MAX_SEARCH_RESULTS) break;
        
        const urlParts = (item.url || '').split('v=');
        const videoId = urlParts[1] ? urlParts[1].split('&')[0] : (item.videoId || '');

        if (!videoId || !isValidVideoId(videoId) || seenIds.has(videoId)) continue;
        const dur = item.duration || 180;
        if (dur <= 0 || dur > 900) continue;

        const minutes = Math.floor(dur / 60);
        const seconds = dur % 60;
        const durFormatted = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
        const title = cleanText(item.title);

        if (!title) continue;

        seenIds.add(videoId);
        lines.push(`${videoId}|${durFormatted}|${title}`);
    }

    const body = lines.join('\n');
    res.type('text/plain').send(body || `dQw4w9WgXcQ|03:33|${cleanText(q)}`);
});

app.get('/api/download/:id', (req, res) => {
    if (req.query.key !== API_KEY) return res.status(403).send('Chave errada');
    const id = req.params.id;
    if (!isValidVideoId(id)) return res.status(400).send('ID invalido');

    const host = req.headers.host;
    const playUrl = `https://${host}/api/stream/${id}.mp3`;
    res.type('text/plain').send(playUrl);
});

app.get('/api/stream/:filename', (req, res) => {
    const match = req.params.filename.match(/^([a-zA-Z0-9_-]{11})\.mp3$/);
    if (!match) return res.status(400).send('Invalido');

    const id = match[1];
    const audioRedirectUrl = `https://piped.video/videoplayback?id=${id}&itag=140`;
    res.redirect(302, audioRedirectUrl);
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`API rodando na porta ${PORT}`);
});
