/* Distance and travel time between two points (the dealer and the customer's pinned location).
   Tries the free OSRM road router first (real driving distance and time). If it can't be reached, falls back to the
   straight-line distance x 1.3 (roads are never straight) at an average 30 km/h, and says so (source: "estimate"). */
const cache = new Map();                    /* "lat,lng|lat,lng" -> { at, value } */
const TTL_MS = 6 * 60 * 60 * 1000;

const num = (v) => (v === null || v === undefined || v === "" ? NaN : Number(v));
const valid = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);

function haversineKm(a, b) {
    const R = 6371, rad = (d) => (d * Math.PI) / 180;
    const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
}

async function roadRoute(from, to) {
    const url = `https://router.project-osrm.org/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=false`;
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 5000);
    try {
        const r = await fetch(url, { signal: ctl.signal, headers: { Accept: "application/json" } });
        if (!r.ok) return null;
        const j = await r.json();
        const leg = j && j.code === "Ok" && j.routes && j.routes[0];
        return leg ? { km: leg.distance / 1000, minutes: leg.duration / 60 } : null;
    } catch (e) { return null; } finally { clearTimeout(timer); }
}

/* from / to: { lat, lng }.  Returns { ok, distance_km, duration_min, source } or { ok:false, reason } */
async function routeBetween(from, to) {
    const a = { lat: num(from && from.lat), lng: num(from && from.lng) }, b = { lat: num(to && to.lat), lng: num(to && to.lng) };
    if (!valid(a.lat, a.lng)) return { ok: false, reason: "dealer_location_missing" };
    if (!valid(b.lat, b.lng)) return { ok: false, reason: "customer_location_missing" };
    const key = `${a.lat.toFixed(5)},${a.lng.toFixed(5)}|${b.lat.toFixed(5)},${b.lng.toFixed(5)}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
    let km, minutes, source = "road";
    const road = await roadRoute(a, b);
    if (road) { km = road.km; minutes = road.minutes; }
    else { source = "estimate"; km = haversineKm(a, b) * 1.3; minutes = (km / 30) * 60; }
    const value = { ok: true, distance_km: Math.round(km * 10) / 10, duration_min: Math.max(1, Math.round(minutes)), source };
    if (cache.size > 500) cache.clear();
    cache.set(key, { at: Date.now(), value });
    return value;
}

module.exports = { routeBetween };
