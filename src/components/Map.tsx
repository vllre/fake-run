"use client"

import { useEffect, useRef, useState, useCallback } from 'react'
import * as maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'

// Suppress MapLibre GL's internal AbortErrors at module load time so they
// never reach the Next.js dev-overlay. Must run before any other listener.
if (typeof window !== 'undefined') {
  window.addEventListener(
    'unhandledrejection',
    (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      if (
        reason &&
        (reason.name === 'AbortError' ||
          (typeof reason.message === 'string' &&
            (reason.message.includes('aborted') ||
              reason.message.includes('signal is aborted'))))
      ) {
        event.stopImmediatePropagation();
        event.preventDefault();
      }
    },
    true, // capture phase — runs before Next.js listeners
  );
}

interface MapProps {
  onRouteUpdate?: (coordinates: number[][], stats: RouteStats) => void;
  searchQuery?: string;
  onSearchQueryChange?: (query: string) => void;
  onSearchSelect?: (result: SearchResult) => void;
  gpsRealism?: string;
}

interface SearchResult {
  center: [number, number];
  place_name: string;
}

interface NominatimSearchResult {
  lat: string;
  lon: string;
  display_name: string;
}

interface RouteStats {
  distance: number;
  duration: number;
  elevationGain: number;
}

type Coordinate = [number, number]

export default function Map({ 
  onRouteUpdate, 
  searchQuery = "", 
  onSearchQueryChange,
  onSearchSelect,
  gpsRealism = "natural"
}: MapProps) {
  const mapContainer = useRef<HTMLDivElement>(null)
  const map = useRef<maplibregl.Map | null>(null)
  const [coordinates, setCoordinates] = useState<Coordinate[]>([])
  // markersRef stores { marker, coord } so we can remove by index
  const markersRef = useRef<{ marker: maplibregl.Marker; coord: Coordinate }[]>([])
  // Stores clean OSRM-aligned coords (without drift) so we can re-apply drift reactively
  const rawAlignedCoordsRef = useRef<Coordinate[] | null>(null)
  const [mapLoaded, setMapLoaded] = useState(false)
  const [showAlignButton, setShowAlignButton] = useState(false)
  const [isAligning, setIsAligning] = useState(false)
  const [isAligned, setIsAligned] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [isSearching, setIsSearching] = useState(false)

  // Handle search input changes with OpenStreetMap Nominatim
  useEffect(() => {
    const searchLocation = async () => {
      if (!searchQuery) {
        setSearchResults([])
        return
      }

      setIsSearching(true)
      try {
        const response = await fetch(
          `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(searchQuery)}&limit=5`
        )
        if (!response.ok) {
          throw new Error('Search failed')
        }
        
        const data: NominatimSearchResult[] = await response.json()
        
        if (Array.isArray(data) && data.length > 0) {
          const results: SearchResult[] = data.map((item) => ({
            center: [parseFloat(item.lon), parseFloat(item.lat)],
            place_name: item.display_name,
          }))
          setSearchResults(results)
          setError(null)
        } else {
          setSearchResults([])
          setError('No results found')
        }
      } catch (err) {
        console.error('Search error:', err)
        setError('Failed to search location')
      } finally {
        setIsSearching(false)
      }
    }

    if (searchQuery.length >= 2) {
      const debounceTimer = setTimeout(searchLocation, 300)
      return () => clearTimeout(debounceTimer)
    } else {
      setSearchResults([])
    }
  }, [searchQuery])

  // Reactively re-apply GPS drift when the realism setting changes (no re-click needed)
  useEffect(() => {
    if (!rawAlignedCoordsRef.current || !map.current) return;
    const raw = rawAlignedCoordsRef.current;
    const driftAmount = gpsRealism === "high" ? 7.0 : gpsRealism === "natural" ? 4.0 : 0;
    const finalCoords = driftAmount > 0 ? applyGpsDrift(raw, driftAmount) : raw;
    coordinatesRef.current = finalCoords;
    setCoordinates(finalCoords);
    updateRouteLine(finalCoords);
    calculateRouteStats(finalCoords).then(stats => {
      onRouteUpdate?.(finalCoords, stats);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gpsRealism])


  // Handle input change
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onSearchQueryChange?.(e.target.value)
  }

  const handleSearchSelect = (result: SearchResult) => {
    if (!map.current) return
    const [lng, lat] = result.center
    map.current.flyTo({ center: [lng, lat], zoom: 14 })
    onSearchSelect?.(result)
    setSearchResults([])
  }

  // Calculate route statistics
  const calculateRouteStats = async (coords: Coordinate[]): Promise<RouteStats> => {
    let distance = 0;
    let elevationGain = 0;

    for (let i = 1; i < coords.length; i++) {
      const [lon1, lat1] = coords[i - 1];
      const [lon2, lat2] = coords[i];
      const R = 6371;
      const dLat = (lat2 - lat1) * Math.PI / 180;
      const dLon = (lon2 - lon1) * Math.PI / 180;
      const a =
        Math.sin(dLat/2) * Math.sin(dLat/2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon/2) * Math.sin(dLon/2);
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
      distance += R * c;
    }

    elevationGain = Math.round(distance * 25);
    const baseDuration = distance * 5.5;
    const elevationTime = elevationGain / 60;
    const turns = coords.length - 1;
    const turnsTime = (turns * 5) / 60;
    const duration = baseDuration + elevationTime + turnsTime;

    return { distance, duration, elevationGain };
  }

  // Update the map route line — declared as function so it is hoisted (safe to call from earlier useEffect)
  function updateRouteLine(coords: Coordinate[]) {
    const source = map.current?.getSource('route') as maplibregl.GeoJSONSource
    if (source) {
      source.setData({
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: coords },
      })
    }
  }

  // Add a single deletable marker at a coordinate
  const addMarker = useCallback((coord: Coordinate, index: number, coordsRef: React.MutableRefObject<Coordinate[]>) => {
    if (!map.current) return null

    // Fixed-size container — dimensions must NEVER change on hover to avoid MapLibre anchor drift.
    const el = document.createElement('div')
    el.style.cssText = `
      width: 24px; height: 24px; border-radius: 50%;
      background: #ff4400; border: 2.5px solid white;
      box-shadow: 0 2px 6px rgba(0,0,0,0.4);
      cursor: pointer; position: relative;
      transition: background 0.15s, box-shadow 0.15s;
    `
    el.title = 'Click to delete this point'

    // Badge "×" — absolutely positioned so it NEVER affects parent layout/size.
    // Uses opacity (not display:none) to avoid reflow that shifts the marker.
    const badge = document.createElement('span')
    badge.textContent = '×'
    badge.style.cssText = `
      position: absolute; top: 50%; left: 50%;
      transform: translate(-50%, -50%);
      color: white; font-size: 13px; font-weight: bold;
      line-height: 1; opacity: 0; pointer-events: none;
      user-select: none; transition: opacity 0.15s;
    `
    el.appendChild(badge)

    el.addEventListener('mouseenter', () => {
      el.style.background = '#cc0000'
      el.style.boxShadow = '0 3px 10px rgba(0,0,0,0.5)'
      badge.style.opacity = '1'
    })
    el.addEventListener('mouseleave', () => {
      el.style.background = '#ff4400'
      el.style.boxShadow = '0 2px 6px rgba(0,0,0,0.4)'
      badge.style.opacity = '0'
    })

    const marker = new maplibregl.Marker({ element: el })
      .setLngLat(coord)
      .addTo(map.current)

    // Click on marker → delete this point
    el.addEventListener('click', (e) => {
      e.stopPropagation() // prevent map click from adding a new point
      deletePointByMarker(marker, coordsRef)
    })

    return marker
  }, []) // eslint-disable-line react-hooks/exhaustive-deps


  // Delete a specific point by its marker reference
  const deletePointByMarker = (
    markerToDelete: maplibregl.Marker,
    coordsRef: React.MutableRefObject<Coordinate[]>
  ) => {
    const idx = markersRef.current.findIndex(m => m.marker === markerToDelete)
    if (idx === -1) return

    // Remove marker from map and from ref
    markersRef.current[idx].marker.remove()
    markersRef.current.splice(idx, 1)

    // Remove coordinate at same index
    const newCoords = coordsRef.current.filter((_, i) => i !== idx)
    coordsRef.current = newCoords
    setCoordinates(newCoords)
    updateRouteLine(newCoords)

    if (newCoords.length < 2) setShowAlignButton(false)

    calculateRouteStats(newCoords).then(stats => {
      onRouteUpdate?.(newCoords, stats)
    })
  }

  // Keep a stable ref to coordinates so marker click handlers can read latest value
  const coordinatesRef = useRef<Coordinate[]>([])
  useEffect(() => {
    coordinatesRef.current = coordinates
  }, [coordinates])

  // Initialize map
  useEffect(() => {
    if (!mapContainer.current || map.current) return

    const mapInstance = new maplibregl.Map({
      container: mapContainer.current,
      style: 'https://tiles.openfreemap.org/styles/liberty',
      center: [2.3522, 48.8566],
      zoom: 13,
    })

    mapInstance.on('load', () => {
      mapInstance.addSource('route', {
        type: 'geojson',
        data: {
          type: 'Feature',
          properties: {},
          geometry: { type: 'LineString', coordinates: [] },
        },
      })

      mapInstance.addLayer({
        id: 'route',
        type: 'line',
        source: 'route',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': '#ff4400', 'line-width': 4 },
      })

      map.current = mapInstance
      setMapLoaded(true)
    })

    return () => {
      try {
        mapInstance.remove()
      } catch (error: unknown) {
        if (
          !(error instanceof DOMException && error.name === 'AbortError') &&
          !(error instanceof Error && error.message?.includes('aborted'))
        ) {
          console.warn('Unexpected error removing map instance:', error)
        }
      }
      map.current = null
      setMapLoaded(false)
    }
  }, [])

  // Handle map clicks and route drawing
  useEffect(() => {
    if (!map.current || !mapLoaded) return

    const handleClick = async (e: maplibregl.MapMouseEvent) => {
      setSearchResults([])
      onSearchQueryChange?.("")

      const newCoord: Coordinate = [e.lngLat.lng, e.lngLat.lat]
      const newCoords = [...coordinatesRef.current, newCoord]
      coordinatesRef.current = newCoords
      setCoordinates(newCoords)

      try {
        const stats = await calculateRouteStats(newCoords)
        if (!map.current) return
        onRouteUpdate?.(newCoords, stats)
        updateRouteLine(newCoords)

        const marker = addMarker(newCoord, newCoords.length - 1, coordinatesRef)
        if (marker) {
          markersRef.current.push({ marker, coord: newCoord })
        }

        if (newCoords.length >= 2) setShowAlignButton(true)
        setError(null)
      } catch (error) {
        console.error('Error calculating route stats:', error)
        setError('Failed to calculate route statistics')
      }
    }

    map.current.on('click', handleClick)
    return () => {
      if (map.current) map.current.off('click', handleClick)
    }
  }, [mapLoaded, onRouteUpdate, onSearchQueryChange, addMarker])

  // Undo: remove the last point
  const undoLastPoint = () => {
    if (markersRef.current.length === 0) return

    const last = markersRef.current.pop()!
    last.marker.remove()

    const newCoords = coordinatesRef.current.slice(0, -1)
    coordinatesRef.current = newCoords
    setCoordinates(newCoords)
    setIsAligned(false)
    updateRouteLine(newCoords)

    if (newCoords.length < 2) setShowAlignButton(false)
    calculateRouteStats(newCoords).then(stats => {
      onRouteUpdate?.(newCoords, stats)
    })
  }

  // Reset all points
  const resetPoints = () => {
    markersRef.current.forEach(m => m.marker.remove())
    markersRef.current = []
    coordinatesRef.current = []
    setCoordinates([])
    setShowAlignButton(false)
    setIsAligned(false)
    updateRouteLine([])
    onRouteUpdate?.([], { distance: 0, duration: 0, elevationGain: 0 })
  }

  // Road alignment using OSRM Route API (treats user points as waypoints)
  // Falls back to Match API if route fails, with segment-by-segment fallback for long routes
  const alignToRoads = async () => {
    if (coordinates.length < 2) return
    setIsAligning(true)
    setError(null)

    // Use smaller snap radius (25m) to avoid snapping to wrong roads in dense areas
    const radiuses = coordinates.map(() => '25').join(';')

    try {
      let alignedCoords: Coordinate[] | null = null

      // --- Strategy 1: OSRM Route API (segment-by-segment for accuracy) ---
      // Route each consecutive pair of points independently, then stitch.
      // This ensures the path goes through the user's clicked points without
      // OSRM rerouting through shortcuts between far-apart waypoints.
      if (coordinates.length >= 2) {
        const segments: Coordinate[][] = []
        let segmentFailed = false

        for (let i = 0; i < coordinates.length - 1; i++) {
          const segCoordStr = `${coordinates[i].join(',')};${coordinates[i + 1].join(',')}`
          const segUrl =
            `https://router.project-osrm.org/route/v1/foot/${segCoordStr}` +
            `?overview=full&geometries=geojson`
          try {
            const res = await fetch(segUrl)
            if (!res.ok) { segmentFailed = true; break }
            const data = await res.json()
            if (!data.routes?.[0]) { segmentFailed = true; break }
            const segCoords = data.routes[0].geometry.coordinates as Coordinate[]
            // Avoid duplicating the shared point between segments
            if (i === 0) {
              segments.push(segCoords)
            } else {
              segments.push(segCoords.slice(1))
            }
          } catch {
            segmentFailed = true
            break
          }
        }

        if (!segmentFailed && segments.length > 0) {
          alignedCoords = segments.flat() as Coordinate[]
        }
      }

      // --- Strategy 2: Full-route OSRM Route API (all waypoints at once) ---
      if (!alignedCoords) {
        const coordStr = coordinates.map(c => c.join(',')).join(';')
        const routeUrl =
          `https://router.project-osrm.org/route/v1/foot/${coordStr}` +
          `?overview=full&geometries=geojson`
        const routeRes = await fetch(routeUrl)
        if (routeRes.ok) {
          const routeData = await routeRes.json()
          if (routeData.routes?.[0]) {
            alignedCoords = routeData.routes[0].geometry.coordinates as Coordinate[]
          }
        }
      }

      // --- Strategy 3: OSRM Match API (last resort — designed for GPS traces) ---
      if (!alignedCoords) {
        const coordStr = coordinates.map(c => c.join(',')).join(';')
        const matchUrl =
          `https://router.project-osrm.org/match/v1/walking/${coordStr}` +
          `?overview=full&geometries=geojson&tidy=true&radiuses=${radiuses}`
        const matchRes = await fetch(matchUrl)
        if (matchRes.ok) {
          const matchData = await matchRes.json()
          if (matchData.matchings?.[0]) {
            alignedCoords = matchData.matchings[0].geometry.coordinates as Coordinate[]
          }
        }
      }

      if (!alignedCoords) throw new Error('All alignment strategies failed')
      if (!map.current) return

      // Save clean OSRM coords (no drift yet) so useEffect can re-apply reactively
      const interpolatedClean = interpolateRoutePoints(alignedCoords, 10)
      rawAlignedCoordsRef.current = interpolatedClean

      // Apply GPS drift based on current realism setting
      const driftAmount = gpsRealism === "high" ? 7.0 : gpsRealism === "natural" ? 4.0 : 0
      const finalCoords = driftAmount > 0 ? applyGpsDrift(interpolatedClean, driftAmount) : interpolatedClean

      // Update route line with full aligned path (including realistic coretan GPS drift)
      coordinatesRef.current = finalCoords
      setCoordinates(finalCoords)
      updateRouteLine(finalCoords)

      // After alignment: remove ALL markers — the route line is sufficient.
      markersRef.current.forEach(m => m.marker.remove())
      markersRef.current = []
      setIsAligned(true)

      const stats = await calculateRouteStats(finalCoords)
      onRouteUpdate?.(finalCoords, stats)
    } catch (err) {
      console.error('Error aligning to roads:', err)
      setError('Gagal align ke jalan. Coba tambah titik lebih dekat ke jalan yang dituju.')
    } finally {
      setIsAligning(false)
    }
  }

  // Helper to interpolate points every ~10 meters between coordinates
  function interpolateRoutePoints(coords: Coordinate[], targetSpacing = 10): Coordinate[] {
    if (coords.length < 2) return coords;
    const toRad = (deg: number) => deg * Math.PI / 180;
    const R = 6371000;
    const result: Coordinate[] = [];
    for (let i = 0; i < coords.length - 1; i++) {
      const [lon1, lat1] = coords[i];
      const [lon2, lat2] = coords[i + 1];
      const dLat = toRad(lat2 - lat1);
      const dLon = toRad(lon2 - lon1);
      const a = Math.sin(dLat/2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2) ** 2;
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      const dist = R * c;
      const numPoints = Math.max(1, Math.round(dist / targetSpacing));
      for (let j = 0; j < numPoints; j++) {
        const frac = j / numPoints;
        const lat = lat1 + (lat2 - lat1) * frac;
        const lon = lon1 + (lon2 - lon1) * frac;
        result.push([lon, lat]);
      }
    }
    result.push(coords[coords.length - 1]);
    return result;
  }

  // Helper to add natural GPS drift / jitter (coretan GPS) for realistic watch tracking
  function applyGpsDrift(coords: Coordinate[], driftMeters = 1.8): Coordinate[] {
    if (coords.length < 3 || driftMeters <= 0) return coords;
    const n = coords.length;
    const R = 6371000;

    const seed = coords.reduce((acc, c) => acc + c[0] + c[1], 0);
    const pseudoRand = (i: number) => {
      const x = Math.sin(seed + i * 12.9898) * 43758.5453;
      return x - Math.floor(x);
    };

    return coords.map(([lon, lat], i) => {
      if (i === 0 || i === n - 1) return [lon, lat];

      const prev = coords[i - 1];
      const next = coords[i + 1];
      const dLat = (next[1] - prev[1]) * (Math.PI / 180);
      const dLon = (next[0] - prev[0]) * (Math.PI / 180) * Math.cos(lat * Math.PI / 180);

      const len = Math.sqrt(dLat * dLat + dLon * dLon);
      if (len === 0) return [lon, lat];

      const perpLat = -dLon / len;
      const perpLon = dLat / len;

      const phase1 = Math.sin(i * 0.25 + seed % 10) * 0.7;
      const phase2 = Math.sin(i * 0.08 + seed % 7) * 0.3;
      const jitter = (pseudoRand(i) - 0.5) * 0.3;

      const edgeFade = Math.min(1, i / 5, (n - 1 - i) / 5);
      const totalDriftMeters = (phase1 + phase2 + jitter) * driftMeters * edgeFade;

      const latOffset = (totalDriftMeters * perpLat) / (R * (Math.PI / 180));
      const lonOffset = (totalDriftMeters * perpLon) / (R * (Math.PI / 180) * Math.cos(lat * Math.PI / 180));

      return [lon + lonOffset, lat + latOffset];
    });
  }

  return (
    <div className="relative">
      <div className="relative mb-4">
        <div className="relative">
          <input
            type="text"
            value={searchQuery}
            onChange={handleInputChange}
            placeholder="Search for a location..."
            className="w-full px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500 focus:border-transparent text-black"
            autoComplete="off"
          />
          {isSearching && (
            <div className="absolute right-3 top-1/2 transform -translate-y-1/2">
              <div className="animate-spin h-5 w-5 border-2 border-orange-500 rounded-full border-t-transparent"></div>
            </div>
          )}
        </div>
        {searchResults.length > 0 && (
          <ul className="absolute z-10 w-full bg-white border rounded-lg mt-1 max-h-60 overflow-y-auto shadow-lg text-black">
            {searchResults.map((result, idx) => (
              <li
                key={idx}
                className="px-4 py-2 hover:bg-gray-100 cursor-pointer text-sm border-b last:border-b-0"
                onClick={() => handleSearchSelect(result)}
              >
                {result.place_name}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div ref={mapContainer} className="h-[600px] w-full rounded-lg shadow-inner overflow-hidden" />

      {/* Hint text */}
      {coordinates.length === 0 && (
        <p className="absolute bottom-16 left-0 right-0 text-center text-xs text-gray-400 z-10 pointer-events-none">
          Click on the map to add route points • Hover a marker and click to delete it
        </p>
      )}

      {/* Action buttons */}
      {(showAlignButton || coordinates.length > 0) && (
        <div className="absolute bottom-4 left-4 flex gap-2 z-10">
          {showAlignButton && (
            <button
              onClick={alignToRoads}
              disabled={isAligning}
              className="bg-orange-500 text-white px-5 py-2.5 rounded-lg shadow-lg hover:bg-orange-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed font-medium text-sm"
            >
              {isAligning ? (
                <span className="flex items-center gap-2">
                  <span className="animate-spin inline-block w-4 h-4 border-2 border-white rounded-full border-t-transparent" />
                  Aligning...
                </span>
              ) : (
                '🛣️ Align to Roads'
              )}
            </button>
          )}

          {/* Undo last point — hidden after alignment since coords are road-interpolated */}
          {coordinates.length > 0 && !isAligned && (
            <button
              onClick={undoLastPoint}
              disabled={isAligning}
              className="bg-white px-4 py-2.5 rounded-lg shadow-lg hover:bg-gray-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed font-medium text-sm text-gray-700 flex items-center gap-1"
            >
              ↩ Undo
            </button>
          )}

          {/* Reset all */}
          {coordinates.length > 0 && (
            <button
              onClick={resetPoints}
              disabled={isAligning}
              className="bg-white px-4 py-2.5 rounded-lg shadow-lg hover:bg-red-50 hover:text-red-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed font-medium text-sm text-gray-700"
            >
              🗑 Reset All
            </button>
          )}
        </div>
      )}

      {error && (
        <div className="absolute bottom-20 left-4 right-4 bg-red-50 border border-red-200 text-red-600 px-4 py-3 rounded-lg z-10 text-sm">
          {error}
        </div>
      )}
    </div>
  )
}
