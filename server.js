const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

// Mirrors src/worker.js; the request and asset handlers differ between Node and Cloudflare.
// These addresses point to public data providers. The app does not need secret API keys.
// The local server asks these services for data so the browser only needs to call this site.
const PORT = process.env.PORT || 7777;
const AIRPORTS_CSV = "https://davidmegginson.github.io/ourairports-data/airports.csv";
const RUNWAYS_CSV = "https://davidmegginson.github.io/ourairports-data/runways.csv";
const METAR_API = "https://aviationweather.gov/api/data/metar";
const TAF_API = "https://aviationweather.gov/api/data/taf";
const PIREP_API = "https://aviationweather.gov/api/data/pirep";
const AIRSIGMET_API = "https://aviationweather.gov/api/data/airsigmet";
const ADSB_API = "https://api.adsb.lol";
const OPEN_METEO_API = "https://api.open-meteo.com/v1/forecast";
const FAA_STATUS_API = "https://nasstatus.faa.gov/api/airport-events";
const ADSB_RADIUS_NM = 25;
const SCHEDULE_CACHE_MS = 120000;
const AWC_CACHE_MS = 60000;
const ADSB_CACHE_MS = 15000;
const ADSB_RATE_LIMIT_FALLBACK_SECONDS = 60;
const OPEN_METEO_CACHE_MS = 900000;
const AIRPORT_DATA_CACHE_MS = 86400000;
const FAA_CACHE_MS = 60000;
const OSM_TILE_FALLBACK_CACHE_SECONDS = 604800;
const TILE_SERVER = "https://tile.openstreetmap.org";
const MAX_TILE_ZOOM = 19;
const PUBLIC_DIR = path.join(__dirname, "public");

// Keep downloaded reference data and recent provider results in memory.
// Caching reduces repeat downloads and avoids asking providers for the same data too often.
let airportCache = null;
let airportCacheTimestamp = 0;
const scheduleCache = new Map();
const trafficRateLimits = new Map();
const providerCache = new Map();

async function getCached(cacheKey, ttl, load) {
  const cached = providerCache.get(cacheKey);
  if (cached?.promise) return cached.promise;
  if (cached && Date.now() - cached.timestamp < ttl) return cached.value;

  const promise = Promise.resolve().then(load).then(value => {
    providerCache.set(cacheKey, { timestamp: Date.now(), value });
    return value;
  }, error => {
    providerCache.delete(cacheKey);
    throw error;
  });
  providerCache.set(cacheKey, { timestamp: Date.now(), promise });
  return promise;
}

function providerHeaders() {
  return {
    "User-Agent": "FlightWeather/1.0 (+https://flightweather.org/)",
    Accept: "application/json"
  };
}

async function fetchProviderJson(url, label) {
  const response = await fetch(url, { headers: providerHeaders() });
  if (response.status === 204 || response.status === 404) return null;
  if (!response.ok) {
    const error = new Error(`${label} data unavailable (${response.status}).`);
    error.status = response.status;
    error.retryAfter = response.headers.get("retry-after");
    throw error;
  }
  return response.json();
}

// Providers may return one record, a list, or a { data: [...] } object.
// Convert those shapes to a list so the rest of the app can process them consistently.
function asRecordList(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.data)) return value.data;
  if (value && typeof value === "object") return [value];
  return [];
}

// A missing measurement is different from zero (for example, calm wind).
function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

// Send a response with consistent browser safety headers and an explicit content type.
function send(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()"
  });
  res.end(body);
}

// ICAO station codes use four uppercase letters/numbers; discard other input characters.
function cleanIcao(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);
}

function cleanAirportQuery(value) {
  const encodedValue = String(value || "");
  let decodedValue = encodedValue;

  try {
    decodedValue = decodeURIComponent(encodedValue);
  } catch {
    // Keep malformed input routable so it can produce a normal not-found response.
  }

  return decodedValue.trim().replace(/\s+/g, " ").slice(0, 80);
}

// Split one CSV row while respecting commas inside quoted fields and escaped quotes.
function parseCsvLine(line) {
  const out = [];
  let value = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === '"' && quoted && next === '"') {
      value += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      out.push(value);
      value = "";
    } else {
      value += char;
    }
  }

  out.push(value);
  return out;
}

async function loadAirports() {
  if (airportCache && Date.now() - airportCacheTimestamp < AIRPORT_DATA_CACHE_MS) return airportCache;

  const response = await fetch(AIRPORTS_CSV, { headers: providerHeaders() });
  if (!response.ok) throw new Error("Could not load airport database.");

  const csv = await response.text();
  const lines = csv.split(/\r?\n/).filter(Boolean);
  const headers = parseCsvLine(lines.shift());
  const idx = Object.fromEntries(headers.map((header, index) => [header, index]));
  const airports = new Map();

  for (const line of lines) {
    const row = parseCsvLine(line);
    const ident = row[idx.ident];
    if (!ident || ident.length !== 4) continue;

    airports.set(ident.toUpperCase(), {
      icao: ident.toUpperCase(),
      iata: row[idx.iata_code] || "--",
      name: row[idx.name] || ident.toUpperCase(),
      city: row[idx.municipality] || "",
      country: row[idx.iso_country] || "",
      lat: row[idx.latitude_deg] || "",
      lon: row[idx.longitude_deg] || ""
    });
  }

  airportCache = airports;
  airportCacheTimestamp = Date.now();
  return airportCache;
}

async function getAirport(icao) {
  const airports = await loadAirports();
  return airports.get(icao) || null;
}

// Resolve a full search phrase: prefer an exact ICAO match, otherwise match name, city, or IATA.
async function findAirport(query) {
  const airports = await loadAirports();
  const normalizedQuery = query.toLowerCase();
  const icao = cleanIcao(query);
  const exactAirport = airports.get(icao);
  if (exactAirport) return exactAirport;

  return [...airports.values()]
    .filter(airport =>
      [airport.name, airport.city, airport.iata].some(value =>
        value.toLowerCase().includes(normalizedQuery)
      )
    )
    .sort((first, second) => {
      const firstName = first.name.toLowerCase();
      const secondName = second.name.toLowerCase();
      return Number(!firstName.startsWith(normalizedQuery)) - Number(!secondName.startsWith(normalizedQuery));
    })[0] || null;
}

async function findAirports(query, limit = 8) {
  const airports = await loadAirports();
  const normalizedQuery = query.toLowerCase();

  return [...airports.values()]
    .filter(airport =>
      [airport.icao, airport.iata, airport.name, airport.city].some(value =>
        value.toLowerCase().includes(normalizedQuery)
      )
    )
    .sort((first, second) => {
      const firstValues = [first.icao, first.iata, first.name, first.city].map(value => value.toLowerCase());
      const secondValues = [second.icao, second.iata, second.name, second.city].map(value => value.toLowerCase());
      const firstRank = firstValues.findIndex(value => value.startsWith(normalizedQuery));
      const secondRank = secondValues.findIndex(value => value.startsWith(normalizedQuery));
      return (firstRank < 0 ? 4 : firstRank) - (secondRank < 0 ? 4 : secondRank);
    })
    .slice(0, limit);
}

async function getMetar(icao) {
  return getCached(`metar:${icao}`, AWC_CACHE_MS, async () => {
    const url = `${METAR_API}?ids=${encodeURIComponent(icao)}&format=json`;
    const observations = asRecordList(await fetchProviderJson(url, "METAR"));
    const observation = observations[0];
    if (!observation) throw new Error("No METAR found for this airport.");

    const raw = String(observation.rawOb || observation.raw || "").trim();
    const decodedLines = [];
    if (numberOrNull(observation.temp) !== null) decodedLines.push(`Temperature: ${observation.temp}C`);
    if (numberOrNull(observation.dewp) !== null) decodedLines.push(`Dewpoint: ${observation.dewp}C`);
    if (numberOrNull(observation.wdir) !== null && numberOrNull(observation.wspd) !== null) {
      decodedLines.push(`Winds: from ${observation.wdir} degrees at ${observation.wspd} knots`);
    }
    if (observation.visib) decodedLines.push(`Visibility: ${observation.visib} SM`);
    const ceiling = asRecordList(observation.clouds).find(cloud =>
      ["BKN", "OVC", "VV"].includes(String(cloud.cover || "").toUpperCase()) && numberOrNull(cloud.base) !== null
    );
    if (ceiling) decodedLines.push(`Ceiling ${ceiling.base} ft`);
    if (observation.altim) decodedLines.push(`Altimeter: ${observation.altim} inches Hg`);
    return {
      raw,
      decoded: [raw, ...decodedLines].filter(Boolean).join("\n"),
      observation
    };
  });
}

async function getTaf(icao) {
  return getCached(`taf:${icao}`, AWC_CACHE_MS, async () => {
    const url = `${TAF_API}?ids=${encodeURIComponent(icao)}&format=json`;
    return asRecordList(await fetchProviderJson(url, "TAF")).slice(0, 10);
  });
}

// The provider's distance parameter is in nautical miles.
async function getPireps(icao) {
  return getCached(`pirep:${icao}`, AWC_CACHE_MS, async () => {
    const url = `${PIREP_API}?id=${encodeURIComponent(icao)}&distance=40&format=json`;
    return asRecordList(await fetchProviderJson(url, "Pilot reports")).slice(0, 100);
  });
}

// Check whether a latitude/longitude point falls inside a weather-alert polygon.
// The result helps show only alert areas that cover this airport.
function isPointInPolygon(point, polygon) {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const [longitude, latitude] = polygon[index] || [];
    const [previousLongitude, previousLatitude] = polygon[previous] || [];
    if (![longitude, latitude, previousLongitude, previousLatitude].every(Number.isFinite)) continue;

    const crossesLatitude = (latitude > point.lat) !== (previousLatitude > point.lat);
    const crossingLongitude =
      ((previousLongitude - longitude) * (point.lat - latitude)) /
        (previousLatitude - latitude) +
      longitude;
    if (crossesLatitude && point.lon < crossingLongitude) inside = !inside;
  }
  return inside;
}

async function getWeatherAlerts(airport) {
  const alerts = await getCached("airsigmet:active", AWC_CACHE_MS, async () => {
    const url = `${AIRSIGMET_API}?format=json`;
    return asRecordList(await fetchProviderJson(url, "Aviation weather alerts"));
  });
  const point = { lat: numberOrNull(airport.lat), lon: numberOrNull(airport.lon) };
  if (point.lat === null || point.lon === null) return [];

  return alerts.filter(alert => {
    const coordinates = Array.isArray(alert.coords)
      ? alert.coords.map(coordinate => [numberOrNull(coordinate.lon), numberOrNull(coordinate.lat)])
      : [];
    return coordinates.length >= 3 && isPointInPolygon(point, coordinates);
  });
}

async function getTraffic(airport) {
  const retryUntil = trafficRateLimits.get(airport.icao);
  if (retryUntil > Date.now()) {
    const seconds = Math.ceil((retryUntil - Date.now()) / 1000);
    throw new Error(`Live aircraft feed is rate-limited. Try again in about ${seconds} seconds.`);
  }
  trafficRateLimits.delete(airport.icao);

  try {
    return await getCached(`traffic:${airport.icao}`, ADSB_CACHE_MS, async () => {
      const url = `${ADSB_API}/v2/point/${airport.lat}/${airport.lon}/${ADSB_RADIUS_NM}`;
      const payload = await fetchProviderJson(url, "Live aircraft");
      return { ac: Array.isArray(payload?.ac) ? payload.ac.slice(0, 200) : [] };
    });
  } catch (error) {
    if (error.status === 429) {
      const retryAfter = Number(error.retryAfter);
      const retryAt = Date.parse(error.retryAfter);
      const seconds = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter
        : Number.isFinite(retryAt) && retryAt > Date.now()
          ? Math.ceil((retryAt - Date.now()) / 1000)
          : ADSB_RATE_LIMIT_FALLBACK_SECONDS;
      trafficRateLimits.set(airport.icao, Date.now() + seconds * 1000);
      error.message = `Live aircraft feed is rate-limited. Try again in about ${seconds} seconds.`;
    }
    throw error;
  }
}

async function getWindsAloft(airport) {
  return getCached(`winds:${airport.icao}`, OPEN_METEO_CACHE_MS, async () => {
    const url = new URL(OPEN_METEO_API);
    url.search = new URLSearchParams({
      latitude: airport.lat,
      longitude: airport.lon,
      hourly: "wind_speed_80m,wind_direction_80m,freezing_level_height",
      daily: "sunrise,sunset",
      timezone: "auto",
      forecast_days: "1"
    }).toString();
    return fetchProviderJson(url, "Winds aloft");
  });
}

async function getAirportRunways(icao) {
  const runways = await getCached("runways:all", AIRPORT_DATA_CACHE_MS, async () => {
    const response = await fetch(RUNWAYS_CSV, { headers: providerHeaders() });
    if (!response.ok) throw new Error(`Runway data unavailable (${response.status}).`);
    const lines = (await response.text()).split(/\r?\n/).filter(Boolean);
    const headers = parseCsvLine(lines.shift() || "");
    const indexes = Object.fromEntries(headers.map((header, index) => [header, index]));

    return lines.map(line => {
      const row = parseCsvLine(line);
      return {
        airportIdent: String(row[indexes.airport_ident] || "").toUpperCase(),
        lowIdent: row[indexes.le_ident] || "",
        highIdent: row[indexes.he_ident] || "",
        lowHeadingDeg: numberOrNull(row[indexes.le_heading_degT]),
        highHeadingDeg: numberOrNull(row[indexes.he_heading_degT]),
        lengthFt: numberOrNull(row[indexes.length_ft]),
        surface: row[indexes.surface] || ""
      };
    });
  });
  return runways.filter(runway => runway.airportIdent === icao);
}

// The FAA airport-events feed covers U.S. airports only.
async function getFaaStatus(icao) {
  if (!icao.startsWith("K")) return null;
  return getCached("faa:airport-events", FAA_CACHE_MS, async () => {
    const response = await fetch(FAA_STATUS_API, { headers: providerHeaders() });
    if (!response.ok) throw new Error(`FAA NAS status unavailable (${response.status}).`);
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("json")) return response.json();
    return response.text();
  });
}

// Promise.allSettled keeps one unavailable provider from hiding all the other weather information.
async function getBriefing(airport) {
  const sources = {
    metar: () => getMetar(airport.icao),
    taf: () => getTaf(airport.icao),
    pireps: () => getPireps(airport.icao),
    weatherAlerts: () => getWeatherAlerts(airport),
    windsAloft: () => getWindsAloft(airport),
    runways: () => getAirportRunways(airport.icao),
    faaStatus: () => getFaaStatus(airport.icao)
  };
  const entries = Object.entries(sources);
  const results = await Promise.allSettled(entries.map(([, load]) => load()));
  const briefing = { airport, errors: {} };

  results.forEach((result, index) => {
    const key = entries[index][0];
    if (result.status === "fulfilled") {
      briefing[key] = result.value;
    } else {
      briefing.errors[key] = result.reason instanceof Error ? result.reason.message : "Source unavailable.";
    }
  });
  return briefing;
}

function toDegrees(value) {
  return Number(value);
}

function normalizeHeading(value) {
  const degrees = toDegrees(value);
  if (!Number.isFinite(degrees)) return 0;
  return (degrees % 360 + 360) % 360;
}

function getBearing(startLat, startLon, endLat, endLon) {
  const startLatRad = (startLat * Math.PI) / 180;
  const endLatRad = (endLat * Math.PI) / 180;
  const deltaLon = ((endLon - startLon) * Math.PI) / 180;
  const y = Math.sin(deltaLon) * Math.cos(endLatRad);
  const x = Math.cos(startLatRad) * Math.sin(endLatRad) - Math.sin(startLatRad) * Math.cos(endLatRad) * Math.cos(deltaLon);
  const degrees = (Math.atan2(y, x) * 180) / Math.PI;
  return (degrees + 360) % 360;
}

function headingDifference(first, second) {
  const diff = Math.abs(first - second);
  return Math.min(diff, 360 - diff);
}

function classifyAdsbMovement(airport, aircraft) {
  const airportLat = toDegrees(airport.lat);
  const airportLon = toDegrees(airport.lon);
  const aircraftLat = toDegrees(aircraft.lat);
  const aircraftLon = toDegrees(aircraft.lon);
  const headingValue = aircraft.true_heading ?? aircraft.track ?? aircraft.dir ?? null;
  const heading = normalizeHeading(headingValue ?? 0);
  const hasHeading = headingValue !== null && headingValue !== undefined;

  if (!Number.isFinite(airportLat) || !Number.isFinite(airportLon) || !Number.isFinite(aircraftLat) || !Number.isFinite(aircraftLon)) {
    return null;
  }
  if (!hasHeading) return null;

  const aircraftToAirportBearing = getBearing(aircraftLat, aircraftLon, airportLat, airportLon);
  const towardAirportDifference = headingDifference(heading, aircraftToAirportBearing);
  const awayFromAirportDifference = headingDifference(heading, (aircraftToAirportBearing + 180) % 360);

  if (towardAirportDifference <= 45) return "arrival";
  if (awayFromAirportDifference <= 45) return "departure";
  return null;
}

async function getSchedule(airport, type) {
  const cacheKey = airport.icao;
  const cached = scheduleCache.get(cacheKey);
  let flights = cached?.flights;
  if (!cached || Date.now() - cached.timestamp >= SCHEDULE_CACHE_MS) {
    try {
      const payload = await getTraffic(airport);
      flights = (Array.isArray(payload.ac) ? payload.ac : [])
        .map(aircraft => {
          const movementType = classifyAdsbMovement(airport, aircraft);
          if (!movementType) return null;

          const callsign = String(aircraft.flight || aircraft.r || aircraft.hex || "").trim() || "Unknown flight";
          const observedAt = Number.isFinite(Number(aircraft.seen))
            ? new Date(Date.now() - Number(aircraft.seen) * 1000).toISOString()
            : null;
          const airlineCode = callsign.match(/^[A-Z]{2,3}/)?.[0] || "";
          const station = {
            iataCode: airport.iata || "",
            icaoCode: airport.icao || "",
            name: airport.name || "",
            city: airport.city || ""
          };

          return {
            flight: {
              number: callsign,
              callsign,
              iataNumber: callsign,
              icaoNumber: callsign,
              icao24: aircraft.hex || ""
            },
            airline: { name: "", code: airlineCode },
            departure: station,
            arrival: station,
            status: `recent ${movementType} · ADSB.lol`,
            movementType,
            observedAt,
            liveSource: "ADSB.lol"
          };
        })
        .filter(Boolean)
        .sort((first, second) => new Date(second.observedAt || 0) - new Date(first.observedAt || 0));
      scheduleCache.set(cacheKey, { timestamp: Date.now(), flights });
    } catch (error) {
      if (!cached || Date.now() - cached.timestamp >= SCHEDULE_CACHE_MS * 5) throw error;
      flights = cached.flights;
    }
  }

  return flights
    .filter(flight => type === "all" || flight.movementType === type)
    .slice(0, 40);
}

const server = http.createServer(async (req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    send(res, 405, "Method not allowed");
    return;
  }

  let url;
  try {
    url = new URL(req.url, "http://localhost");
  } catch {
    send(res, 400, "Invalid request URL");
    return;
  }

  if (url.pathname.startsWith("/api/airport/")) {
    const query = cleanAirportQuery(url.pathname.split("/").pop());

    try {
      const airport = await findAirport(query);
      if (!airport) {
        send(res, 404, JSON.stringify({ error: `No airport found for ${query}` }), "application/json; charset=utf-8");
        return;
      }
      send(res, 200, JSON.stringify({ airport }), "application/json; charset=utf-8");
    } catch (err) {
      send(res, 500, JSON.stringify({ error: err.message }), "application/json; charset=utf-8");
    }
    return;
  }

  if (url.pathname === "/api/airports") {
    const query = cleanAirportQuery(url.searchParams.get("query"));

    if (query.length < 3) {
      send(res, 200, JSON.stringify({ airports: [] }), "application/json; charset=utf-8");
      return;
    }

    try {
      const airports = await findAirports(query);
      send(res, 200, JSON.stringify({ airports }), "application/json; charset=utf-8");
    } catch (err) {
      send(res, 500, JSON.stringify({ error: err.message }), "application/json; charset=utf-8");
    }
    return;
  }

  if (url.pathname.startsWith("/api/briefing/")) {
    const icao = cleanIcao(url.pathname.split("/").pop());
    if (icao.length !== 4) {
      send(res, 400, JSON.stringify({ error: "Enter a valid four-character ICAO code." }), "application/json; charset=utf-8");
      return;
    }

    try {
      const airport = await getAirport(icao);
      if (!airport) {
        send(res, 404, JSON.stringify({ error: "Airport not found." }), "application/json; charset=utf-8");
        return;
      }
      const briefing = await getBriefing(airport);
      send(res, 200, JSON.stringify(briefing), "application/json; charset=utf-8");
    } catch (err) {
      send(res, 502, JSON.stringify({ error: err.message }), "application/json; charset=utf-8");
    }
    return;
  }

  if (url.pathname.startsWith("/api/metar/")) {
    const icao = cleanIcao(url.pathname.split("/").pop());

    try {
      const metar = await getMetar(icao);
      send(res, 200, JSON.stringify(metar), "application/json; charset=utf-8");
    } catch (err) {
      send(res, 500, JSON.stringify({ error: err.message }), "application/json; charset=utf-8");
    }
    return;
  }

  if (url.pathname.startsWith("/api/schedule/")) {
    const [, , , icaoCode, type] = url.pathname.split("/");
    const normalizedIcao = cleanIcao(icaoCode);
    if (!normalizedIcao || !["all", "arrival", "departure"].includes(type)) {
      send(res, 400, JSON.stringify({ error: "Invalid schedule request." }), "application/json; charset=utf-8");
      return;
    }

    try {
      const airport = await getAirport(normalizedIcao);
      if (!airport) {
        send(res, 404, JSON.stringify({ error: "Airport not found." }), "application/json; charset=utf-8");
        return;
      }
      const flights = await getSchedule(airport, type);
      send(res, 200, JSON.stringify({ flights }), "application/json; charset=utf-8");
    } catch (err) {
      send(res, 502, JSON.stringify({ error: err.message }), "application/json; charset=utf-8");
    }
    return;
  }

  if (url.pathname.startsWith("/tiles/")) {
    const [, , z, x, file] = url.pathname.split("/");
    const y = file.replace(".png", "");
    const zNum = Number(z);
    const xNum = Number(x);
    const yNum = Number(y);

    if (
      Number.isInteger(zNum) && Number.isInteger(xNum) && Number.isInteger(yNum) &&
      zNum >= 0 && zNum <= MAX_TILE_ZOOM &&
      xNum >= 0 && yNum >= 0
    ) {
      const tileUrl = `${TILE_SERVER}/${z}/${x}/${y}.png`;
      try {
        const response = await fetch(tileUrl, {
          headers: {
            "User-Agent": "FlightWeather/1.0 (+https://flightweather.org/)",
            Referer: req.headers.referer || `http://localhost:${PORT}/`
          }
        });

        if (!response.ok) {
          send(res, 502, "Unable to load tile");
          return;
        }

        res.writeHead(200, {
          "Content-Type": "image/png",
          "Cache-Control": response.headers.get("cache-control") || `public, max-age=${OSM_TILE_FALLBACK_CACHE_SECONDS}`
        });

        const body = await response.arrayBuffer();
        res.end(Buffer.from(body));
      } catch (err) {
        send(res, 502, "Tile proxy error");
      }
      return;
    }
  }

  // Keep decoded request paths inside public/ to prevent access to other local files.
  let requestedPath;
  try {
    requestedPath = decodeURIComponent(url.pathname);
  } catch {
    send(res, 400, "Invalid request path");
    return;
  }
  const relativePath = requestedPath === "/" ? "/index.html" : requestedPath;
  const filePath = path.resolve(PUBLIC_DIR, `.${relativePath}`);

  if (filePath.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
    try {
      const data = await fs.promises.readFile(filePath);
      const extension = path.extname(filePath).toLowerCase();
      const contentTypes = {
        ".css": "text/css; charset=utf-8",
        ".html": "text/html; charset=utf-8",
        ".js": "application/javascript; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".png": "image/png",
        ".svg": "image/svg+xml",
        ".ico": "image/x-icon"
      };
      send(res, 200, data, contentTypes[extension] || "application/octet-stream");
      return;
    } catch (err) {
      if (err.code !== "ENOENT") {
        send(res, 500, "Could not load requested file");
        return;
      }
    }
  }

  if (req.method === "GET" || req.method === "HEAD") {
    try {
      const data = await fs.promises.readFile(path.join(PUBLIC_DIR, "index.html"));
      send(res, 200, data, "text/html; charset=utf-8");
      return;
    } catch (err) {
      send(res, 500, "Could not load index.html");
      return;
    }
  }

  send(res, 404, "Not found");
});

server.listen(PORT, () => {
  console.log(`Open http://localhost:${PORT}`);
});
