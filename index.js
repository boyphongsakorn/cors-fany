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

// Create a wrapper server to handle caching
var server = http.createServer(function(req, res) {
    var parsedUrl = url.parse(req.url, true);
    var query = parsedUrl.query;
    
    // Check if cache parameter is present (either ?cache or &cache)
    var shouldCache = 'cache' in query;
    
    if (!shouldCache) {
        // No caching requested, pass through to cors proxy
        corsServer.emit('request', req, res);
        return;
    }
    
    // Remove cache parameter from URL for the actual request
    var targetUrl = req.url;
    // Remove ?cache or &cache from URL
    // Handle: ?cache, ?cache&other, &cache, &cache&other
    targetUrl = targetUrl.replace(/([?&])cache(&|$)/g, function(match, prefix, suffix) {
        if (prefix === '?' && suffix === '&') {
            return '?'; // ?cache&other -> ?other
        } else if (prefix === '?' && suffix === '') {
            return ''; // ?cache -> (nothing)
        } else if (prefix === '&') {
            return suffix ? '&' : ''; // &cache&other -> &other, &cache -> (nothing)
        }
        return '';
    });
    
    // Create a cache key from the URL and method
    var cacheKey = req.method + ':' + targetUrl;
    
    // Check if we have a cached response
    var cachedResponse = cache.get(cacheKey);
    if (cachedResponse) {
        // Return cached response with HIT header
        var cachedHeaders = Object.assign({}, cachedResponse.headers);
        cachedHeaders['x-cache'] = 'HIT';
        res.writeHead(cachedResponse.statusCode, cachedHeaders);
        res.end(cachedResponse.body);
        return;
    }
    
    // For GET requests, fetch and cache the response
    if (req.method === 'GET') {
        // Extract the target URL from the path (cors-anywhere format: /http://example.com/path)
        var pathWithoutSlash = targetUrl.slice(1); // Remove leading /
        
        var targetParsed;
        try {
            targetParsed = new URL(pathWithoutSlash);
        } catch (e) {
            // Invalid URL, pass through to cors proxy
            req.url = targetUrl;
            corsServer.emit('request', req, res);
            return;
        }
        
        var protocol = targetParsed.protocol === 'https:' ? https : http;
        
        // Filter out sensitive and host-specific headers
        var filteredHeaders = Object.assign({}, req.headers);
        var headersToRemove = ['host', 'cookie', 'cookie2', 'authorization', 'proxy-authorization'];
        headersToRemove.forEach(function(header) {
            delete filteredHeaders[header];
        });
        
        var options = {
            hostname: targetParsed.hostname,
            port: targetParsed.port || (targetParsed.protocol === 'https:' ? 443 : 80),
            path: targetParsed.pathname + targetParsed.search,
            method: 'GET',
            headers: filteredHeaders
        };
        
        var proxyReq = protocol.request(options, function(proxyRes) {
            var body = [];
            
            proxyRes.on('data', function(chunk) {
                body.push(chunk);
            });
            
            proxyRes.on('end', function() {
                var bodyBuffer = Buffer.concat(body);
                
                // Prepare headers with CORS
                var headers = Object.assign({}, proxyRes.headers);
                headers['access-control-allow-origin'] = '*';
                
                // Only cache successful responses (2xx status codes)
                var isSuccess = proxyRes.statusCode >= 200 && proxyRes.statusCode < 300;
                if (isSuccess) {
                    headers['x-cache'] = 'MISS';
                    headers['x-cache-ttl'] = String(CACHE_TTL);
                    
                    // Cache the response
                    cache.set(cacheKey, {
                        statusCode: proxyRes.statusCode,
                        headers: headers,
                        body: bodyBuffer
                    });
                }
                
                // Send response
                res.writeHead(proxyRes.statusCode, headers);
                res.end(bodyBuffer);
            });
        });
        
        proxyReq.on('error', function(err) {
            res.writeHead(500, {'Access-Control-Allow-Origin': '*'});
            res.end('Proxy error: ' + err.message);
        });
        
        proxyReq.end();
    } else {
        // For non-GET requests, pass through without caching
        req.url = targetUrl;
        corsServer.emit('request', req, res);
    }
});

server.listen(port, host, function() {
    console.log('Running CORS Anywhere with caching on ' + host + ':' + port);
});
