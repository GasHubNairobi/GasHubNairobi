/* GasHub app launch: a dealer who is signed in keeps seeing the dealer portal inside the app.
   - The app always starts on the customer home page. If it is running as the installed app (not a normal browser tab)
     and a dealer is signed in on this phone, go straight to the dealer dashboard.
   - Logging out (dealer-logout.js) removes the dealer token, so after a logout the app opens as normal again.
   - Only the app is affected: the same page in a normal browser tab is left alone. */
(function () {
    "use strict";
    function inApp() {
        try { if (/^android-app:\/\//.test(document.referrer || "")) return true; } catch (e) { /* ignore */ }
        try { return window.matchMedia("(display-mode: standalone)").matches || window.matchMedia("(display-mode: fullscreen)").matches || window.matchMedia("(display-mode: minimal-ui)").matches; }
        catch (e) { return false; }
    }
    window.gashubInApp = inApp;
    var token = "";
    try { token = localStorage.getItem("gashub_dealer_token") || ""; } catch (e) { /* ignore */ }
    if (token && inApp() && !/[?&]stay=1/.test(location.search)) {
        location.replace("/dealer/dealer-dashboard.html");
    }
})();
