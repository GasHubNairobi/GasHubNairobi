/* Response compression (gzip / brotli) with no extra npm package.
   Pages, scripts, styles and JSON usually shrink to a quarter of their size, so they load much faster on mobile data.
   Safe by design: if anything about a response is unusual (already compressed, streaming, tiny, no browser support)
   it is sent exactly as before, and if compression itself ever errors the response is simply sent uncompressed. */
const zlib = require("zlib");

const COMPRESSIBLE = /^(text\/|application\/(json|javascript|x-javascript|xml|manifest\+json)|image\/svg\+xml)/i;
const MIN_BYTES = 1024;

function pickEncoding(header) {
    const h = String(header || "").toLowerCase();
    if (/\bbr\b/.test(h)) return "br";
    if (/\bgzip\b/.test(h)) return "gzip";
    return null;
}

function compress() {
    return function compressMiddleware(req, res, next) {
        if (req.method === "HEAD" || req.headers.range) return next();
        const enc = pickEncoding(req.headers["accept-encoding"]);
        if (!enc) return next();

        const origWriteHead = res.writeHead;
        const origWrite = res.write;
        const origEnd = res.end;
        let stream = null;
        let decided = false;
        let failed = false;

        res.vary && res.vary("Accept-Encoding");

        function decide() {
            if (decided) return;
            decided = true;
            const type = String(res.getHeader("Content-Type") || "");
            const len = Number(res.getHeader("Content-Length"));
            const status = res.statusCode;
            const cc = String(res.getHeader("Cache-Control") || "");
            if (
                res.getHeader("Content-Encoding") || status === 204 || status === 304 || status < 200 ||
                !COMPRESSIBLE.test(type) || /no-transform/i.test(cc) || (Number.isFinite(len) && len < MIN_BYTES)
            ) return;

            try {
                stream = enc === "br"
                    ? zlib.createBrotliCompress({ params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } })
                    : zlib.createGzip({ level: 6 });
            } catch (e) { stream = null; return; }

            res.setHeader("Content-Encoding", enc);
            res.removeHeader("Content-Length");
            const etag = res.getHeader("ETag");
            if (etag && !/^W\//.test(String(etag))) res.setHeader("ETag", "W/" + etag);

            stream.on("data", chunk => { if (!failed) origWrite.call(res, chunk); });
            stream.on("drain", () => res.emit("drain"));   /* lets a piped file stream carry on when the compressor catches up */
            stream.on("end", () => origEnd.call(res));
            stream.on("error", () => {
                /* nothing useful can be sent any more: close the response cleanly */
                failed = true;
                try { origEnd.call(res); } catch (e) { /* ignore */ }
            });
        }

        res.writeHead = function (...args) {
            decide();
            return origWriteHead.apply(res, args);
        };
        res.write = function (chunk, encoding, cb) {
            decide();
            if (!stream) return origWrite.call(res, chunk, encoding, cb);
            if (typeof encoding === "function") { cb = encoding; encoding = undefined; }
            const ok = stream.write(chunk, encoding);
            if (cb) process.nextTick(cb);
            return ok;
        };
        res.end = function (chunk, encoding, cb) {
            if (typeof chunk === "function") { cb = chunk; chunk = null; encoding = null; }
            else if (typeof encoding === "function") { cb = encoding; encoding = null; }
            decide();
            if (!stream) return origEnd.call(res, chunk, encoding, cb);
            if (cb) res.once("finish", cb);
            if (chunk) stream.write(chunk, encoding);
            stream.end();
            return res;
        };
        next();
    };
}

module.exports = { compress };
