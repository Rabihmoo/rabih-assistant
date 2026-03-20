const axios = require('axios');

// Default location: Maputo, Mozambique
var MAPUTO_LOCATION = '-25.9692,32.5732';

async function searchPlaces(query, near) {
  var key = process.env.GOOGLE_MAPS_KEY;
  if (!key) return { error: 'GOOGLE_MAPS_KEY not configured. Add it to Railway env vars.' };

  try {
    var url = 'https://maps.googleapis.com/maps/api/place/textsearch/json';
    var params = {
      query: query,
      key: key,
      location: near || MAPUTO_LOCATION,
      radius: 15000
    };
    var res = await axios.get(url, { params: params, timeout: 10000 });
    var places = (res.data.results || []).slice(0, 8);
    return {
      count: places.length,
      places: places.map(function(p) {
        return {
          name: p.name,
          address: p.formatted_address,
          rating: p.rating || 'N/A',
          open_now: p.opening_hours ? p.opening_hours.open_now : 'unknown',
          location: p.geometry && p.geometry.location
        };
      })
    };
  } catch (err) {
    return { error: 'Places search failed: ' + err.message };
  }
}

async function getDirections(origin, destination, mode) {
  var key = process.env.GOOGLE_MAPS_KEY;
  if (!key) return { error: 'GOOGLE_MAPS_KEY not configured. Add it to Railway env vars.' };

  try {
    var url = 'https://maps.googleapis.com/maps/api/directions/json';
    var params = {
      origin: origin,
      destination: destination,
      mode: mode || 'driving',
      departure_time: 'now',
      key: key
    };
    var res = await axios.get(url, { params: params, timeout: 10000 });
    if (!res.data.routes || res.data.routes.length === 0) return { error: 'No route found from ' + origin + ' to ' + destination };
    var route = res.data.routes[0];
    var leg = route.legs[0];
    return {
      origin: leg.start_address,
      destination: leg.end_address,
      distance: leg.distance.text,
      duration: leg.duration.text,
      duration_in_traffic: leg.duration_in_traffic ? leg.duration_in_traffic.text : leg.duration.text,
      steps: leg.steps.slice(0, 5).map(function(s) {
        return s.html_instructions.replace(/<[^>]+>/g, '') + ' (' + s.distance.text + ')';
      })
    };
  } catch (err) {
    return { error: 'Directions failed: ' + err.message };
  }
}

var locationTools = [
  {
    name: 'search_places',
    description: 'Search for nearby places, businesses, restaurants, stores using Google Maps. Use when Rabih asks "where is", "nearest", "find a place".',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for, e.g. "hardware store", "pharmacy", "restaurant"' },
        near: { type: 'string', description: 'Location to search near. Default is Maputo. Format: "lat,lng" or address.' }
      },
      required: ['query']
    }
  },
  {
    name: 'get_directions',
    description: 'Get driving directions and traffic info between two locations. Use when Rabih asks about traffic, how to get somewhere, distance.',
    input_schema: {
      type: 'object',
      properties: {
        origin: { type: 'string', description: 'Starting point — address or place name' },
        destination: { type: 'string', description: 'Destination — address or place name' },
        mode: { type: 'string', description: 'Travel mode: driving (default), walking, transit' }
      },
      required: ['origin', 'destination']
    }
  }
];

async function handleLocationTool(toolName, toolInput) {
  try {
    switch (toolName) {
      case 'search_places': return await searchPlaces(toolInput.query, toolInput.near);
      case 'get_directions': return await getDirections(toolInput.origin, toolInput.destination, toolInput.mode);
      default: return { error: 'Unknown location tool: ' + toolName };
    }
  } catch (err) {
    console.error('Location tool error:', err.message);
    return { error: err.message };
  }
}

module.exports = { locationTools: locationTools, handleLocationTool: handleLocationTool };
