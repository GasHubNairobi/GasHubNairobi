/* GasHub report -> PDF file, built right in the browser (no library, nothing is uploaded anywhere).
   Every page carries: the GasHub logo and name in the header, a large faint logo watermark, a diagonal "GASHUB" watermark pattern,
   the secret report code printed as small repeating microtext above and below the content, the code + fingerprint in the footer,
   and "Page x of y". Used by admin-report.js; also runs in Node for testing. */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else root.GasHubReportPdf = factory();
})(typeof self !== "undefined" ? self : this, function () {
    "use strict";

    var W = 595.28, H = 841.89, ML = 34, MR = 34, CW = W - ML - MR;
    var TOP = H - 114, BOTTOM = 70;
    var BLUE = [0.102, 0.239, 0.549], ORANGE = [0.96, 0.38, 0.10], INK = [0.12, 0.14, 0.2], GREY = [0.42, 0.45, 0.5], LINE = [0.82, 0.85, 0.9];
    var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

    /* ---------- small helpers ---------- */
    function n2(v) { var s = (Math.round(v * 100) / 100).toFixed(2); return s.replace(/\.?0+$/, ""); }
    function fmtNum(v) {
        var n = Number(v); if (!isFinite(n)) n = 0;
        var neg = n < 0; n = Math.abs(Math.round(n * 100) / 100);
        var parts = (n % 1 ? n.toFixed(2) : String(n)).split(".");
        parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
        return (neg ? "-" : "") + parts.join(".");
    }
    function fmtMoney(v) { return "KSh " + fmtNum(v); }
    function fmtDay(ymd) { var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd || "")); return m ? m[3] + " " + MONTHS[Number(m[2]) - 1] + " " + m[1] : String(ymd || ""); }
    function fmtDateTime(v) {
        var d = new Date(v); if (isNaN(d)) return "";
        try {
            return new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Nairobi", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(d).replace(",", "");
        } catch (e) { return d.toISOString().slice(0, 16).replace("T", " "); }
    }
    function label(s) { return String(s == null ? "" : s).replace(/_/g, " ").replace(/\b\w/g, function (c) { return c.toUpperCase(); }); }
    function methodLabel(m) { var k = String(m || "").toLowerCase(); return k === "mpesa" ? "M-Pesa" : k === "cash" ? "Cash" : label(m) || "-"; }

    var WIN = { 8364: 128, 8218: 130, 402: 131, 8222: 132, 8230: 133, 8224: 134, 8225: 135, 710: 136, 8240: 137, 352: 138, 8249: 139, 338: 140, 381: 142,
        8216: 145, 8217: 146, 8220: 147, 8221: 148, 8226: 149, 8211: 150, 8212: 151, 732: 152, 8482: 153, 353: 154, 8250: 155, 339: 156, 382: 158, 376: 159 };
    /* text -> a string of single-byte WinAnsi characters (anything the PDF font cannot show becomes ?) */
    function win(s) {
        s = String(s == null ? "" : s).replace(/[\r\n\t]+/g, " ");
        var out = "";
        for (var i = 0; i < s.length; i++) {
            var c = s.charCodeAt(i);
            if (c >= 32 && c < 127) out += s[i];
            else if (c >= 160 && c <= 255) out += String.fromCharCode(c);
            else if (WIN[c]) out += String.fromCharCode(WIN[c]);
            else out += "?";
        }
        return out;
    }
    function esc(s) { return win(s).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)"); }
    function latin1(str) { var b = new Uint8Array(str.length); for (var i = 0; i < str.length; i++) b[i] = str.charCodeAt(i) & 255; return b; }
    function col(c) { return n2(c[0]) + " " + n2(c[1]) + " " + n2(c[2]); }

    /* ---------- the document ---------- */
    function build(sealed, assets, measureFn) {
        var seal = sealed.seal || {};
        var rep = sealed.report || {};
        var stats = sealed.statistics || {};
        var type = rep.report_type || "overview";
        var code = seal.code || "UNSEALED";

        /* text width in points. In the browser this uses a canvas with Arial (same widths as the PDF's Helvetica). */
        var measure = measureFn || function (t, size, bold) { return String(t).length * size * (bold ? 0.56 : 0.52); };
        var tw = function (t, size, bold) { return measure(win(t), size, !!bold); };

        var pages = [];
        var cur = null, y = 0;
        function newPage() { cur = { ops: [] }; pages.push(cur); y = TOP; }
        function op(s) { cur.ops.push(s); }

        function text(x, yy, s, size, bold, color) { op("BT /" + (bold ? "F2" : "F1") + " " + n2(size) + " Tf " + col(color || INK) + " rg " + n2(x) + " " + n2(yy) + " Td (" + esc(s) + ") Tj ET"); }
        function textR(xRight, yy, s, size, bold, color) { text(xRight - tw(s, size, bold), yy, s, size, bold, color); }
        function line(x1, y1, x2, y2, color, width) { op(n2(width || 0.5) + " w " + col(color || LINE) + " RG " + n2(x1) + " " + n2(y1) + " m " + n2(x2) + " " + n2(y2) + " l S"); }
        function rect(x, yy, w, h, color, fill) { op((fill ? col(color) + " rg " : n2(0.6) + " w " + col(color) + " RG ") + n2(x) + " " + n2(yy) + " " + n2(w) + " " + n2(h) + (fill ? " re f" : " re S")); }

        function wrap(s, width, size, bold, maxLines) {
            s = win(s).trim();
            if (!s) return [""];
            var words = s.split(/\s+/), lines = [], curLine = "";
            function push(l) { lines.push(l); }
            for (var i = 0; i < words.length; i++) {
                var w = words[i];
                while (tw(w, size, bold) > width && w.length > 1) {            /* a very long word is cut to fit */
                    var k = w.length; while (k > 1 && tw(w.slice(0, k), size, bold) > width) k--;
                    if (curLine) { push(curLine); curLine = ""; }
                    push(w.slice(0, k)); w = w.slice(k);
                }
                var t = curLine ? curLine + " " + w : w;
                if (tw(t, size, bold) <= width) curLine = t; else { push(curLine); curLine = w; }
            }
            if (curLine) push(curLine);
            if (maxLines && lines.length > maxLines) {
                lines = lines.slice(0, maxLines);
                var last = lines[maxLines - 1];
                while (last.length > 1 && tw(last + "...", size, bold) > width) last = last.slice(0, -1);
                lines[maxLines - 1] = last + "...";
            }
            return lines;
        }

        function heading(title, note) {
            if (y - 70 < BOTTOM) newPage();
            y -= 8;
            text(ML, y, title, 11.5, true, BLUE);
            rect(ML, y - 5, 26, 2, ORANGE, true);
            if (note) textR(W - MR, y, note, 7.5, false, GREY);
            y -= 18;
        }
        function note(s) { text(ML, y, s, 8, false, GREY); y -= 14; }

        /* cols: [{ t: heading, w: relative width, a: "l" | "r" }]   rows: arrays of strings   totals: optional last row */
        function table(cols, rows, o) {
            o = o || {};
            var size = o.size || 8.5, pad = 3.5, lead = size + 2.2;
            var totalW = cols.reduce(function (a, c) { return a + c.w; }, 0);
            var xs = [], widths = [], x = ML;
            cols.forEach(function (c) { var w = CW * c.w / totalW; xs.push(x); widths.push(w); x += w; });

            function head() {
                rect(ML, y - 13, CW, 15, BLUE, true);
                cols.forEach(function (c, i) {
                    var t = win(c.t);
                    if (c.a === "r") textR(xs[i] + widths[i] - pad, y - 9, t, size - 0.5, true, [1, 1, 1]); else text(xs[i] + pad, y - 9, t, size - 0.5, true, [1, 1, 1]);
                });
                y -= 15;
            }
            if (y - 15 - 24 < BOTTOM) newPage();
            head();
            function drawRow(cells, bold) {
                var wrapped = cells.map(function (cell, i) { return wrap(cell, widths[i] - 2 * pad, size, bold, 3); });
                var lines = wrapped.reduce(function (m, l) { return Math.max(m, l.length); }, 1);
                var h = lines * lead + 2 * pad - 1;
                if (y - h < BOTTOM) { newPage(); head(); }
                wrapped.forEach(function (ls, i) {
                    ls.forEach(function (l, j) {
                        var yy = y - pad - size + 1.5 - j * lead;
                        if (cols[i].a === "r") textR(xs[i] + widths[i] - pad, yy, l, size, bold); else text(xs[i] + pad, yy, l, size, bold);
                    });
                });
                y -= h;
                line(ML, y, ML + CW, y, LINE, 0.4);
            }
            if (!rows.length) { text(ML + pad, y - 12, "No records for this period.", size, false, GREY); y -= 20; return; }
            rows.forEach(function (r) { drawRow(r, false); });
            if (o.totals) { line(ML, y, ML + CW, y, BLUE, 0.9); drawRow(o.totals, true); }
            y -= 8;
        }

        /* ---------- first page: title + figures ---------- */
        newPage();
        var titles = { overview: "Business Overview Report", orders: "Orders Report", payments: "Payments Report", customers: "Customers Report", products: "Products Report" };
        var title = titles[type] || "Business Report";
        text(ML, y - 6, title, 17, true, BLUE);
        y -= 24;
        text(ML, y, "Period: " + fmtDay(rep.start_date) + "  to  " + fmtDay(rep.end_date) + "   (Nairobi time)", 9.5, true);
        y -= 13;
        text(ML, y, "Prepared by " + (seal.generated_by || "Admin") + " on " + (fmtDateTime(seal.generated_at || new Date()) || "") + "     Report code " + code, 8.5, false, GREY);
        y -= 20;

        var boxes = [["TOTAL ORDERS", fmtNum(stats.totalOrders)], ["TOTAL SALES", fmtMoney(stats.totalSales)], ["PAYMENTS RECEIVED", fmtMoney(stats.totalPayments)], ["NEW CUSTOMERS", fmtNum(stats.newCustomers)]];
        var gap = 8, bw = (CW - gap * 3) / 4;
        boxes.forEach(function (b, i) {
            var bx = ML + i * (bw + gap);
            rect(bx, y - 40, bw, 42, LINE, false);
            rect(bx, y - 40, 3, 42, i % 2 ? ORANGE : BLUE, true);
            text(bx + 10, y - 13, b[0], 7, true, GREY);
            text(bx + 10, y - 31, b[1], 12.5, true, INK);
        });
        y -= 54;
        note("Sales exclude cancelled and rejected orders. Payments received count only payments that M-Pesa or the dealer confirmed as paid.");

        var trunc = sealed.truncated || {};
        function limited(name) { if (trunc[name]) note("Only the first 5,000 rows of this list are shown. Choose a shorter period to see the rest."); }

        /* ---------- sections ---------- */
        var showAll = type === "overview";
        if (showAll || type === "orders") {
            heading("Orders by Status");
            var os = sealed.orders || [];
            table([{ t: "Status", w: 3 }, { t: "Orders", w: 1.2, a: "r" }, { t: "Total Amount", w: 2, a: "r" }],
                os.map(function (r) { return [r.status_label || label(r.status), fmtNum(r.order_count), fmtMoney(r.total_amount)]; }),
                os.length ? { totals: ["Total", fmtNum(os.reduce(function (a, r) { return a + Number(r.order_count || 0); }, 0)), fmtMoney(os.reduce(function (a, r) { return a + Number(r.total_amount || 0); }, 0))] } : null);
        }
        if (showAll || type === "payments") {
            heading("Payments by Method and Status");
            var ps = sealed.payments || [];
            table([{ t: "Method", w: 2.2 }, { t: "Status", w: 2.2 }, { t: "Payments", w: 1.2, a: "r" }, { t: "Total Amount", w: 2, a: "r" }],
                ps.map(function (r) { return [methodLabel(r.method), r.status_label || label(r.status), fmtNum(r.payment_count), fmtMoney(r.total_amount)]; }),
                ps.length ? { totals: ["Total", "", fmtNum(ps.reduce(function (a, r) { return a + Number(r.payment_count || 0); }, 0)), fmtMoney(ps.reduce(function (a, r) { return a + Number(r.total_amount || 0); }, 0))] } : null);
        }
        if (showAll || type === "products") {
            heading("Product Performance");
            var pr = sealed.products || [];
            table([{ t: "Product", w: 5 }, { t: "Orders", w: 1.2, a: "r" }, { t: "Quantity", w: 1.4, a: "r" }, { t: "Total Sales", w: 2, a: "r" }],
                pr.map(function (r) { return [r.product_name || "-", fmtNum(r.order_count), fmtNum(r.quantity_sold), fmtMoney(r.total_sales)]; }),
                pr.length ? { totals: ["Total", "", fmtNum(pr.reduce(function (a, r) { return a + Number(r.quantity_sold || 0); }, 0)), fmtMoney(pr.reduce(function (a, r) { return a + Number(r.total_sales || 0); }, 0))] } : null);
            limited("products");
        }
        if (showAll || type === "customers") {
            heading("Customers Who Ordered", fmtNum(stats.activeCustomers) + " active of " + fmtNum(stats.totalCustomers) + " customers");
            var cu = sealed.customers || [];
            table([{ t: "Customer", w: 3.2 }, { t: "Phone", w: 2 }, { t: "Email", w: 3.4 }, { t: "Orders", w: 1.1, a: "r" }, { t: "Total Spent", w: 2, a: "r" }],
                cu.map(function (r) { return [r.full_name || "-", r.phone || "-", r.email || "-", fmtNum(r.order_count), fmtMoney(r.total_spent)]; }),
                cu.length ? { totals: ["Total", "", "", fmtNum(cu.reduce(function (a, r) { return a + Number(r.order_count || 0); }, 0)), fmtMoney(cu.reduce(function (a, r) { return a + Number(r.total_spent || 0); }, 0))] } : null);
            limited("customers");
        }
        if (type === "orders") {
            var orr = sealed.order_records || [];
            heading("Order Register", fmtNum(orr.length) + " orders");
            table([{ t: "Order No.", w: 2.2 }, { t: "Date", w: 2.5 }, { t: "Customer", w: 2.3 }, { t: "Dealer", w: 2.8 }, { t: "Method", w: 1.2 }, { t: "Payment", w: 1.2 }, { t: "Status", w: 1.5 }, { t: "Amount", w: 1.9, a: "r" }],
                orr.map(function (r) { return [r.order_number || "-", fmtDateTime(r.created_at), r.customer_name || "-", r.dealer_name || "-", methodLabel(r.payment_method), label(r.payment_status) || "-", r.status_label || label(r.status), fmtMoney(r.total_amount)]; }),
                orr.length ? { size: 8, totals: ["Total", fmtNum(orr.length) + " orders", "", "", "", "", "", fmtMoney(orr.reduce(function (a, r) { return a + Number(r.total_amount || 0); }, 0))] } : { size: 8 });
            limited("order_records");
        }
        if (type === "payments") {
            var pay = sealed.payment_records || [];
            heading("Payment Register", fmtNum(pay.length) + " payments");
            table([{ t: "Date", w: 2.8 }, { t: "Reference", w: 2.2 }, { t: "Order No.", w: 2 }, { t: "Customer", w: 2.2 }, { t: "Method", w: 1.2 }, { t: "Status", w: 1.4 }, { t: "M-Pesa Code", w: 1.7 }, { t: "Amount", w: 1.9, a: "r" }],
                pay.map(function (r) { return [fmtDateTime(r.created_at), r.payment_reference || "-", r.order_number || "-", r.customer_name || "-", methodLabel(r.method), r.status_label || label(r.status), r.mpesa_receipt_number || "-", fmtMoney(r.amount)]; }),
                pay.length ? { size: 8, totals: ["Total", fmtNum(pay.length) + " payments", "", "", "", "", "", fmtMoney(pay.reduce(function (a, r) { return a + Number(r.amount || 0); }, 0))] } : { size: 8 });
            limited("payment_records");
        }

        /* closing block */
        if (y - 70 < BOTTOM) newPage();
        y -= 6;
        line(ML, y, ML + CW, y, BLUE, 0.9);
        y -= 14;
        text(ML, y, "End of report", 9, true, BLUE);
        y -= 12;
        wrap("This is a sealed GasHub report. Code " + code + " (fingerprint " + (seal.fingerprint || "-") + ") is recorded in the GasHub report register. A copy without a code, or whose code does not verify under Admin > Reports > Verify a report, is not genuine.", CW, 8, false, 4)
            .forEach(function (l) { text(ML, y, l, 8, false, GREY); y -= 10.5; });

        /* ---------- every page: watermarks, header, footer, microtext ---------- */
        var total = pages.length;
        var imgW = 400, imgH = imgW * (assets.watermark.height / assets.watermark.width);
        var micro = (function () {
            var unit = code + "  ", s = "", per = tw(unit, 4.2, false) || 40;
            for (var i = 0; i < Math.max(1, Math.floor((CW - 4) / per)); i++) s += unit;      /* stays inside the margins */
            return s;
        })();

        var streams = pages.map(function (pg, idx) {
            var bg = [], hf = [];
            var saved = cur; cur = { ops: bg };
            /* big faint logo in the middle */
            op("q " + n2(imgW) + " 0 0 " + n2(imgH) + " " + n2((W - imgW) / 2) + " " + n2((H - imgH) / 2 - 10) + " cm /Im2 Do Q");
            /* diagonal GASHUB pattern, very light */
            for (var r = 0, cy = 40; cy < H + 100; cy += 150, r++) {
                for (var cx = -30 + (r % 2) * 125; cx < W; cx += 250) {
                    var a = 32 * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
                    op("BT /F2 26 Tf 0.93 0.94 0.96 rg " + n2(c) + " " + n2(s) + " " + n2(-s) + " " + n2(c) + " " + n2(cx) + " " + n2(cy) + " Tm (GASHUB) Tj ET");
                }
            }
            cur = { ops: hf };
            /* header */
            op("q " + n2(70 * assets.logo.width / assets.logo.height) + " 0 0 70 " + ML + " " + n2(H - 84) + " cm /Im1 Do Q");
            var hx = ML + 70 * assets.logo.width / assets.logo.height + 10;
            text(hx, H - 44, "GasHub", 19, true, BLUE);
            text(hx, H - 58, "Find. Order. Delivered.", 8.5, false, ORANGE);
            text(hx, H - 71, "Official business report", 8, false, GREY);
            textR(W - MR, H - 40, title, 11, true, INK);
            textR(W - MR, H - 53, fmtDay(rep.start_date) + " - " + fmtDay(rep.end_date), 8.5, false, GREY);
            textR(W - MR, H - 65, "Code " + code, 8.5, true, ORANGE);
            line(ML, H - 90, W - MR, H - 90, BLUE, 1.6);
            op(col(GREY) + " rg BT /F1 4.2 Tf " + n2(ML) + " " + n2(H - 95) + " Td (" + esc(micro) + ") Tj ET");
            /* footer */
            op(col(GREY) + " rg BT /F1 4.2 Tf " + n2(ML) + " " + n2(BOTTOM - 8) + " Td (" + esc(micro) + ") Tj ET");
            line(ML, BOTTOM - 13, W - MR, BOTTOM - 13, BLUE, 1);
            text(ML, BOTTOM - 26, "Report code: " + code, 8.5, true, INK);
            text(ML, BOTTOM - 37, "Fingerprint: " + (seal.fingerprint || "-") + "   |   Prepared by " + (seal.generated_by || "Admin"), 7.5, false, GREY);
            text(ML, BOTTOM - 47, "Genuine only if this code verifies in Admin > Reports > Verify a report. GasHub, Nairobi, Kenya.", 7, false, GREY);
            textR(W - MR, BOTTOM - 26, "Page " + (idx + 1) + " of " + total, 8.5, true, INK);
            cur = saved;
            return latin1(bg.join("\n") + "\n" + pg.ops.join("\n") + "\n" + hf.join("\n"));
        });

        /* ---------- write the PDF file ---------- */
        var chunks = [], offset = 0, offsets = [];
        function put(data) { var b = typeof data === "string" ? latin1(data) : data; chunks.push(b); offset += b.length; }
        function obj(id, body) { offsets[id] = offset; put(id + " 0 obj\n"); put(body); put("\nendobj\n"); }
        function stream(id, dict, bytes) { offsets[id] = offset; put(id + " 0 obj\n<< " + dict + " /Length " + bytes.length + " >>\nstream\n"); put(bytes); put("\nendstream\nendobj\n"); }

        var nPages = streams.length;
        var ID = { catalog: 1, pages: 2, f1: 3, f2: 4, logo: 5, wm: 6, info: 7, first: 8 };
        put("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
        obj(ID.catalog, "<< /Type /Catalog /Pages 2 0 R >>");
        var kids = []; for (var i = 0; i < nPages; i++) kids.push((ID.first + i * 2) + " 0 R");
        obj(ID.pages, "<< /Type /Pages /Count " + nPages + " /Kids [" + kids.join(" ") + "] >>");
        obj(ID.f1, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
        obj(ID.f2, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
        function img(id, a) { stream(id, "/Type /XObject /Subtype /Image /Width " + a.width + " /Height " + a.height + " /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode", a.bytes); }
        img(ID.logo, assets.logo); img(ID.wm, assets.watermark);
        var d = new Date(seal.generated_at || Date.now()); if (isNaN(d)) d = new Date();
        var p2 = function (v) { return String(v).padStart(2, "0"); };
        var created = "D:" + d.getUTCFullYear() + p2(d.getUTCMonth() + 1) + p2(d.getUTCDate()) + p2(d.getUTCHours()) + p2(d.getUTCMinutes()) + p2(d.getUTCSeconds()) + "Z";
        obj(ID.info, "<< /Title (" + esc("GasHub " + title + " " + rep.start_date + " to " + rep.end_date) + ") /Author (GasHub) /Creator (GasHub Admin) /Producer (GasHub) /Subject (" + esc("Report code " + code) + ") /Keywords (" + esc(code) + ") /CreationDate (" + created + ") >>");
        for (var p = 0; p < nPages; p++) {
            var pid = ID.first + p * 2, cid = pid + 1;
            obj(pid, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 " + n2(W) + " " + n2(H) + "] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> /XObject << /Im1 5 0 R /Im2 6 0 R >> >> /Contents " + cid + " 0 R >>");
            stream(cid, "", streams[p]);
        }
        var xrefAt = offset, count = ID.first + nPages * 2;
        var x = "xref\n0 " + count + "\n0000000000 65535 f \n";
        for (var k = 1; k < count; k++) x += String(offsets[k]).padStart(10, "0") + " 00000 n \n";
        put(x + "trailer\n<< /Size " + count + " /Root 1 0 R /Info 7 0 R >>\nstartxref\n" + xrefAt + "\n%%EOF\n");

        var out = new Uint8Array(offset), pos = 0;
        chunks.forEach(function (c) { out.set(c, pos); pos += c.length; });
        return out;
    }

    return { build: build, fmtNum: fmtNum, fmtMoney: fmtMoney, fmtDay: fmtDay, fmtDateTime: fmtDateTime, methodLabel: methodLabel, label: label };
});
