const AIRPORTS_CSV = "https://davidmegginson.github.io/ourairports-data/airports.csv";
const METAR_API = "https://aviationweather.gov/api/data/metar";
const TILE_SERVER = "https://tile.openstreetmap.org";
const MAX_TILE_ZOOM = 19;

let airportCache = null;

function cleanIcao(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);
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

async function getMetar(icao) {
  const url = `${METAR_API}?ids=${encodeURIComponent(icao)}&format=decoded`;
  const response = await fetch(url);
  
  if (!response.ok) throw new Error("Could not load METAR.");

  const decoded = await response.text();
  const rawMatch = decoded.match(/Text:\s*(.+)/);
  return {
    raw: rawMatch ? rawMatch[1].trim() : decoded.trim(),
    decoded: decoded.trim()
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // API: Get airport info
    if (pathname.startsWith("/api/airport/")) {
      const icao = cleanIcao(pathname.split("/").pop());

      try {
        const airport = await getAirport(icao);
        if (!airport) {
          return new Response(JSON.stringify({ error: `No airport found for ${icao}` }), {
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

    // Proxy tiles
    if (pathname.startsWith("/tiles/")) {
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
                "User-Agent": "flightweather"
              }
            });

            if (!response.ok) {
              return new Response("Unable to load tile", { status: 502 });
            }

            return new Response(response.body, {
              status: 200,
              headers: {
                "Content-Type": "image/png",
                "Cache-Control": "public, max-age=3600"
              }
            });
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
