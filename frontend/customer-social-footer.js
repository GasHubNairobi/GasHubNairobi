/* Fills the "Follow us" footer from Admin > Settings > Social Media.
   Links: GET /api/settings/social (only saved + switched-on accounts). Email: GET /api/settings/contact. */
(function () {
    "use strict";
    var box = document.querySelector(".footer-social .social-links");
    if (!box) return;
    var MAP = { tiktok: "TikTok", instagram: "Instagram", facebook: "Facebook", x: "X (Twitter)", youtube: "YouTube" };
    var NAMES = { tiktok: "TikTok", instagram: "Instagram", facebook: "Facebook", x: "Twitter / X", youtube: "YouTube" };
    var YT_ICON = '<img src="images/youtube-logo.svg" alt="" width="20" height="20">';
    var get = function (u) { return fetch(u, { cache: "no-store" }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }); };

    Promise.all([get("/api/settings/social"), get("/api/settings/contact")]).then(function (res) {
        if (!res[0] || !res[0].social_links) return;          /* settings unreachable: the placeholder links stay hidden */
        box.setAttribute("data-ready", "1");
        var links = res[0].social_links || {}, email = (res[1] && res[1].email) || "";
        var anchors = {};
        Object.keys(MAP).forEach(function (p) {
            anchors[p] = box.querySelector('a[aria-label="GasHub on ' + MAP[p] + '"]');
        });
        if (!anchors.youtube && links.youtube) {
            var a = document.createElement("a");
            a.setAttribute("aria-label", "GasHub on YouTube");
            a.innerHTML = YT_ICON + NAMES.youtube;
            var mail = box.querySelector('a[href^="mailto:"]');
            box.insertBefore(a, mail);
            anchors.youtube = a;
        }
        Object.keys(anchors).forEach(function (p) {
            var a = anchors[p]; if (!a) return;
            if (links[p]) { a.href = links[p]; a.target = "_blank"; a.rel = "noopener noreferrer"; a.hidden = false; a.style.display = ""; }
            else { a.hidden = true; a.style.display = "none"; }
        });
        var m = box.querySelector('a[href^="mailto:"]');
        if (m) {
            if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { m.href = "mailto:" + email; m.hidden = false; m.style.display = ""; }
            else { m.hidden = true; m.style.display = "none"; }
        }
    });
})();
