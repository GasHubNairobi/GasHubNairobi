/* GasHub admin Reports page.
   - Shows the report on screen (every record, correct fields for products and customers).
   - Print Report / Download PDF: the server works the report out again, gives it a secret report code and writes it to the report register;
     the printed page and the PDF both carry the GasHub logo, watermarks and that code on every page.
   - Verify a Report: checks a code against the register. Report Register: every printed / downloaded copy. */
document.addEventListener("DOMContentLoaded", () => {
    const P = window.GasHubReportPdf;
    const $ = (id) => document.getElementById(id);
    const el = {
        form: $("reportFilterForm"), startDate: $("reportStartDate"), endDate: $("reportEndDate"), reportType: $("reportType"),
        generateButton: $("generateReportButton"), printButton: $("reportPrintButton"), pdfButton: $("reportPdfButton"), message: $("reportMessage"),
        totalOrders: $("reportTotalOrders"), totalSales: $("reportTotalSales"), totalPayments: $("reportTotalPayments"), newCustomers: $("reportNewCustomers"),
        ordersTable: $("reportOrdersTableBody"), paymentsTable: $("reportPaymentsTableBody"), productsTable: $("reportProductsTableBody"), customersTable: $("reportCustomersTableBody"),
        orderRegister: $("reportOrderRegisterBody"), orderRegisterNote: $("reportOrderRegisterNote"), paymentRegister: $("reportPaymentRegisterBody"), paymentRegisterNote: $("reportPaymentRegisterNote"),
        verifyForm: $("reportVerifyForm"), verifyCode: $("reportVerifyCode"), verifyButton: $("reportVerifyButton"), verifyResult: $("reportVerifyResult"), history: $("reportHistoryBody")
    };
    const SECTIONS = {
        overview: ["reportSecOrders", "reportSecPayments", "reportSecProducts", "reportSecCustomers"],
        orders: ["reportSecOrders", "reportSecOrderRegister"],
        payments: ["reportSecPayments", "reportSecPaymentRegister"],
        customers: ["reportSecCustomers"],
        products: ["reportSecProducts"]
    };
    const ALL_SECTIONS = ["reportSecOrders", "reportSecPayments", "reportSecProducts", "reportSecCustomers", "reportSecOrderRegister", "reportSecPaymentRegister"];
    const TYPE_NAMES = { overview: "Overview", orders: "Orders", payments: "Payments", customers: "Customers", products: "Products" };
    const ON_SCREEN_LIMIT = 300;                        /* the screen shows the first 300 register rows; print / PDF always include every row */

    const esc = (v) => GasHubAdmin.escapeHtml(v === null || v === undefined ? "" : String(v));
    const num = P.fmtNum, money = P.fmtMoney;

    /* ---------- status badges ---------- */
    const norm = (s) => String(s || "").trim().toLowerCase().replace(/[-\s]+/g, "_");
    function badgeClass(s) {
        const n = norm(s);
        if (["completed", "paid", "delivered", "resolved", "confirmed", "approved", "success"].includes(n)) return "success";
        if (["pending", "new", "processing", "in_progress", "awaiting_payment", "ready_for_delivery", "out_for_delivery", "dispatched"].includes(n)) return "warning";
        if (["cancelled", "canceled", "failed", "rejected", "refunded"].includes(n)) return "danger";
        return "neutral";
    }
    const badge = (status, text) => `<span class="status-badge ${badgeClass(status)}">${esc(text || P.label(status) || "-")}</span>`;

    function showMessage(message, type = "error") {
        if (!el.message) return;
        if (!message) { el.message.textContent = ""; el.message.className = "admin-message"; el.message.style.display = "none"; return; }
        el.message.textContent = message;
        el.message.className = `admin-message ${type}`;
        el.message.style.display = "block";
    }

    /* ---------- dates ---------- */
    const pad2 = (n) => String(n).padStart(2, "0");
    function nairobiToday() {
        const d = new Date(Date.now() + 3 * 3600e3);
        return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
    }
    function setDefaultDates() {
        if (!el.endDate.value) el.endDate.value = nairobiToday();
        if (!el.startDate.value) el.startDate.value = nairobiToday().slice(0, 8) + "01";
    }
    function readFilters() {
        const start = el.startDate.value, end = el.endDate.value, type = el.reportType.value;
        if (!start || !end) { showMessage("Please select both the start date and end date."); return null; }
        if (start > end) { showMessage("The start date cannot be after the end date."); return null; }
        return { start_date: start, end_date: end, report_type: type };
    }

    /* ---------- the report on screen ---------- */
    const empty = (cols, text) => `<tr><td colspan="${cols}" class="table-empty">${esc(text)}</td></tr>`;

    function renderReport(r) {
        const s = r.statistics || {};
        el.totalOrders.textContent = num(s.totalOrders);
        el.totalSales.textContent = money(s.totalSales);
        el.totalPayments.textContent = money(s.totalPayments);
        el.newCustomers.textContent = num(s.newCustomers);

        const type = (r.report && r.report.report_type) || "overview";
        const show = new Set(SECTIONS[type] || SECTIONS.overview);
        ALL_SECTIONS.forEach((id) => { const n = $(id); if (n) n.hidden = !show.has(id); });

        const orders = r.orders || [];
        el.ordersTable.innerHTML = orders.length ? orders.map((x) => `<tr>
            <td>${badge(x.status, x.status_label)}</td><td>${num(x.order_count)}</td><td>${money(x.total_amount)}</td></tr>`).join("")
            : empty(3, "No order data available for this period.");

        const pays = r.payments || [];
        el.paymentsTable.innerHTML = pays.length ? pays.map((x) => `<tr>
            <td>${esc(P.methodLabel(x.method))}</td><td>${badge(x.status, x.status_label)}</td><td>${num(x.payment_count)}</td><td>${money(x.total_amount)}</td></tr>`).join("")
            : empty(4, "No payment data available for this period.");

        const prods = r.products || [];
        el.productsTable.innerHTML = prods.length ? prods.map((x) => `<tr>
            <td><div class="table-primary-text">${esc(x.product_name || "-")}</div></td><td>${num(x.order_count)}</td><td>${num(x.quantity_sold)}</td><td>${money(x.total_sales)}</td></tr>`).join("")
            : empty(4, "No product data available for this period.");

        const custs = r.customers || [];
        el.customersTable.innerHTML = custs.length ? custs.map((x) => `<tr>
            <td><div class="table-primary-text">${esc(x.full_name || "-")}</div><div class="table-secondary-text">${esc(x.email || "")}</div></td>
            <td>${esc(x.phone || "-")}</td><td>${num(x.order_count)}</td><td>${money(x.total_spent)}</td></tr>`).join("")
            : empty(4, "No customers ordered in this period.");

        const regNote = (count, what, cut) => `${num(count)} ${what} in the selected period.` + (count > ON_SCREEN_LIMIT ? ` The first ${ON_SCREEN_LIMIT} are shown here. Print or download the report to get every row.` : "") + (cut ? " The list is limited to 5,000 rows, choose a shorter period to see the rest." : "");
        const orr = r.order_records || [];
        el.orderRegister.innerHTML = orr.length ? orr.slice(0, ON_SCREEN_LIMIT).map((x) => `<tr>
            <td><span class="mono-code">${esc(x.order_number || "-")}</span></td><td>${esc(P.fmtDateTime(x.created_at))}</td><td>${esc(x.customer_name || "-")}</td><td>${esc(x.dealer_name || "-")}</td>
            <td>${esc(P.methodLabel(x.payment_method))}</td><td>${badge(x.payment_status)}</td><td>${badge(x.status, x.status_label)}</td><td>${money(x.total_amount)}</td></tr>`).join("")
            : empty(8, "No orders in this period.");
        el.orderRegisterNote.textContent = regNote(orr.length, "orders", r.truncated && r.truncated.order_records);

        const pr = r.payment_records || [];
        el.paymentRegister.innerHTML = pr.length ? pr.slice(0, ON_SCREEN_LIMIT).map((x) => `<tr>
            <td>${esc(P.fmtDateTime(x.created_at))}</td><td><span class="mono-code">${esc(x.payment_reference || "-")}</span></td><td>${esc(x.order_number || "-")}</td><td>${esc(x.customer_name || "-")}</td>
            <td>${esc(P.methodLabel(x.method))}</td><td>${badge(x.status, x.status_label)}</td><td>${esc(x.mpesa_receipt_number || "-")}</td><td>${money(x.amount)}</td></tr>`).join("")
            : empty(8, "No payments in this period.");
        el.paymentRegisterNote.textContent = regNote(pr.length, "payments", r.truncated && r.truncated.payment_records);
    }

    let busy = false;
    function setBusy(on, which) {
        busy = on;
        [el.generateButton, el.printButton, el.pdfButton].forEach((b) => { if (b) b.disabled = on; });
        if (which === "generate") el.generateButton.textContent = on ? "Generating..." : "Generate Report";
        if (which === "print") el.printButton.textContent = on ? "Preparing..." : "Print Report";
        if (which === "pdf") el.pdfButton.textContent = on ? "Preparing..." : "Download PDF";
    }

    async function generateReport() {
        const f = readFilters();
        if (!f || busy) return;
        try {
            showMessage("");
            setBusy(true, "generate");
            const q = new URLSearchParams(f);
            const r = await GasHubAdmin.adminApiRequest(`/api/admin/reports?${q.toString()}`);
            renderReport(r || {});
        } catch (error) {
            console.error("Failed to generate report:", error);
            showMessage(error.message || "Failed to generate report.");
        } finally { setBusy(false, "generate"); }
    }

    /* ---------- logo + watermark pictures (made from images/logo.png) ---------- */
    let assetsPromise = null;
    const loadAssets = () => (assetsPromise = assetsPromise || prepareAssets().catch((e) => { assetsPromise = null; throw e; }));
    function loadImage(src) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error("The GasHub logo (images/logo.png) could not be loaded."));
            img.src = src;
        });
    }
    function b64ToBytes(b64) { const bin = atob(b64); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
    async function prepareAssets() {
        const img = await loadImage(new URL("images/logo.png", location.href).href);
        const w = img.naturalWidth, h = img.naturalHeight;
        const c = document.createElement("canvas"); c.width = w; c.height = h;
        const g = c.getContext("2d"); g.drawImage(img, 0, 0);
        /* trim the empty edges around the logo so it can be placed tightly */
        let l = 0, t = 0, r = w, b = h;
        try {
            const d = g.getImageData(0, 0, w, h).data;
            let minX = w, minY = h, maxX = -1, maxY = -1;
            for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3] > 16) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
            if (maxX > minX && maxY > minY) { const p = 8; l = Math.max(0, minX - p); t = Math.max(0, minY - p); r = Math.min(w, maxX + p); b = Math.min(h, maxY + p); }
        } catch (e) { /* keep the whole picture */ }
        const cw = r - l, ch = b - t;
        const make = (alpha, fillWhite) => {
            const cv = document.createElement("canvas"); cv.width = cw; cv.height = ch;
            const x = cv.getContext("2d");
            if (fillWhite) { x.fillStyle = "#fff"; x.fillRect(0, 0, cw, ch); }
            x.globalAlpha = alpha; x.drawImage(img, l, t, cw, ch, 0, 0, cw, ch);
            return cv;
        };
        const jpeg = (cv) => { const url = cv.toDataURL("image/jpeg", 0.92); return { bytes: b64ToBytes(url.split(",")[1]), width: cw, height: ch }; };
        return { logo: jpeg(make(1, true)), watermark: jpeg(make(0.09, true)), logoPng: make(1, false).toDataURL("image/png"), width: cw, height: ch };
    }
    const mctx = document.createElement("canvas").getContext("2d");
    const measure = (text, size, bold) => { mctx.font = (bold ? "bold " : "") + size + "px Arial, Helvetica, sans-serif"; return mctx.measureText(text).width; };

    /* ---------- print ---------- */
    function sectionsFor(d) {
        const type = (d.report && d.report.report_type) || "overview";
        const sum = (rows, k) => rows.reduce((a, r) => a + Number(r[k] || 0), 0);
        const trunc = d.truncated || {};
        const out = [];
        const all = type === "overview";
        if (all || type === "orders") out.push({ title: "Orders by Status", cols: [["Status"], ["Orders", "r"], ["Total Amount", "r"]],
            rows: (d.orders || []).map((r) => [r.status_label || P.label(r.status), num(r.order_count), money(r.total_amount)]),
            totals: (d.orders || []).length ? ["Total", num(sum(d.orders, "order_count")), money(sum(d.orders, "total_amount"))] : null });
        if (all || type === "payments") out.push({ title: "Payments by Method and Status", cols: [["Method"], ["Status"], ["Payments", "r"], ["Total Amount", "r"]],
            rows: (d.payments || []).map((r) => [P.methodLabel(r.method), r.status_label || P.label(r.status), num(r.payment_count), money(r.total_amount)]),
            totals: (d.payments || []).length ? ["Total", "", num(sum(d.payments, "payment_count")), money(sum(d.payments, "total_amount"))] : null });
        if (all || type === "products") out.push({ title: "Product Performance", cols: [["Product"], ["Orders", "r"], ["Quantity", "r"], ["Total Sales", "r"]],
            rows: (d.products || []).map((r) => [r.product_name || "-", num(r.order_count), num(r.quantity_sold), money(r.total_sales)]),
            totals: (d.products || []).length ? ["Total", "", num(sum(d.products, "quantity_sold")), money(sum(d.products, "total_sales"))] : null, limited: trunc.products });
        if (all || type === "customers") out.push({ title: "Customers Who Ordered", note: `${num((d.statistics || {}).activeCustomers)} active of ${num((d.statistics || {}).totalCustomers)} customers`,
            cols: [["Customer"], ["Phone"], ["Email"], ["Orders", "r"], ["Total Spent", "r"]],
            rows: (d.customers || []).map((r) => [r.full_name || "-", r.phone || "-", r.email || "-", num(r.order_count), money(r.total_spent)]),
            totals: (d.customers || []).length ? ["Total", "", "", num(sum(d.customers, "order_count")), money(sum(d.customers, "total_spent"))] : null, limited: trunc.customers });
        if (type === "orders") out.push({ title: "Order Register", note: `${num((d.order_records || []).length)} orders`,
            cols: [["Order No."], ["Date"], ["Customer"], ["Dealer"], ["Method"], ["Payment"], ["Status"], ["Amount", "r"]],
            rows: (d.order_records || []).map((r) => [r.order_number || "-", P.fmtDateTime(r.created_at), r.customer_name || "-", r.dealer_name || "-", P.methodLabel(r.payment_method), P.label(r.payment_status) || "-", r.status_label || P.label(r.status), money(r.total_amount)]),
            totals: (d.order_records || []).length ? ["Total", `${num(d.order_records.length)} orders`, "", "", "", "", "", money(sum(d.order_records, "total_amount"))] : null, limited: trunc.order_records, small: true });
        if (type === "payments") out.push({ title: "Payment Register", note: `${num((d.payment_records || []).length)} payments`,
            cols: [["Date"], ["Reference"], ["Order No."], ["Customer"], ["Method"], ["Status"], ["M-Pesa Code"], ["Amount", "r"]],
            rows: (d.payment_records || []).map((r) => [P.fmtDateTime(r.created_at), r.payment_reference || "-", r.order_number || "-", r.customer_name || "-", P.methodLabel(r.method), r.status_label || P.label(r.status), r.mpesa_receipt_number || "-", money(r.amount)]),
            totals: (d.payment_records || []).length ? ["Total", `${num(d.payment_records.length)} payments`, "", "", "", "", "", money(sum(d.payment_records, "amount"))] : null, limited: trunc.payment_records, small: true });
        return out;
    }

    function printHtml(d, assets) {
        const seal = d.seal || {}, rep = d.report || {}, st = d.statistics || {};
        const code = seal.code || "";
        const fullTitle = rep.report_type === "overview" ? "Business Overview Report" : `${TYPE_NAMES[rep.report_type] || "Business"} Report`;
        const period = `${P.fmtDay(rep.start_date)} - ${P.fmtDay(rep.end_date)}`;
        const micro = Array(70).fill(code).join("  ");
        let pat = "";
        for (let row = 0, y = -120; y < 420; y += 46, row++) for (let x = -160 + (row % 2) * 60; x < 330; x += 120) pat += `<text x="${x}" y="${y}">GASHUB</text>`;

        const sections = sectionsFor(d).map((s) => `
            <h2>${esc(s.title)}${s.note ? `<small>${esc(s.note)}</small>` : ""}</h2>
            <table class="data${s.small ? ' small' : ''}">
                <thead><tr>${s.cols.map((c) => `<th${c[1] === "r" ? ' class="r"' : ""}>${esc(c[0])}</th>`).join("")}</tr></thead>
                <tbody>${s.rows.length ? s.rows.map((r) => `<tr>${r.map((v, i) => `<td${s.cols[i][1] === "r" ? ' class="r"' : ""}>${esc(v)}</td>`).join("")}</tr>`).join("")
                    : `<tr><td colspan="${s.cols.length}" class="none">No records for this period.</td></tr>`}</tbody>
                ${s.totals ? `<tfoot><tr>${s.totals.map((v, i) => `<td${s.cols[i][1] === "r" ? ' class="r"' : ""}>${esc(v)}</td>`).join("")}</tr></tfoot>` : ""}
            </table>${s.limited ? `<p class="note">Only the first 5,000 rows of this list are shown. Choose a shorter period to see the rest.</p>` : ""}`).join("");

        return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>GasHub-${esc(TYPE_NAMES[rep.report_type] || "Report")}-Report_${esc(rep.start_date)}_to_${esc(rep.end_date)}_${esc(code)}</title>
<style>
@page { size: A4; margin: 8mm 12mm 10mm 12mm; @bottom-right { content: "Page " counter(page) " of " counter(pages); font: 8pt Arial, sans-serif; color: #444; } }
* { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
html, body { margin: 0; padding: 0; }
body { font: 9.5pt/1.35 Arial, Helvetica, sans-serif; color: #1f2433; }
.wm { position: fixed; left: 50%; top: 50%; width: 130mm; margin-left: -65mm; transform: translateY(-50%); opacity: .09; z-index: -1; }
.wmpat { position: fixed; top: -8mm; left: -12mm; width: 210mm; height: 297mm; z-index: -2; }
.wmpat text { fill: #eceff4; font: 700 9px Arial, sans-serif; }
table.page { width: 100%; border-collapse: collapse; table-layout: fixed; }   /* fixed: the long microtext line must not stretch the page */
table.page > thead { display: table-header-group; }
table.page > tfoot { display: table-footer-group; }
table.page > thead > tr > td, table.page > tfoot > tr > td, table.page > tbody > tr > td { padding: 0; border: 0; font-size: inherit; }
table.page > tbody > tr { break-inside: auto; }
.hdr { height: 30mm; border-bottom: 2px solid #1a3d8c; display: flex; align-items: center; gap: 4mm; padding-bottom: 2mm; }
.hdr img { height: 25mm; width: auto; }
.hdr .brand b { display: block; font-size: 20pt; color: #1a3d8c; line-height: 1.05; }
.hdr .brand span { display: block; color: #f5611a; font-size: 9pt; }
.hdr .brand small { color: #6b7280; font-size: 8pt; }
.hdr .meta { margin-left: auto; text-align: right; }
.hdr .meta b { display: block; font-size: 12pt; }
.hdr .meta span { display: block; color: #6b7280; font-size: 8.5pt; }
.hdr .meta .code { color: #f5611a; font-weight: 700; }
.micro { overflow: hidden; white-space: nowrap; font-size: 4.2pt; color: #6b7280; height: 2.2mm; line-height: 2.2mm; }
.ftr { border-top: 2px solid #1a3d8c; padding-top: 1.5mm; font-size: 8pt; color: #6b7280; }
.ftr b { color: #1f2433; font-size: 9pt; }
.body { padding-top: 3mm; padding-bottom: 3mm; }
h1 { font-size: 17pt; color: #1a3d8c; margin: 0 0 1mm; }
.period { font-weight: 700; margin: 0; }
.prep { color: #6b7280; font-size: 8.5pt; margin: 1mm 0 4mm; }
.stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 3mm; margin-bottom: 2mm; }
.stats div { border: .6pt solid #d4d9e3; border-left: 1.2mm solid #1a3d8c; padding: 2mm 3mm; }
.stats div:nth-child(even) { border-left-color: #f5611a; }
.stats small { display: block; color: #6b7280; font-size: 6.5pt; font-weight: 700; letter-spacing: .3pt; }
.stats b { font-size: 12pt; }
.note { color: #6b7280; font-size: 8pt; margin: 1mm 0; }
h2 { font-size: 11.5pt; color: #1a3d8c; margin: 6mm 0 1.5mm; border-bottom: 2px solid #f5611a; display: inline-block; padding-right: 8mm; break-after: avoid; }
h2 small { font-size: 7.5pt; color: #6b7280; font-weight: 400; margin-left: 4mm; }
table.data { width: 100%; border-collapse: collapse; margin: 1mm 0 3mm; }
table.data thead { display: table-header-group; }
table.data tfoot { display: table-row-group; }
table.data tr { break-inside: avoid; }
th { background: #1a3d8c; color: #fff; text-align: left; font-size: 8pt; padding: 1.6mm 2mm; }
table.data td { padding: 1.4mm 2mm; border-bottom: .3pt solid #d4d9e3; font-size: 8.5pt; vertical-align: top; }
table.data.small td, table.data.small th { font-size: 7.5pt; padding: 1.1mm 1.5mm; }
.r { text-align: right; }
table.data tfoot td { font-weight: 700; border-top: 1pt solid #1a3d8c; }
.none { color: #6b7280; }
.end { margin-top: 6mm; border-top: 1pt solid #1a3d8c; padding-top: 2mm; break-inside: avoid; font-size: 8pt; color: #6b7280; }
.end b { color: #1a3d8c; font-size: 9pt; }
</style></head><body>
<svg class="wmpat" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 210 297" preserveAspectRatio="none"><g transform="rotate(-32 105 148)">${pat}</g></svg>
<img class="wm" src="${assets.logoPng}" alt="">
<table class="page">
<thead><tr><td>
  <div class="hdr"><img src="${assets.logoPng}" alt="GasHub"><div class="brand"><b>GasHub</b><span>Find. Order. Delivered.</span><small>Official business report</small></div>
    <div class="meta"><b>${esc(fullTitle)}</b><span>${esc(period)}</span><span class="code">Code ${esc(code)}</span></div></div>
  <div class="micro">${esc(micro)}</div>
</td></tr></thead>
<tfoot><tr><td>
  <div class="micro">${esc(micro)}</div>
  <div class="ftr"><b>Report code: ${esc(code)}</b><br>Fingerprint: ${esc(seal.fingerprint || "-")} &nbsp;|&nbsp; Prepared by ${esc(seal.generated_by || "Admin")}<br>Genuine only if this code verifies in Admin &gt; Reports &gt; Verify a report. GasHub, Nairobi, Kenya.</div>
</td></tr></tfoot>
<tbody><tr><td><div class="body">
<h1>${esc(fullTitle)}</h1>
<p class="period">Period: ${esc(P.fmtDay(rep.start_date))} to ${esc(P.fmtDay(rep.end_date))} (Nairobi time)</p>
<p class="prep">Prepared by ${esc(seal.generated_by || "Admin")} on ${esc(P.fmtDateTime(seal.generated_at || new Date()))} &nbsp;&nbsp; Report code ${esc(code)}</p>
<div class="stats">
  <div><small>TOTAL ORDERS</small><b>${esc(num(st.totalOrders))}</b></div><div><small>TOTAL SALES</small><b>${esc(money(st.totalSales))}</b></div>
  <div><small>PAYMENTS RECEIVED</small><b>${esc(money(st.totalPayments))}</b></div><div><small>NEW CUSTOMERS</small><b>${esc(num(st.newCustomers))}</b></div></div>
<p class="note">Sales exclude cancelled and rejected orders. Payments received count only payments that M-Pesa or the dealer confirmed as paid.</p>
${sections}
<div class="end"><b>End of report</b><br>This is a sealed GasHub report. Code ${esc(code)} (fingerprint ${esc(seal.fingerprint || "-")}) is recorded in the GasHub report register. A copy without a code, or whose code does not verify under Admin &gt; Reports &gt; Verify a report, is not genuine.</div>
</div></td></tr></tbody></table>
</body></html>`;
    }

    function printViaFrame(html) {
        const frame = document.createElement("iframe");
        frame.setAttribute("aria-hidden", "true");
        frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;";
        document.body.appendChild(frame);
        const doc = frame.contentWindow.document;
        doc.open(); doc.write(html); doc.close();
        const go = () => { try { frame.contentWindow.focus(); frame.contentWindow.print(); } finally { setTimeout(() => frame.remove(), 120000); } };
        Promise.all(Array.from(doc.images).map((i) => (i.complete ? 1 : new Promise((r) => { i.onload = i.onerror = r; })))).then(() => setTimeout(go, 200));
    }

    function downloadBytes(bytes, name) {
        const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
        const a = document.createElement("a");
        a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
    }

    /* Print or download: the server seals a fresh copy (new code, saved in the register), then we draw it. */
    async function sealedCopy(action) {
        const f = readFilters();
        if (!f) return null;
        const r = await GasHubAdmin.adminApiRequest("/api/admin/reports/seal", { method: "POST", body: { ...f, action } });
        if (!r || !r.seal || !r.seal.code) throw new Error("The report could not be sealed. Please try again.");
        return r;
    }
    async function printReport() {
        if (busy) return;
        try {
            showMessage(""); setBusy(true, "print");
            const [d, assets] = await Promise.all([sealedCopy("print"), loadAssets()]);
            if (!d) return;
            printViaFrame(printHtml(d, assets));
            showMessage(`Report ${d.seal.code} is ready to print. It was saved in the report register.`, "success");
            loadHistory();
        } catch (error) {
            console.error("Print report failed:", error);
            showMessage(error.message || "Unable to prepare the report for printing.");
        } finally { setBusy(false, "print"); }
    }
    async function downloadPdf() {
        if (busy) return;
        try {
            showMessage(""); setBusy(true, "pdf");
            const [d, assets] = await Promise.all([sealedCopy("pdf"), loadAssets()]);
            if (!d) return;
            const bytes = P.build(d, assets, measure);
            const r = d.report;
            downloadBytes(bytes, `GasHub-${TYPE_NAMES[r.report_type] || "Report"}-Report_${r.start_date}_to_${r.end_date}_${d.seal.code}.pdf`);
            showMessage(`Report ${d.seal.code} was downloaded and saved in the report register.`, "success");
            loadHistory();
        } catch (error) {
            console.error("Download PDF failed:", error);
            showMessage(error.message || "Unable to prepare the PDF.");
        } finally { setBusy(false, "pdf"); }
    }

    /* ---------- verify a report + the register ---------- */
    async function verifyCode(event) {
        event.preventDefault();
        const code = el.verifyCode.value.trim();
        if (!code) { el.verifyCode.focus(); return; }
        el.verifyButton.disabled = true; el.verifyButton.textContent = "Checking...";
        try {
            const r = await GasHubAdmin.adminApiRequest(`/api/admin/reports/verify?code=${encodeURIComponent(code)}`);
            const box = el.verifyResult; box.hidden = false;
            if (r && r.genuine) {
                const x = r.record, s = x.statistics || {}, c = x.row_counts || {};
                box.className = "verify-result ok";
                box.innerHTML = `<strong>Genuine GasHub report</strong>This code is in the GasHub report register. Compare the figures below with the paper or PDF: if any figure is different, that copy was altered.
                    <dl><dt>Code</dt><dd class="mono-code">${esc(x.code)}</dd>
                    <dt>Report</dt><dd>${esc(TYPE_NAMES[x.report_type] || x.report_type)}</dd>
                    <dt>Period</dt><dd>${esc(P.fmtDay(x.start_date))} to ${esc(P.fmtDay(x.end_date))}</dd>
                    <dt>Copy</dt><dd>${x.action === "pdf" ? "PDF download" : "Printed"}</dd>
                    <dt>Prepared by</dt><dd>${esc(x.generated_by)}</dd>
                    <dt>Date</dt><dd>${esc(P.fmtDateTime(x.generated_at))}</dd>
                    <dt>Fingerprint</dt><dd class="mono-code">${esc(x.fingerprint)}</dd>
                    <dt>Total orders</dt><dd>${esc(num(s.totalOrders))}</dd>
                    <dt>Total sales</dt><dd>${esc(money(s.totalSales))}</dd>
                    <dt>Payments received</dt><dd>${esc(money(s.totalPayments))}</dd>
                    <dt>New customers</dt><dd>${esc(num(s.newCustomers))}</dd>
                    ${c.order_records ? `<dt>Orders listed</dt><dd>${esc(num(c.order_records))}</dd>` : ""}${c.payment_records ? `<dt>Payments listed</dt><dd>${esc(num(c.payment_records))}</dd>` : ""}</dl>`;
            } else {
                box.className = "verify-result bad";
                box.innerHTML = `<strong>Not genuine</strong>${esc((r && r.message) || "This code is not in the GasHub report register.")}`;
            }
        } catch (error) {
            const box = el.verifyResult; box.hidden = false; box.className = "verify-result bad";
            box.innerHTML = `<strong>Could not check</strong>${esc(error.message || "Please try again.")}`;
        } finally { el.verifyButton.disabled = false; el.verifyButton.textContent = "Check Code"; }
    }

    async function loadHistory() {
        try {
            const r = await GasHubAdmin.adminApiRequest("/api/admin/reports/history");
            const rows = (r && r.records) || [];
            el.history.innerHTML = rows.length ? rows.map((x) => `<tr>
                <td><span class="mono-code">${esc(x.code)}</span></td><td>${esc(TYPE_NAMES[x.report_type] || x.report_type)}</td>
                <td>${esc(P.fmtDay(x.start_date))} - ${esc(P.fmtDay(x.end_date))}</td><td>${x.action === "pdf" ? "PDF download" : "Printed"}</td>
                <td>${esc(x.generated_by)}</td><td>${esc(P.fmtDateTime(x.created_at))}</td><td>${money((x.statistics || {}).totalSales)}</td></tr>`).join("")
                : empty(7, "No report has been printed or downloaded yet.");
        } catch (error) {
            el.history.innerHTML = empty(7, "The report register could not be loaded.");
        }
    }

    el.form?.addEventListener("submit", (e) => { e.preventDefault(); generateReport(); });
    el.reportType?.addEventListener("change", generateReport);
    el.printButton?.addEventListener("click", printReport);
    el.pdfButton?.addEventListener("click", downloadPdf);
    el.verifyForm?.addEventListener("submit", verifyCode);

    setDefaultDates();
    generateReport();
    loadHistory();
});
