/* Dealer Purchases page: supplier purchase orders the dealer records and marks as received.
   Data comes from /api/dealers/purchases/* (limited to the signed-in dealer). */
document.addEventListener("DOMContentLoaded", function () {
    "use strict";

    var $ = function (id) { return document.getElementById(id); };
    var state = { purchases: [], summary: {} };

    function esc(s) {
        return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
            return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
        });
    }
    function kes(v) {
        return "KSh " + (Number(v) || 0).toLocaleString("en-KE", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
    }
    function day(v) {
        var d = new Date(v);
        return isNaN(d.getTime()) ? "-" : d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
    }
    var STATUS = {
        pending: { label: "In transit / pending", style: "background:#fffbeb;color:#b45309;" },
        received: { label: "Received", style: "background:#ecfdf5;color:#059669;" },
        cancelled: { label: "Cancelled", style: "background:#fef2f2;color:#b91c1c;" }
    };

    /* ---------- sign-in + API ---------- */
    function token() { return localStorage.getItem("gashub_dealer_token"); }
    async function api(path, options) {
        var t = token();
        if (!t) { window.location.href = "dealer-login.html"; throw new Error("Please sign in again."); }
        var opts = options || {};
        var res = await fetch(path, {
            method: opts.method || "GET",
            headers: Object.assign({ Accept: "application/json", Authorization: "Bearer " + t },
                opts.body ? { "Content-Type": "application/json" } : {}),
            body: opts.body ? JSON.stringify(opts.body) : undefined
        });
        if (res.status === 401) { window.location.href = "dealer-login.html"; throw new Error("Please sign in again."); }
        var data = null;
        try { data = await res.json(); } catch (e) { /* not JSON */ }
        if (!res.ok || !data || data.success === false) {
            throw new Error((data && data.message) || (res.status === 404 ? "The server is missing the purchases route: restart the backend with the latest files." : "Something went wrong. Please try again."));
        }
        return data;
    }

    function showMessage(text, ok) {
        var box = $("pmMessage");
        if (!box) return;
        box.hidden = false;
        box.textContent = text;
        box.style.background = ok ? "#ecfdf5" : "#fef2f2";
        box.style.color = ok ? "#065f46" : "#991b1b";
        box.style.border = "1px solid " + (ok ? "#a7f3d0" : "#fecaca");
        clearTimeout(showMessage.t);
        showMessage.t = setTimeout(function () { box.hidden = true; }, 6000);
    }

    /* ---------- render ---------- */
    function renderSummary() {
        var s = state.summary || {};
        $("pmTotalSpent").textContent = kes(s.total_spent);
        $("pmReceivedCount").textContent = s.received_count || 0;
        $("pmUnits").textContent = (s.units_this_month || 0).toLocaleString("en-KE") + ((s.units_this_month || 0) === 1 ? " Unit" : " Units");
        $("pmPending").textContent = (s.pending_count || 0) + ((s.pending_count || 0) === 1 ? " Shipment" : " Shipments");
        $("pmSpentMonth").textContent = kes(s.spent_this_month);
    }

    function renderTable() {
        var body = $("pmTableBody");
        if (!state.purchases.length) {
            body.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:32px 16px;color:#64748b;">' +
                '<i class="fa-solid fa-boxes-packing fa-2x" style="opacity:.35;margin-bottom:8px;display:block;"></i>' +
                '<span>No supplier purchases recorded yet. Use "New Purchase Order" to add one.</span></td></tr>';
            return;
        }
        body.innerHTML = state.purchases.map(function (p) {
            var st = STATUS[p.status] || { label: p.status, style: "" };
            var action = p.status === "pending"
                ? '<button type="button" class="btn btn-primary btn-sm" data-act="received" data-id="' + esc(p.id) + '">Mark received</button> ' +
                  '<button type="button" class="btn btn-outline btn-sm" data-act="cancelled" data-id="' + esc(p.id) + '">Cancel</button>'
                : '<span style="color:#64748b;font-size:12px;">' + (p.status === "received" ? "Received " + esc(day(p.received_at)) : "-") + "</span>";
            return "<tr><td><strong>" + esc(p.po_number) + "</strong></td><td>" + esc(p.supplier) + "</td><td>" + esc(p.items) +
                "</td><td>" + esc(Number(p.quantity).toLocaleString("en-KE")) + " units</td><td><strong>" + esc(kes(p.total_cost)) + "</strong><div style=\"font-size:11px;color:#64748b;\">" + esc(kes(p.unit_cost)) + " each</div></td>" +
                '<td><span style="padding:3px 8px;border-radius:4px;font-size:11px;font-weight:700;' + st.style + '">' + esc(st.label) + "</span></td>" +
                "<td>" + esc(day(p.ordered_at)) + "</td><td>" + action + "</td></tr>";
        }).join("");
    }

    async function load() {
        try {
            var data = await api("/api/dealers/purchases/mine");
            state.purchases = data.purchases || [];
            state.summary = data.summary || {};
            renderSummary();
            renderTable();
        } catch (e) {
            $("pmTableBody").innerHTML = '<tr><td colspan="8" style="text-align:center;padding:32px 16px;color:#b91c1c;">' + esc(e.message) + "</td></tr>";
        }
    }

    /* ---------- mark received / cancel ---------- */
    $("pmTableBody").addEventListener("click", async function (e) {
        var btn = e.target.closest("button[data-act]");
        if (!btn) return;
        var status = btn.getAttribute("data-act"), id = btn.getAttribute("data-id");
        var po = state.purchases.find(function (p) { return String(p.id) === String(id); });
        var ok = await GasHubDialog.confirm(status === "received"
            ? { title: "Mark as received?", message: "Confirm that the delivery for " + (po ? po.po_number : "this order") + " has arrived.", confirmText: "Yes, received", tone: "success" }
            : { title: "Cancel this purchase order?", message: (po ? po.po_number : "This order") + " will be marked cancelled. This cannot be undone.", confirmText: "Cancel order", cancelText: "Keep it", tone: "danger" });
        if (!ok) return;
        btn.disabled = true;
        try {
            var r = await api("/api/dealers/purchases/" + encodeURIComponent(id), { method: "PATCH", body: { status: status } });
            showMessage(r.message || "Updated.", true);
            await load();
        } catch (err) {
            showMessage(err.message, false);
            btn.disabled = false;
        }
    });

    /* ---------- new purchase order modal ---------- */
    var backdrop = $("poModalBackdrop"), form = $("poForm");
    function updateTotal() {
        $("poTotalPreview").textContent = "KSh " + ((Number($("poQuantity").value) || 0) * (Number($("poUnitCost").value) || 0))
            .toLocaleString("en-KE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    function openModal() { form.reset(); updateTotal(); $("poFormError").hidden = true; backdrop.hidden = false; $("poSupplier").focus(); }
    function closeModal() { backdrop.hidden = true; }
    $("btnNewPurchaseOrder").addEventListener("click", openModal);
    $("poCloseBtn").addEventListener("click", closeModal);
    $("poCancelBtn").addEventListener("click", closeModal);
    backdrop.addEventListener("click", function (e) { if (e.target === backdrop) closeModal(); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !backdrop.hidden) closeModal(); });
    $("poQuantity").addEventListener("input", updateTotal);
    $("poUnitCost").addEventListener("input", updateTotal);

    form.addEventListener("submit", async function (e) {
        e.preventDefault();
        var err = $("poFormError");
        var qty = Number($("poQuantity").value), cost = Number($("poUnitCost").value);
        var problem = !$("poSupplier").value.trim() ? "Enter the supplier or brand."
            : !$("poItems").value.trim() ? "Describe the items you are ordering."
            : (!Number.isInteger(qty) || qty < 1) ? "Quantity must be a whole number of 1 or more."
            : (!isFinite(cost) || cost < 0 || $("poUnitCost").value === "") ? "Enter a valid cost per unit." : "";
        if (problem) { err.textContent = problem; err.hidden = false; return; }
        err.hidden = true;
        var submit = $("poSubmitBtn");
        submit.disabled = true;
        try {
            var r = await api("/api/dealers/purchases", { method: "POST", body: {
                supplier: $("poSupplier").value, items: $("poItems").value, quantity: qty, unit_cost: cost, notes: $("poNotes").value
            } });
            closeModal();
            showMessage(r.message || "Purchase order saved.", true);
            await load();
        } catch (ex) {
            err.textContent = ex.message; err.hidden = false;
        } finally {
            submit.disabled = false;
        }
    });

    /* ---------- print (real data only) ---------- */
    $("btnPrintPurchasesAudit").addEventListener("click", function () {
        if (!state.purchases.length) { GasHubDialog.alert({ title: "Nothing to print", message: "Record a purchase order first." }); return; }
        var profile = (window.GasHubCore && GasHubCore.getActiveProfile) ? GasHubCore.getActiveProfile() : {};
        var rows = state.purchases.map(function (p) {
            var st = STATUS[p.status] || { label: p.status };
            return "<tr><td><strong>" + esc(p.po_number) + "</strong></td><td>" + esc(p.supplier) + "</td><td>" + esc(p.items) + "</td><td>" +
                esc(Number(p.quantity).toLocaleString("en-KE")) + " units</td><td><strong>" + esc(kes(p.total_cost)) + "</strong></td><td>" + esc(st.label) + "</td><td>" + esc(day(p.ordered_at)) + "</td></tr>";
        }).join("");
        var s = state.summary || {};
        var html = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>GasHub Supplier Purchases</title><style>' +
            "@page{size:A4;margin:15mm}body{font-family:Inter,Arial,sans-serif;color:#0f172a;margin:0;padding:20px}" +
            ".wm{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);width:320px;opacity:.08;z-index:-1}" +
            "table{width:100%;border-collapse:collapse;font-size:12px;margin-bottom:20px}th{background:#0f172a;color:#fff;padding:8px 10px;text-align:left}" +
            "td{padding:9px 10px;border-bottom:1px solid #e2e8f0}.head{display:flex;align-items:center;gap:14px;border-bottom:2px solid #d97706;padding-bottom:12px;margin-bottom:18px}" +
            ".head img{height:48px}h1{font-size:18px;margin:0}p{margin:2px 0 0;font-size:11px;color:#64748b}" +
            ".card{background:#fffbeb;border:1px solid #fde68a;border-left:4px solid #d97706;border-radius:6px;padding:12px 16px;margin-bottom:18px}.card strong{display:block;font-size:18px;color:#92400e;margin-top:4px}" +
            '</style></head><body><img class="wm" src="' + location.origin + '/dealer/images/watermark.png" alt="">' +
            '<div class="head"><img src="' + location.origin + '/dealer/images/logo.png" alt="GasHub"><div><h1>Supplier Purchases</h1><p>' + esc(profile.businessName || "") +
            " &middot; Printed " + esc(new Date().toLocaleString("en-GB")) + '</p></div></div>' +
            '<div class="card">Total purchased (received deliveries)<strong>' + esc(kes(s.total_spent)) + "</strong></div>" +
            "<table><thead><tr><th>PO Number</th><th>Supplier</th><th>Items</th><th>Quantity</th><th>Cost total</th><th>Status</th><th>Date</th></tr></thead><tbody>" + rows + "</tbody></table>" +
            "</body></html>";
        var w = window.open("", "_blank");
        if (!w) { GasHubDialog.alert({ title: "Pop-up blocked", message: "Allow pop-ups for this site to print." }); return; }
        w.document.open(); w.document.write(html); w.document.close();
        w.onload = function () { setTimeout(function () { w.focus(); w.print(); }, 250); };
    });

    /* ---------- verification button: GasHub admin approves it, the dealer cannot grant it to themselves ---------- */
    var verifyBtn = $("btnRequestVerification");
    if (verifyBtn && !verifyBtn.disabled) {
        verifyBtn.addEventListener("click", function () {
            GasHubDialog.alert({ title: "Verification", message: "The blue badge is approved by the GasHub admin after your verification payment is confirmed. It appears on your profile as soon as it is approved." });
        });
    }

    /* ---------- mobile sidebar ---------- */
    var menuBtn = $("dealerMobileMenu"), closeBtn = $("sidebarCloseBtn"), sidebar = $("dealerSidebar"), overlay = $("dealerSidebarOverlay");
    if (menuBtn && sidebar && overlay) {
        var closeNav = function () { sidebar.classList.remove("open"); overlay.classList.remove("active"); };
        menuBtn.addEventListener("click", function () { sidebar.classList.add("open"); overlay.classList.add("active"); });
        overlay.addEventListener("click", closeNav);
        if (closeBtn) closeBtn.addEventListener("click", closeNav);
    }

    /* ---------- sidebar "Orders" badge: real number of orders waiting for the dealer ---------- */
    (async function ordersBadge() {
        try {
            var data = await api("/api/dealers/orders/mine");
            var n = (data.orders || []).filter(function (o) { return String(o.status).toLowerCase() === "pending"; }).length;
            var badge = $("sidebarOrdersBadge");
            if (badge && n > 0) { badge.textContent = n; badge.hidden = false; }
        } catch (e) { /* the badge simply stays hidden */ }
    })();

    load();
});
