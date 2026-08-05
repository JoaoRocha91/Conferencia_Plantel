// Service worker do app shell — cacheia só os arquivos estáticos.
// Chamadas para a Web App do Apps Script NUNCA passam por aqui: o app.js
// já trata online/offline sozinho (cache em IndexedDB + fila de sincronização).

const CACHE_NAME = 'plantel-shell-v6';
const ARQUIVOS_SHELL = [
  './',
  './index.html',
  './app.js',
  './manifest.json',
  './logo.png',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(ARQUIVOS_SHELL);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (nomes) {
      return Promise.all(
        nomes
          .filter(function (nome) { return nome !== CACHE_NAME; })
          .map(function (nome) { return caches.delete(nome); })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', function (event) {
  const url = event.request.url;

  // Nunca intercepta chamadas à Web App (Apps Script) — precisam ir
  // direto pra rede, sem cache, para não servir dados desatualizados.
  if (url.indexOf('script.google.com') !== -1) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then(function (respostaCache) {
      return respostaCache || fetch(event.request);
    })
  );
});
