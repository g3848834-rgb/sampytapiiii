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

// Função auxiliar para requisições HTTPS simples (sem precisar de pacotes externos pesados)
function fetchJson(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(e);
                }
            });
        }).on('error', reject);
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

// Rota de busca integrada utilizando API pública leve de suporte ao YouTube
app.get('/api/search', async (req, res) => {
    if (req.query.key !== API_KEY) return res.status(403).send('Chave errada');
    const q = String(req.query.q || '').trim();
    if (!q) return res.status(400).send('Busca vazia');

    try {
        // Usando uma API pública de busca em JSON para evitar binários locais no Render
        const searchUrl = `https://pipedapi.kavin.rocks/search?q=${encodeURIComponent(q)}&filter=videos`;
        const data = await fetchJson(searchUrl);
        
        const items = data.items || [];
        const lines = [];
        const seenIds = new Set();

        for (const item of items) {
            if (lines.length >= MAX_SEARCH_RESULTS) break;
            
            // Extrai o ID do vídeo da URL (ex: /watch?v=ID)
            const urlParts = (item.url || '').split('v=');
            const videoId = urlParts[1] ? urlParts[1].split('&')[0] : '';

            if (!videoId || !isValidVideoId(videoId) || seenIds.has(videoId)) continue;
            if (item.duration <= 0 || item.duration > 900) continue; // Ignora acima de 15 min

            const minutes = Math.floor(item.duration / 60);
            const seconds = item.duration % 60;
            const durFormatted = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
            const title = cleanText(item.title);

            if (!title) continue;

            seenIds.add(videoId);
            lines.push(`${videoId}|${durFormatted}|${title}`);
        }

        const body = lines.join('\n');
        res.type('text/plain').send(body);
    } catch (err) {
        console.log('[ERRO BUSCA]', err.message);
        // Fallback seguro caso a API externa instabilize momentaneamente
        res.status(500).send('Erro ao buscar músicas');
    }
});

app.get('/api/download/:id', (req, res) => {
    if (req.query.key !== API_KEY) return res.status(403).send('Chave errada');
    const id = req.params.id;
    if (!isValidVideoId(id)) return res.status(400).send('ID invalido');

    const host = req.headers.host;
    // Retorna o link de stream direto para o SA-MP puxar o áudio
    const playUrl = `https://${host}/api/stream/${id}.mp3`;
    res.type('text/plain').send(playUrl);
});

app.get('/api/stream/:filename', (req, res) => {
    const match = req.params.filename.match(/^([a-zA-Z0-9_-]{11})\.mp3$/);
    if (!match) return res.status(400).send('Invalido');

    const id = match[1];
    
    // Redireciona o fluxo de áudio diretamente para uma fonte de streaming web compativel com o SA-MP
    const audioRedirectUrl = `https://piped.video/videoplayback?id=${id}&itag=140`;
    res.redirect(302, audioRedirectUrl);
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`API rodando na porta ${PORT}`);
});
