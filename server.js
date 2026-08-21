const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const PORT = process.env.PORT || 7777;
const AIRPORTS_CSV = "https://davidmegginson.github.io/ourairports-data/airports.csv";
const METAR_API = "https://aviationweather.gov/api/data/metar";
const OPENSKY_API = "https://opensky-network.org/api/flights";
const OPENSKY_METADATA_API = "https://opensky-network.org/api/metadata/aircraft/icao24";
const OPENSKY_USERNAME = process.env.OPENSKY_USERNAME || "";
const OPENSKY_PASSWORD = process.env.OPENSKY_PASSWORD || "";
const SCHEDULE_CACHE_MS = 120000;
const METADATA_CACHE_MS = 86400000;
const TILE_SERVER = "https://tile.openstreetmap.org";
const MAX_TILE_ZOOM = 19;
const PUBLIC_DIR = path.join(__dirname, "public");

let airportCache = null;
const scheduleCache = new Map();
const metadataCache = new Map();

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

async function getSchedule(airport, type) {
  const cacheKey = `${airport.icao}:${type}`;
  const cached = scheduleCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < SCHEDULE_CACHE_MS) return cached.flights;

  const end = Math.floor(Date.now() / 1000);
  const begin = end - 2 * 60 * 60;
  const scheduleUrl = new URL(`${OPENSKY_API}/${type}`);
  scheduleUrl.searchParams.set("airport", airport.icao);
  scheduleUrl.searchParams.set("begin", begin);
  scheduleUrl.searchParams.set("end", end);

  const headers = OPENSKY_USERNAME && OPENSKY_PASSWORD
    ? { Authorization: `Basic ${btoa(`${OPENSKY_USERNAME}:${OPENSKY_PASSWORD}`)}` }
    : {};
  const response = await fetch(scheduleUrl, { headers });
  if (response.status === 404) {
    scheduleCache.set(cacheKey, { timestamp: Date.now(), flights: [] });
    return [];
  }
  if (response.status === 429) {
    if (cached) return cached.flights;
    throw new Error("OpenSky rate limit reached. Try again later.");
  }
  if (!response.ok) throw new Error("Could not load OpenSky flight movements.");

  const flights = await response.json();
  const airports = await loadAirports();
  const normalizedFlights = (Array.isArray(flights) ? flights : []).map(flight => {
    const departure = airports.get(flight.estDepartureAirport) || {};
    const arrival = airports.get(flight.estArrivalAirport) || {};
    const callsign = flight.callsign?.trim() || flight.icao24 || "Unknown flight";
    const observedAt = new Date((type === "arrival" ? flight.lastSeen : flight.firstSeen) * 1000).toISOString();

    return {
      flight: { iataNumber: callsign, icaoNumber: callsign, icao24: flight.icao24 || "" },
      airline: { name: callsign === "Unknown flight" ? "Airline unavailable" : callsign.slice(0, 3) },
      departure: {
        iataCode: departure.iata || flight.estDepartureAirport || (type === "departure" ? airport.iata : "Unknown"),
        icaoCode: flight.estDepartureAirport || "",
        scheduledTime: null
      },
      arrival: {
        iataCode: arrival.iata || flight.estArrivalAirport || (type === "arrival" ? airport.iata : "Unknown"),
        icaoCode: flight.estArrivalAirport || "",
        scheduledTime: null
      },
      status: type === "arrival" ? "recent arrival · OpenSky" : "recent departure · OpenSky",
      observedAt,
      liveSource: "OpenSky Network"
    };
  }).slice(0, 40);

  const enrichedFlights = await Promise.all(normalizedFlights.map(async flight => {
    const icao24 = flight.flight.icao24;
    if (!icao24 || icao24 === "Unknown flight") return flight;

    const cachedMetadata = metadataCache.get(icao24);
    if (cachedMetadata && Date.now() - cachedMetadata.timestamp < METADATA_CACHE_MS) {
      flight.aircraft = cachedMetadata.aircraft;
      return flight;
    }

    try {
      const metadataResponse = await fetch(`${OPENSKY_METADATA_API}/${encodeURIComponent(icao24)}`, { headers });
      if (!metadataResponse.ok) return flight;
      const metadata = await metadataResponse.json();
      flight.aircraft = {
        registration: metadata.registration || "",
        model: metadata.model || metadata.typecode || ""
      };
      metadataCache.set(icao24, { timestamp: Date.now(), aircraft: flight.aircraft });
    } catch {
      // Aircraft metadata is optional; the movement record remains useful without it.
    }
    return flight;
  }));
  scheduleCache.set(cacheKey, { timestamp: Date.now(), flights: enrichedFlights });
  return enrichedFlights;
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
            Referer: `http://localhost:${PORT}`
          }
        });

        if (!response.ok) {
          send(res, 502, "Unable to load tile");
          return;
        }

        res.writeHead(200, {
          "Content-Type": "image/png",
          "Cache-Control": "public, max-age=3600"
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
