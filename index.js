const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 10000;
const API_KEY = 'teste123';
const CACHE_DIR = path.join(__dirname, 'cache');

if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
}

// Rota de teste para ver se o Render acordou
app.get('/', (req, res) => {
    res.status(200).send('API Rodando liso!');
});

app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// Rota de busca leve (usando ytsr ou rota direta se preferir, ou fallback seguro)
app.get('/api/search', (req, res) => {
    if (req.query.key !== API_KEY) return res.status(403).send('Chave errada');
    const q = String(req.query.q || '').trim();
    if (!q) return res.status(400).send('Busca vazia');

    // Retorno direto simulado/seguro para testar o SA-MP conectar sem crashar
    // Formato ID | Duracao | Titulo
    const mockResult = `dQw4w9WgXcQ|03:33|Rick Astley - Never Gonna Give You Up`;
    res.type('text/plain').send(mockResult);
});

app.get('/api/download/:id', (req, res) => {
    if (req.query.key !== API_KEY) return res.status(403).send('Chave errada');
    const id = req.params.id;
    
    // Retorna um link de stream direto ou placeholder funcional para testar o client do SA-MP
    const host = req.headers.host;
    const playUrl = `https://${host}/api/stream/sample.mp3`;
    res.type('text/plain').send(playUrl);
});

app.get('/api/stream/:filename', (req, res) => {
    res.status(200).send('Stream ok');
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`API rodando na porta ${PORT}`);
});
