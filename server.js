const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const PORT = process.env.PORT || 7777;
const AIRPORTS_CSV = "https://davidmegginson.github.io/ourairports-data/airports.csv";
const METAR_API = "https://aviationweather.gov/api/data/metar";
const ADSB_API = "https://api.adsb.lol";
const ADSB_RADIUS_NM = 30;
const SCHEDULE_CACHE_MS = 120000;
const TILE_SERVER = "https://tile.openstreetmap.org";
const MAX_TILE_ZOOM = 19;
const PUBLIC_DIR = path.join(__dirname, "public");

let airportCache = null;
const scheduleCache = new Map();

function send(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store"
  });
  res.end(body);
}

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

  return decodedValue.trim().replace(/\s+/g, " ");
}

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
  if (airportCache) return airportCache;

  const response = await fetch(AIRPORTS_CSV);
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
  return airportCache;
}

async function getAirport(icao) {
  const airports = await loadAirports();
  return airports.get(icao) || null;
}

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
  const url = `${METAR_API}?ids=${encodeURIComponent(icao)}&format=decoded`;
  const response = await fetch(url);
  const decoded = await response.text();

  if (!response.ok) throw new Error("Could not load METAR.");
  if (!decoded.trim()) throw new Error("No METAR found for this airport.");

  const rawMatch = decoded.match(/Text:\s*(.+)/);
  return {
    raw: rawMatch ? rawMatch[1].trim() : decoded.trim(),
    decoded: decoded.trim()
  };
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
  const cacheKey = `${airport.icao}:${type}`;
  const cached = scheduleCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < SCHEDULE_CACHE_MS) return cached.flights;

  const scheduleUrl = new URL(`${ADSB_API}/v2/point/${airport.lat}/${airport.lon}/${ADSB_RADIUS_NM}`);
  const response = await fetch(scheduleUrl);
  if (response.status === 404) {
    scheduleCache.set(cacheKey, { timestamp: Date.now(), flights: [] });
    return [];
  }
  if (response.status === 429) {
    if (cached) return cached.flights;
    throw new Error("ADSB.lol rate limit reached. Try again later.");
  }
  if (!response.ok) throw new Error("Could not load ADSB.lol flight movements.");

  const payload = await response.json();
  const flights = Array.isArray(payload.ac) ? payload.ac : [];
  const normalizedFlights = flights
    .map(aircraft => {
      const callsign = String(aircraft.flight || aircraft.r || aircraft.hex || "").trim() || "Unknown flight";
      const movementType = classifyAdsbMovement(airport, aircraft);
      if (!movementType || movementType !== type) return null;

      const observedAt = Number.isFinite(Number(aircraft.seen))
        ? new Date(Date.now() - Number(aircraft.seen) * 1000).toISOString()
        : null;
      const airlineCode = callsign.match(/^[A-Z]{2,3}/)?.[0] || "";

      return {
        flight: {
          number: callsign,
          callsign,
          iataNumber: callsign,
          icaoNumber: callsign,
          icao24: aircraft.hex || ""
        },
        airline: { name: "", code: airlineCode },
        departure: {
          iataCode: airport.iata || "",
          icaoCode: airport.icao || "",
          name: airport.name || "",
          city: airport.city || ""
        },
        arrival: {
          iataCode: airport.iata || "",
          icaoCode: airport.icao || "",
          name: airport.name || "",
          city: airport.city || ""
        },
        status: type === "arrival" ? "recent arrival · ADSB.lol" : "recent departure · ADSB.lol",
        movementType: type,
        observedAt,
        liveSource: "ADSB.lol"
      };
    })
    .filter(Boolean)
    .sort((first, second) => new Date(second.observedAt || 0) - new Date(first.observedAt || 0))
    .slice(0, 40);

  scheduleCache.set(cacheKey, { timestamp: Date.now(), flights: normalizedFlights });
  return normalizedFlights;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

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
    if (!normalizedIcao || !["arrival", "departure"].includes(type)) {
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
          "Cache-Control": response.headers.get("cache-control") || "public, max-age=3600"
        });

        const body = await response.arrayBuffer();
        res.end(Buffer.from(body));
      } catch (err) {
        send(res, 502, "Tile proxy error");
      }
      return;
    }
  }

  const requestedPath = decodeURIComponent(url.pathname);
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
