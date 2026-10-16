/* GasHub service worker - shows push notifications on the phone, even when the site is closed.
   It does NOT store pages or files (GasHub pages must always be fresh), so it can never show an old version of the site. */
"use strict";

self.addEventListener("install", function () { self.skipWaiting(); });
self.addEventListener("activate", function (event) { event.waitUntil(self.clients.claim()); });

/* only addresses on this website can be opened from a notification */
function safeUrl(u) {
    try {
        var url = new URL(u || "/", self.location.origin);
        return url.origin === self.location.origin ? url.pathname + url.search + url.hash : "/";
    } catch (e) { return "/"; }
}

self.addEventListener("push", function (event) {
    var data = {};
    try { data = event.data ? event.data.json() : {}; }
    catch (e) { data = { body: event.data ? event.data.text() : "" }; }
    var opts = {
        body: String(data.body || ""),
        icon: "/Images/icons/icon-192.png",
        badge: "/Images/icons/badge-96.png",
        data: { url: safeUrl(data.url) },
        lang: "en"
    };
    if (data.tag) { opts.tag = String(data.tag); opts.renotify = true; }   /* a newer message about the same order replaces the old one */
    /* browsers require every push to show something */
    event.waitUntil(self.registration.showNotification(String(data.title || "GasHub"), opts));
});

self.addEventListener("notificationclick", function (event) {
    event.notification.close();
    var target = safeUrl(event.notification.data && event.notification.data.url);
    event.waitUntil(
        self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (list) {
            for (var i = 0; i < list.length; i++) {
                var c = list[i];
                if (c.url && new URL(c.url).origin === self.location.origin && "focus" in c) {
                    return c.focus().then(function (w) { return w && "navigate" in w ? w.navigate(target) : null; });
                }
            }
            return self.clients.openWindow(target);
        })
    );
});
