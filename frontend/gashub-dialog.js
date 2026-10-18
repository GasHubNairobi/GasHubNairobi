/* GasHub dialogs (admin + dealer).
   Replaces the browser's plain "localhost says" popups with a styled popup.

   GasHubDialog.confirm("Delete this?")                         -> Promise<boolean>
   GasHubDialog.confirm({ title, message, confirmText, cancelText, tone })   tone: danger | warning | primary | success
   GasHubDialog.prompt({ title, message, label, value, placeholder, confirmText, required })  -> Promise<string|null>
   GasHubDialog.alert("Saved") / alert({ title, message, tone })  -> Promise<void>

   window.alert is replaced too, so every old alert("...") shows the styled popup automatically.
   (A confirm/prompt must be awaited:  if (!(await GasHubDialog.confirm("..."))) return;)           */
(function () {
    "use strict";
    if (window.GasHubDialog) return;

    var isDealer = /\/dealer(\/|$)/i.test(location.pathname);
    var CSS = '\
.ghd-root{--ghd-accent:' + (isDealer ? '#d89b00' : '#1f4fd8') + ';--ghd-accent-dark:' + (isDealer ? '#b67f00' : '#173fb0') + ';--ghd-on-accent:' + (isDealer ? '#111827' : '#fff') + ';\
--ghd-danger:#dc2f45;--ghd-danger-dark:#b81f34;--ghd-warn:#e08a00;--ghd-ok:#15935a;\
--ghd-bg:#fff;--ghd-ink:#14213d;--ghd-muted:#5d6b82;--ghd-line:#e4e9f1;--ghd-soft:#f3f6fb}\
@media (prefers-color-scheme:dark){.ghd-root{--ghd-bg:#16213a;--ghd-ink:#eef3fc;--ghd-muted:#a7b5cc;--ghd-line:#2a3856;--ghd-soft:#1d2a47}}\
.ghd-root{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:18px;background:rgba(10,18,36,.55);-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);opacity:0;transition:opacity .16s ease;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}\
.ghd-root.ghd-in{opacity:1}\
.ghd-card{width:100%;max-width:410px;background:var(--ghd-bg);color:var(--ghd-ink);border-radius:20px;box-shadow:0 24px 60px rgba(8,16,34,.35);padding:26px 24px 20px;text-align:center;transform:translateY(10px) scale(.97);transition:transform .18s cubic-bezier(.2,.9,.3,1.2)}\
.ghd-in .ghd-card{transform:none}\
.ghd-icon{width:56px;height:56px;border-radius:50%;margin:0 auto 14px;display:flex;align-items:center;justify-content:center;background:color-mix(in srgb,var(--ghd-tone) 14%,transparent);color:var(--ghd-tone)}\
.ghd-icon svg{width:28px;height:28px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}\
.ghd-title{margin:0 0 6px;font-size:19px;font-weight:800;line-height:1.3}\
.ghd-msg{margin:0;color:var(--ghd-muted);font-size:14.5px;line-height:1.55;white-space:pre-line;word-break:break-word}\
.ghd-field{margin-top:16px;text-align:left}\
.ghd-field label{display:block;font-size:12.5px;font-weight:700;color:var(--ghd-muted);margin-bottom:6px}\
.ghd-field input,.ghd-field textarea{width:100%;box-sizing:border-box;padding:11px 13px;border:1.5px solid var(--ghd-line);border-radius:12px;background:var(--ghd-soft);color:var(--ghd-ink);font:inherit;font-size:15px;outline:none;transition:border-color .15s,box-shadow .15s}\
.ghd-field textarea{min-height:84px;resize:vertical}\
.ghd-field input:focus,.ghd-field textarea:focus{border-color:var(--ghd-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--ghd-accent) 22%,transparent)}\
.ghd-field.ghd-bad input,.ghd-field.ghd-bad textarea{border-color:var(--ghd-danger)}\
.ghd-err{display:none;margin-top:6px;font-size:12.5px;color:var(--ghd-danger);font-weight:600}\
.ghd-bad .ghd-err{display:block}\
.ghd-actions{display:flex;gap:10px;margin-top:22px}\
.ghd-btn{flex:1;min-height:46px;border-radius:12px;border:1.5px solid transparent;font:inherit;font-size:15px;font-weight:800;cursor:pointer;transition:background .15s,transform .05s,border-color .15s}\
.ghd-btn:active{transform:scale(.98)}\
.ghd-btn:focus-visible{outline:3px solid color-mix(in srgb,var(--ghd-accent) 45%,transparent);outline-offset:2px}\
.ghd-cancel{background:transparent;border-color:var(--ghd-line);color:var(--ghd-ink)}\
.ghd-cancel:hover{background:var(--ghd-soft)}\
.ghd-ok{background:var(--ghd-tone);color:#fff}\
.ghd-ok:hover{filter:brightness(.93)}\
.ghd-tone-primary{--ghd-tone:var(--ghd-accent)}.ghd-tone-primary .ghd-ok{color:var(--ghd-on-accent)}\
.ghd-tone-danger{--ghd-tone:var(--ghd-danger)}.ghd-tone-warning{--ghd-tone:var(--ghd-warn)}.ghd-tone-success{--ghd-tone:var(--ghd-ok)}\
@media (max-width:480px){.ghd-root{align-items:flex-end;padding:0}.ghd-card{max-width:none;border-radius:22px 22px 0 0;padding-bottom:calc(20px + env(safe-area-inset-bottom));transform:translateY(40px)}}\
@media (prefers-reduced-motion:reduce){.ghd-root,.ghd-card{transition:none}}';

    var ICONS = {
        danger: '<svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6"/></svg>',
        warning: '<svg viewBox="0 0 24 24"><path d="M12 3 2 20h20L12 3zM12 10v4M12 17.5v.01"/></svg>',
        primary: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.5v.01"/></svg>',
        success: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.8 2.8L16.5 9.5"/></svg>',
        logout: '<svg viewBox="0 0 24 24"><path d="M9 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h4M16 8l4 4-4 4M20 12H9"/></svg>'
    };

    function addStyle() {
        if (document.getElementById("ghd-style")) return;
        var s = document.createElement("style");
        s.id = "ghd-style"; s.textContent = CSS;
        (document.head || document.documentElement).appendChild(s);
    }

    function esc(v) { return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }

    /* Show one popup. Resolves with {ok, value}. Popups queue so two never overlap. */
    var queue = Promise.resolve();
    function show(o) {
        var run = function () {
            return new Promise(function (resolve) {
                addStyle();
                var tone = o.tone || "primary";
                var isPrompt = o.kind === "prompt", isAlert = o.kind === "alert";
                var opener = document.activeElement;
                var root = document.createElement("div");
                root.className = "ghd-root ghd-tone-" + tone;
                var uid = "ghd" + Math.random().toString(36).slice(2, 8);
                root.innerHTML =
                    '<div class="ghd-card" role="' + (isAlert ? "alertdialog" : "dialog") + '" aria-modal="true" aria-labelledby="' + uid + 't" aria-describedby="' + uid + 'm">' +
                    '<div class="ghd-icon" aria-hidden="true">' + (ICONS[o.icon] || ICONS[tone] || ICONS.primary) + '</div>' +
                    '<h2 class="ghd-title" id="' + uid + 't">' + esc(o.title) + '</h2>' +
                    (o.message ? '<p class="ghd-msg" id="' + uid + 'm">' + esc(o.message) + '</p>' : '') +
                    (isPrompt ? '<div class="ghd-field"><label for="' + uid + 'i">' + esc(o.label || "") + '</label>' +
                        (o.multiline ? '<textarea id="' + uid + 'i" placeholder="' + esc(o.placeholder || "") + '"></textarea>' :
                            '<input id="' + uid + 'i" type="text" autocomplete="off" placeholder="' + esc(o.placeholder || "") + '">') +
                        '<div class="ghd-err">' + esc(o.requiredMessage || "This is required.") + '</div></div>' : '') +
                    '<div class="ghd-actions">' +
                    (isAlert ? '' : '<button type="button" class="ghd-btn ghd-cancel">' + esc(o.cancelText || "Cancel") + '</button>') +
                    '<button type="button" class="ghd-btn ghd-ok">' + esc(o.confirmText || (isAlert ? "OK" : "Confirm")) + '</button>' +
                    '</div></div>';
                document.body.appendChild(root);
                var prevOverflow = document.body.style.overflow;
                document.body.style.overflow = "hidden";
                requestAnimationFrame(function () { root.classList.add("ghd-in"); });

                var ok = root.querySelector(".ghd-ok"), cancel = root.querySelector(".ghd-cancel");
                var input = root.querySelector("input,textarea"), field = root.querySelector(".ghd-field");
                if (input) input.value = o.value || "";
                var done = false;
                function close(result) {
                    if (done) return; done = true;
                    document.removeEventListener("keydown", onKey, true);
                    root.classList.remove("ghd-in");
                    document.body.style.overflow = prevOverflow;
                    setTimeout(function () { root.remove(); }, 170);
                    try { if (opener && opener.focus) opener.focus(); } catch (e) { }
                    resolve(result);
                }
                function accept() {
                    if (isPrompt) {
                        var v = input.value.trim();
                        if (o.required !== false && !v) { field.classList.add("ghd-bad"); input.focus(); return; }
                        close({ ok: true, value: v });
                    } else close({ ok: true });
                }
                function onKey(e) {
                    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close({ ok: false }); }
                    else if (e.key === "Enter" && !(e.target && e.target.tagName === "TEXTAREA") && !(e.target && e.target.classList && e.target.classList.contains("ghd-cancel"))) { e.preventDefault(); e.stopPropagation(); accept(); }
                    else if (e.key === "Tab") {
                        var f = [].slice.call(root.querySelectorAll("input,textarea,button"));
                        var i = f.indexOf(document.activeElement);
                        e.preventDefault();
                        f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
                    }
                }
                document.addEventListener("keydown", onKey, true);
                ok.addEventListener("click", accept);
                if (cancel) cancel.addEventListener("click", function () { close({ ok: false }); });
                if (input) input.addEventListener("input", function () { field.classList.remove("ghd-bad"); });
                root.addEventListener("mousedown", function (e) { if (e.target === root && !isAlert) close({ ok: false }); });
                setTimeout(function () { (input || (tone === "danger" && cancel) || ok).focus(); if (input) input.select(); }, 30);
            });
        };
        var p = queue.then(run, run);
        queue = p.catch(function () { });
        return p;
    }

    function norm(arg, defaults) {
        var o = typeof arg === "string" ? { message: arg } : Object.assign({}, arg || {});
        return Object.assign({}, defaults, o);
    }

    window.GasHubDialog = {
        confirm: function (arg) {
            return show(norm(arg, { kind: "confirm", tone: "primary", title: "Are you sure?" })).then(function (r) { return r.ok; });
        },
        prompt: function (arg) {
            return show(norm(arg, { kind: "prompt", tone: "primary", title: "Enter details" })).then(function (r) { return r.ok ? r.value : null; });
        },
        alert: function (arg) {
            var o = norm(arg, { kind: "alert", tone: "primary", title: "Notice" });
            if (typeof arg === "string" && /could not|couldn't|unable|failed|error|invalid|please (fill|allow|pick|choose|enter)|no orders|full/i.test(arg)) { o.tone = "warning"; o.title = "Please check"; }
            return show(o).then(function () { });
        }
    };

    /* Old-style alert("...") calls now use the styled popup (they never needed an answer). */
    window.alert = function (message) { window.GasHubDialog.alert(String(message == null ? "" : message)); };
})();
