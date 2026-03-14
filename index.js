// Listen on a specific host via the HOST environment variable
var host = process.env.HOST || '0.0.0.0';
// Listen on a specific port via the PORT environment variable
var port = process.env.PORT || 443;

var cors_proxy = require('cors-anywhere');
var http = require('http');
var https = require('https');
var url = require('url');
var NodeCache = require('node-cache');

// Cache TTL in seconds (24 hours)
var CACHE_TTL = 86400;

// Cache with 24 hour TTL
var cache = new NodeCache({ stdTTL: CACHE_TTL, checkperiod: 3600 });

// Create the CORS Anywhere proxy server (but don't listen yet)
var corsServer = cors_proxy.createServer({
    originWhitelist: [], // Allow all origins
    //requireHeader: ['origin', 'x-requested-with'],
    removeHeaders: ['cookie', 'cookie2'],
    setHeaders: {'Access-Control-Allow-Headers': 'api-token'}
});

var BLOCKED_CONTENT_TYPES = new Set([
    // images
    'image/webp',
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/gif',
    'image/svg+xml',
    'image/avif',
    'image/bmp',
    'image/tiff',
    'image/x-icon',
    'image/vnd.microsoft.icon',
    // video
    'video/mp4',
    'video/webm',
    'video/ogg',
    'video/mpeg',
    'video/quicktime',
    'video/x-msvideo',
    'video/x-ms-wmv',
    'video/3gpp',
    'video/3gpp2',
    'video/x-flv',
    // audio
    'audio/mpeg',
    'audio/ogg',
    'audio/wav',
    'audio/webm',
    'audio/aac',
    'audio/flac',
    'audio/x-ms-wma',
    // generic binary
    'application/octet-stream',

    // ── HLS (m3u8) ──────────────────────────────────────────────────────────
    'application/vnd.apple.mpegurl',        // standard m3u8
    'application/x-mpegurl',                // common alternative
    'audio/mpegurl',                        // audio-only HLS
    'audio/x-mpegurl',                      // audio-only HLS alternative

    // ── MPEG-DASH ────────────────────────────────────────────────────────────
    'application/dash+xml',                 // .mpd manifest
    'video/vnd.mpeg.dash.mpd',             // alternative DASH mime

    // ── Smooth Streaming (Microsoft) ────────────────────────────────────────
    'application/vnd.ms-sstr+xml',

    // ── RTSP / RTP / raw transport streams ──────────────────────────────────
    'video/mp2t',                           // .ts MPEG-2 transport stream segments
    'video/mp2p',                           // MPEG-2 program stream
    'video/mpeg2',
    'application/mp4',                      // fragmented mp4 segments (fMP4)
    'video/iso.segment',                    // fMP4 segment alternative

    // ── Shoutcast / Icecast audio streams ───────────────────────────────────
    'audio/aacp',                           // AAC+ stream
    'audio/x-scpls',                        // .pls playlist
    'application/pls+xml',
    'audio/x-mpegurl',                      // .m3u playlist (already above, safe duplicate)

    // ── Media playlists / containers ────────────────────────────────────────
    'application/x-mpegurl',               // .m3u
    'application/vnd.rn-realmedia',        // RealMedia .rm
    'application/vnd.rn-realmedia-vbr',    // RealMedia variable bitrate
    'video/x-ms-asf',                      // ASF / WMV container
    'video/x-ms-wmx',                      // Windows Media redirector
    'video/x-ms-wvx',                      // Windows Media video playlist
    'audio/x-ms-wax',                      // Windows Media audio playlist
]);

function isBlockedType(contentTypeHeader) {
    if (!contentTypeHeader) return false;
    var mime = contentTypeHeader.split(';')[0].trim().toLowerCase();
    return BLOCKED_CONTENT_TYPES.has(mime) ||
           mime.startsWith('video/') ||
           mime.startsWith('audio/') ||
           mime.startsWith('image/') ||
           // catch any other streaming manifest types
           mime.includes('mpegurl') ||
           mime.includes('mpegdash') ||
           mime.includes('dash+xml') ||
           mime.includes('mp2t') ||
           mime.includes('realmedia');
}

var server = http.createServer(function(req, res) {
    var parsedUrl = url.parse(req.url, true);
    var query = parsedUrl.query;

    console.log(req.url);
    if (!/^\/https?:\/\//.test(req.url)) {
        req.url = '/https://' + req.url.slice(1);
    }
    console.log(req.url);

    var shouldCache = 'cache' in query;

    // ── Helper: build filtered headers ──────────────────────────────────────
    function buildHeaders(reqHeaders) {
        var h = Object.assign({}, reqHeaders);
        ['host', 'cookie', 'cookie2', 'authorization', 'proxy-authorization'].forEach(function(k) {
            delete h[k];
        });
        return h;
    }

    // ── Helper: proxy a URL, follow redirects internally, block media ────────
    function proxyFetch(targetUrl, redirectCount, onSuccess) {
        redirectCount = redirectCount || 0;

        if (redirectCount > 5) {
            res.writeHead(508, { 'Access-Control-Allow-Origin': '*' });
            res.end('Too many redirects');
            return;
        }

        var targetParsed;
        try {
            targetParsed = new URL(targetUrl);
        } catch (e) {
            res.writeHead(400, { 'Access-Control-Allow-Origin': '*' });
            res.end('Invalid URL: ' + targetUrl);
            return;
        }

        var useHttps = targetParsed.protocol === 'https:';
        var protocol = useHttps ? https : http;

        var options = {
            hostname: targetParsed.hostname,
            port: targetParsed.port || (useHttps ? 443 : 80),
            path: targetParsed.pathname + (targetParsed.search || ''),
            method: req.method,
            headers: buildHeaders(req.headers)
        };

        var proxyReq = protocol.request(options, function(proxyRes) {
            var statusCode = proxyRes.statusCode;

            // ── Follow redirects internally ──────────────────────────────
            if (statusCode === 301 || statusCode === 302 || statusCode === 303 ||
                statusCode === 307 || statusCode === 308) {
                var location = proxyRes.headers['location'];
                proxyRes.resume();

                if (!location) {
                    res.writeHead(502, { 'Access-Control-Allow-Origin': '*' });
                    res.end('Redirect with no location header');
                    return;
                }

                // Resolve relative redirects
                try {
                    location = new URL(location, targetParsed.origin).href;
                } catch (e) {
                    res.writeHead(502, { 'Access-Control-Allow-Origin': '*' });
                    res.end('Invalid redirect location: ' + location);
                    return;
                }

                console.log('Following redirect (' + redirectCount + ') to: ' + location);
                proxyFetch(location, redirectCount + 1, onSuccess);
                return;
            }

            // ── Block media types ────────────────────────────────────────
            var contentType = proxyRes.headers['content-type'] || '';
            if (isBlockedType(contentType)) {
                proxyRes.resume();
                res.writeHead(403, {
                    'Access-Control-Allow-Origin': '*',
                    'x-blocked-type': contentType.split(';')[0].trim()
                });
                res.end('Blocked: media type not allowed (' + contentType.split(';')[0].trim() + ')');
                return;
            }

            // ── Allowed — hand off to caller ─────────────────────────────
            onSuccess(proxyRes, contentType);
        });

        proxyReq.on('error', function(err) {
            // HTTPS → HTTP fallback
            if (useHttps && err.code === 'EPROTO') {
                console.log('HTTPS failed with EPROTO, retrying with HTTP: ' + targetUrl);
                var httpUrl = targetUrl.replace(/^https:\/\//, 'http://');
                proxyFetch(httpUrl, redirectCount, onSuccess);
                return;
            }
            if (!res.headersSent) {
                res.writeHead(500, { 'Access-Control-Allow-Origin': '*' });
            }
            res.end('Proxy error: ' + err.message);
        });

        if (req.method !== 'GET' && req.method !== 'HEAD') {
            req.pipe(proxyReq);
        } else {
            proxyReq.end();
        }
    }

    // ── Non-cached path ──────────────────────────────────────────────────────
    if (!shouldCache) {
        var rawUrl = req.url.slice(1); // strip leading /
        proxyFetch(rawUrl, 0, function(proxyRes) {
            var headers = Object.assign({}, proxyRes.headers);
            headers['access-control-allow-origin'] = '*';
            res.writeHead(proxyRes.statusCode, headers);
            proxyRes.pipe(res);
        });
        return;
    }

    // ── Cached path ──────────────────────────────────────────────────────────

    // Strip ?cache / &cache from URL for actual request + cache key
    var targetUrl = req.url;
    targetUrl = targetUrl.replace(/([?&])cache(&|$)/g, function(match, prefix, suffix) {
        if (prefix === '?' && suffix === '&') return '?';
        if (prefix === '?' && suffix === '') return '';
        if (prefix === '&') return suffix ? '&' : '';
        return '';
    });

    var cacheKey = req.method + ':' + targetUrl;

    // Return cached response if available
    var cachedResponse = cache.get(cacheKey);
    if (cachedResponse) {
        var cachedHeaders = Object.assign({}, cachedResponse.headers);
        cachedHeaders['x-cache'] = 'HIT';
        res.writeHead(cachedResponse.statusCode, cachedHeaders);
        res.end(cachedResponse.body);
        return;
    }

    // Only cache GET requests
    if (req.method !== 'GET') {
        var rawTargetUrl = targetUrl.slice(1);
        proxyFetch(rawTargetUrl, 0, function(proxyRes) {
            var headers = Object.assign({}, proxyRes.headers);
            headers['access-control-allow-origin'] = '*';
            res.writeHead(proxyRes.statusCode, headers);
            proxyRes.pipe(res);
        });
        return;
    }

    // GET + cache: buffer the response so we can store it
    var rawTargetUrl = targetUrl.slice(1);
    proxyFetch(rawTargetUrl, 0, function(proxyRes) {
        var body = [];

        proxyRes.on('data', function(chunk) {
            body.push(chunk);
        });

        proxyRes.on('end', function() {
            var bodyBuffer = Buffer.concat(body);
            var headers = Object.assign({}, proxyRes.headers);
            headers['access-control-allow-origin'] = '*';

            var isSuccess = proxyRes.statusCode >= 200 && proxyRes.statusCode < 300;
            if (isSuccess) {
                headers['x-cache'] = 'MISS';
                headers['x-cache-ttl'] = String(CACHE_TTL);
                cache.set(cacheKey, {
                    statusCode: proxyRes.statusCode,
                    headers: headers,
                    body: bodyBuffer
                });
            }

            res.writeHead(proxyRes.statusCode, headers);
            res.end(bodyBuffer);
        });
    });
});

server.listen(port, host, function() {
    console.log('Running CORS Anywhere with caching on ' + host + ':' + port);
});
