/* Customer tracking helper (replaces the missing gashub-track.js).
   Provides:
     recordView({id, name, category, price, image, rating})   remembers what the customer opened
     recordPurchase([{id, name, qty}])                        remembers what the customer bought
   Data stays in this browser (localStorage). The home page reads it to show
   "Viewed by you" and "Most viewed", and the assistant uses it for "What do I usually buy?". */
(function () {
    "use strict";

    var VIEWS_KEY = "gasHubViews";
    var BUYS_KEY = "gasHubPurchases";

    function read(key) {
        try { var v = JSON.parse(localStorage.getItem(key)); return Array.isArray(v) ? v : []; }
        catch (e) { return []; }
    }
    function write(key, value) {
        try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* storage full or blocked: ignore */ }
    }

    /* newest first, one entry per product, "n" counts how many times it was opened */
    window.recordView = function (item) {
        if (!item || (item.id == null && !item.name)) return;
        var key = String(item.id != null && item.id !== "" ? item.id : item.name);
        var list = read(VIEWS_KEY);
        var n = 1;
        list = list.filter(function (v) {
            var same = String(v.id != null && v.id !== "" ? v.id : v.name) === key;
            if (same) n = (Number(v.n) || 1) + 1;
            return !same;
        });
        list.unshift({
            id: item.id, name: item.name, category: item.category,
            price: item.price, image: item.image, rating: item.rating, n: n,
            t: new Date().toISOString()
        });
        write(VIEWS_KEY, list.slice(0, 40));
    };

    /* call after a paid order, e.g. recordPurchase([{ id: 2, name: "13kg Cooking Gas", qty: 1 }]) */
    window.recordPurchase = function (items) {
        if (!Array.isArray(items)) return;
        var list = read(BUYS_KEY);
        items.forEach(function (i) {
            list.push({ id: i.id, name: i.name, qty: i.qty || 1, date: new Date().toISOString() });
        });
        write(BUYS_KEY, list.slice(-300));
    };
})();