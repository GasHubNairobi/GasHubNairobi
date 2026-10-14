document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("dealerSetupForm");
  const message = document.getElementById("setupMessage");
  const button = document.getElementById("setupSubmit");
  const token = localStorage.getItem("gashub_dealer_token");
  const requiresSetup = localStorage.getItem("gashub_dealer_requires_setup") === "true";
  if (!token || !requiresSetup) {
    window.location.replace("dealer-login.html");
    return;
  }
  const user = JSON.parse(localStorage.getItem("gashub_dealer_user") || "{}");
  const dealer = JSON.parse(localStorage.getItem("gashub_dealer") || "{}");
  document.getElementById("setupUsername").value = user.user_code || "";
  document.getElementById("setupFullName").value = user.full_name && user.full_name !== user.user_code ? user.full_name : "";
  document.getElementById("setupBusinessName").value = dealer.business_name && !dealer.business_name.startsWith("Pending setup") ? dealer.business_name : "";

  // GPS Map Location Pinning
  const latInput = document.getElementById("latitude");
  const lngInput = document.getElementById("longitude");
  const pinStatusBox = document.getElementById("pinStatus");
  const pinStatusText = document.getElementById("pinStatusText");
  const btnDetect = document.getElementById("btnDetectLocation");

  let map = null;
  let marker = null;

  function initMap() {
    const initialLat = Number(dealer.latitude) || -1.286389;
    const initialLng = Number(dealer.longitude) || 36.817223;
    const hasInitialCoords = Number.isFinite(Number(dealer.latitude)) && Number.isFinite(Number(dealer.longitude));

    if (window.L && document.getElementById("dealerLocationMap")) {
      map = L.map("dealerLocationMap").setView([initialLat, initialLng], hasInitialCoords ? 15 : 12);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: "&copy; OpenStreetMap contributors"
      }).addTo(map);

      map.on("click", (e) => {
        setPin(e.latlng.lat, e.latlng.lng, false);
      });

      if (hasInitialCoords) {
        setPin(initialLat, initialLng, 15);
      }
    }
  }

  function setPin(lat, lng, zoom) {
    const numLat = Number(lat);
    const numLng = Number(lng);
    if (!Number.isFinite(numLat) || !Number.isFinite(numLng)) return;

    latInput.value = numLat.toFixed(7);
    lngInput.value = numLng.toFixed(7);

    /* the map may be missing (blocked or offline): the pin is still saved in the hidden fields */
    if (map && window.L) {
      if (!marker) {
        marker = L.marker([numLat, numLng], { draggable: true }).addTo(map);
        marker.on("dragend", () => {
          const p = marker.getLatLng();
          setPin(p.lat, p.lng, false);
        });
      } else {
        marker.setLatLng([numLat, numLng]);
      }
      if (zoom) map.setView([numLat, numLng], zoom);
    }

    if (pinStatusBox && pinStatusText) {
      pinStatusBox.classList.add("pinned");
      pinStatusText.textContent = `Pinned GPS: ${numLat.toFixed(5)}, ${numLng.toFixed(5)} · Drag pin to fine-tune.`;
    }
  }

  if (btnDetect) {
    btnDetect.addEventListener("click", () => {
      if (!navigator.geolocation) {
        message.textContent = "Geolocation is not supported by your browser. Please click the map to select your location.";
        message.className = "auth-message error";
        return;
      }

      btnDetect.disabled = true;
      btnDetect.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Detecting GPS…';
      if (pinStatusText) pinStatusText.textContent = "Requesting device location…";

      navigator.geolocation.getCurrentPosition(
        (pos) => {
          btnDetect.disabled = false;
          btnDetect.innerHTML = '<i class="fa-solid fa-location-crosshairs"></i> Detect My GPS Location';
          setPin(pos.coords.latitude, pos.coords.longitude, 16);
          message.textContent = "Location detected successfully.";
          message.className = "auth-message success";
        },
        (err) => {
          btnDetect.disabled = false;
          btnDetect.innerHTML = '<i class="fa-solid fa-location-crosshairs"></i> Detect My GPS Location';
          message.textContent = "Could not retrieve your GPS location. Please click directly on the map to place your pin.";
          message.className = "auth-message error";
        },
        { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 }
      );
    });
  }

  initMap();

  form.addEventListener("submit", async event => {
    event.preventDefault();
    message.textContent = "";
    const data = Object.fromEntries(new FormData(form).entries());

    if (!data.latitude || !data.longitude) {
      message.textContent = "Please pin your business location on the map before submitting.";
      message.className = "auth-message error";
      pinStatusBox.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }

    if (data.new_password !== data.confirm_password) {
      message.textContent = "The new passwords do not match.";
      message.className = "auth-message error";
      return;
    }
    button.disabled = true;
    button.textContent = "Saving…";
    try {
      const response = await fetch("/api/dealers/complete-setup", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(data)
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.success) throw new Error(result.message || "Could not save your details.");
      localStorage.setItem("gashub_dealer_user", JSON.stringify(result.user || {}));
      localStorage.setItem("gashub_dealer", JSON.stringify(result.dealer || dealer));
      localStorage.setItem("gashub_dealer_id", String(result.dealer?.id || dealer.id || ""));
      localStorage.setItem("gashub_dealer_code", String(result.dealer?.dealer_code || dealer.dealer_code || ""));
      localStorage.setItem("gashub_dealer_requires_setup", "false");
      /* the dealer is already signed in and the setup is done, so keep the session and open the dashboard */
      message.textContent = "Your account is ready. Opening your dashboard...";
      message.className = "auth-message success";
      window.setTimeout(() => window.location.replace("dealer-dashboard.html"), 800);
    } catch (error) {
      message.textContent = error.message || "Unable to save account details.";
      message.className = "auth-message error";
    } finally {
      button.disabled = false;
      button.textContent = "Save details and secure account";
    }
  });
});