const AIRPORTS_CSV = "https://davidmegginson.github.io/ourairports-data/airports.csv";
const METAR_API = "https://aviationweather.gov/api/data/metar";
const ADSB_API = "https://api.adsb.lol";
const ADSB_RADIUS_NM = 30;
const SCHEDULE_CACHE_MS = 120000;
const TILE_SERVER = "https://tile.openstreetmap.org";
const MAX_TILE_ZOOM = 19;

let airportCache = null;
const scheduleCache = new Map();

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
  if (!response.ok) throw new Error("Could not load METAR.");

  const decoded = await response.text();
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

async function getSchedule(airport, type, username, password) {
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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // API: Get airport info
    if (pathname.startsWith("/api/airport/")) {
      const query = cleanAirportQuery(pathname.split("/").pop());

      try {
        const airport = await findAirport(query);
        if (!airport) {
          return new Response(JSON.stringify({ error: `No airport found for ${query}` }), {
            status: 404,
            headers: { 
              "Content-Type": "application/json; charset=utf-8",
              "Access-Control-Allow-Origin": "*"
            }
          });
        }
        return new Response(JSON.stringify({ airport }), {
          status: 200,
          headers: { 
            "Content-Type": "application/json; charset=utf-8",
            "Access-Control-Allow-Origin": "*"
          }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { 
            "Content-Type": "application/json; charset=utf-8",
            "Access-Control-Allow-Origin": "*"
          }
        });
      }
    }

    // API: Search airports for autocomplete suggestions
    if (pathname === "/api/airports") {
      const query = cleanAirportQuery(url.searchParams.get("query"));
      if (query.length < 3) return new Response(JSON.stringify({ airports: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" }
      });

      try {
        const airports = await findAirports(query);
        return new Response(JSON.stringify({ airports }), {
          status: 200,
          headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" }
        });
      }
    }

    // API: Get METAR data
    if (pathname.startsWith("/api/metar/")) {
      const icao = cleanIcao(pathname.split("/").pop());

      try {
        const metar = await getMetar(icao);
        return new Response(JSON.stringify(metar), {
          status: 200,
          headers: { 
            "Content-Type": "application/json; charset=utf-8",
            "Access-Control-Allow-Origin": "*"
          }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { 
            "Content-Type": "application/json; charset=utf-8",
            "Access-Control-Allow-Origin": "*"
          }
        });
      }
    }

    // API: Get airport arrivals or departures
    if (pathname.startsWith("/api/schedule/")) {
      const [, , , icaoCode, type] = pathname.split("/");
      const normalizedIcao = cleanIcao(icaoCode);
      if (!normalizedIcao || !["arrival", "departure"].includes(type)) {
        return new Response(JSON.stringify({ error: "Invalid schedule request." }), {
          status: 400,
          headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" }
        });
      }

      try {
        const airport = await getAirport(normalizedIcao);
        if (!airport) {
          return new Response(JSON.stringify({ error: "Airport not found." }), {
            status: 404,
            headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" }
          });
        }
        const flights = await getSchedule(airport, type, env.OPENSKY_USERNAME, env.OPENSKY_PASSWORD);
        return new Response(JSON.stringify({ flights }), {
          status: 200,
          headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 502,
          headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" }
        });
      }
    }

    // Proxy tiles
    if (pathname.startsWith("/tiles/")) {
      const tileCache = caches.default;
      const cachedTile = await tileCache.match(request);
      if (cachedTile) return cachedTile;

      const parts = pathname.split("/");
      const z = parts[2];
      const x = parts[3];
      const file = parts[4];
      
      if (file && file.endsWith(".png")) {
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
                "Referer": request.headers.get("Referer") || new URL("/", request.url).href
              }
            });

            if (!response.ok) {
              return new Response("Unable to load tile", { status: 502 });
            }

            const tileResponse = new Response(response.body, {
              status: 200,
              headers: {
                "Content-Type": "image/png",
                "Cache-Control": response.headers.get("Cache-Control") || "public, max-age=3600"
              }
            });
            ctx.waitUntil(tileCache.put(request, tileResponse.clone()));
            return tileResponse;
          } catch (err) {
            return new Response("Tile proxy error", { status: 502 });
          }
        }
      }
    }

    // Serve static files from assets - be explicit about file types
    const hasExtension = /\.[a-zA-Z0-9]+$/.test(pathname);
    if (pathname === "/" || pathname === "/index.html" || hasExtension) {
      try {
        return await env.ASSETS.fetch(request);
      } catch (err) {
        // If assets fail, serve index for root
        if (pathname === "/" || pathname === "/index.html") {
          try {
            return await env.ASSETS.fetch(new Request(new URL("/index.html", request.url).toString()));
          } catch (e) {
            return new Response("Not found", { status: 404 });
          }
        }
        return new Response("Not found", { status: 404 });
      }
    }

    // Default to index.html for SPA routing
    try {
      return await env.ASSETS.fetch(new Request(new URL("/index.html", request.url).toString()));
    } catch (err) {
      return new Response("Not found", { status: 404 });
    }
  }
};
