// ⛔ DEPRECATED 2026-07-16 — DO NOT RUN. Defines dead endpoints (stableenrich /api/apollo/* = 404) + mints colliding duplicate ids vs shipped; 7/8 ADD targets no longer exist. The live work it did is already in the registry. Add new services by editing curation/<subcat>.json + curate.mjs (see the safe procedure in MASTERKEY_HANDOFF.md).
// Kept for reference only. See MASTERKEY_HANDOFF.md (registry drift fix) + scripts/registry/verify-drift.mjs.
console.error("⛔ add-stable-family.mjs is DEPRECATED and disabled (it caused/enabled registry drift). See MASTERKEY_HANDOFF.md.");
process.exit(1);

/* ----- original source below (never executes) -----
/**
 * add-stable-family.mjs — index the full Stable* product-family route surface into the registry
 * from the authoritative provider docs.
 *
 * Adds every documented endpoint as a manual backend object {url, method, amount, status} on the
 * matching curation entry (idempotent: skips URLs already present), and creates new dedicated entries
 * for capability clusters that don't have a home yet (Exa, Minerva, Clado, Whitepages, Reddit,
 * Cloudflare crawl, Seats.aero, Google Flights, Reference data, Activities, Transfers, Merch, etc.).
 * Each entry carries a usage block (auth/flow/price/guide) derived from the provider doc; live
 * pay-test then enriches the tested ones via the QA workflow.
 *
 * Auth legend per backend.note: "paid"=x402, "siwx"=free wallet-proof, "irreversible"=ships goods /
 * moves money / durable purchase (DEFER), "needs-parent"=requires an owned resource first,
 * "needs-id"=path param from a prior call, "over-cap"=>$10.
 *
 * Usage: node scripts/registry/add-stable-family.mjs   (then curate the printed subcats + build-checklist)
 */

import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = process.cwd();
const CUR = path.join(ROOT, "scripts/registry/curation");

// usage-block helper
const U = (callShape, priceText, inputExample, opts = {}) => ({
  status: "untested",
  verifiedAt: "2026-06-09",
  resultPull: opts.resultPull || "sync",
  auth: opts.auth || "none",
  callShape,
  inputExample: inputExample || {},
  outputShape: opts.outputShape || "JSON body (see provider doc).",
  quirks: opts.quirks || [],
  needs: opts.needs || [],
  needsApproval: !!opts.needsApproval,
  guide: opts.guide || callShape,
  costObservedUsd: 0,
  priceText,
});

// backend object factory
const B = (url, method, amount, note) => ({ url, method, amount, status: "active", note });

// ----- additions to EXISTING entries: [subcatFile, entryNameOrId, backends[], usageIfEmpty?] -----
const ADD = [
  // ===== StableEnrich: Google Maps (extend) =====
  ["maps-geolocation.json", "Google Maps (StableEnrich)", [
    B("https://stableenrich.dev/api/google-maps/text-search/full", "POST", 0.08, "paid"),
    B("https://stableenrich.dev/api/google-maps/text-search/partial", "POST", 0.02, "paid"),
    B("https://stableenrich.dev/api/google-maps/solar/building-insights", "GET", 0.02, "paid"),
    B("https://stableenrich.dev/api/google-maps/solar/data-layers", "GET", 0.08, "paid"),
    B("https://stableenrich.dev/api/google-maps/aerial-view/lookup-video", "GET", 0.01, "paid"),
    B("https://stableenrich.dev/api/google-maps/aerial-view/render-video", "POST", 0.01, "paid"),
  ]],
  // ===== StableEnrich: Apollo (extend) =====
  ["company-people-data.json", "Apollo.io", [
    B("https://stableenrich.dev/api/apollo/org-search", "POST", 0.02, "paid"),
    B("https://stableenrich.dev/api/apollo/org-enrich", "POST", 0.0495, "paid"),
  ]],
  // ===== StableEnrich: Serper (extend) =====
  ["serp-seo-apis.json", "Serper", [
    B("https://stableenrich.dev/api/serper/shopping", "POST", 0.04, "paid"),
    B("https://stableenrich.dev/api/serper/images", "POST", 0.04, "paid"),
    B("https://stableenrich.dev/api/serper/people-image-search", "POST", 0.04, "paid"),
    B("https://stableenrich.dev/api/serper/lens", "POST", 0.20, "paid"),
  ]],
  // ===== StableTravel: Flight Data (extend with amadeus + flightaware reads) =====
  ["flight-aviation.json", "StableTravel Flight Data", [
    // Amadeus flights
    B("https://stabletravel.dev/api/flights/seatmap", "GET", 0.03, "paid"),
    B("https://stabletravel.dev/api/flights/upsell", "POST", 0.03, "needs-id"),
    B("https://stabletravel.dev/api/flights/availability", "POST", 0.03, "paid"),
    B("https://stabletravel.dev/api/flights/checkin-links", "GET", 0.005, "paid"),
    B("https://stabletravel.dev/api/flights/orders/cancel", "POST", 0.005, "needs-id"),
    // FlightAware flights
    B("https://stabletravel.dev/api/flightaware/flights/search/positions", "GET", 0.10, "paid"),
    B("https://stabletravel.dev/api/flightaware/flights/search/count", "GET", 0.04, "paid"),
    B("https://stabletravel.dev/api/flightaware/flights/search/advanced", "GET", 0.10, "paid"),
    // FlightAware airports
    B("https://stabletravel.dev/api/flightaware/airports", "GET", 0.01, "paid"),
    B("https://stabletravel.dev/api/flightaware/airports/nearby", "GET", 0.008, "paid"),
    B("https://stabletravel.dev/api/flightaware/airports/delays", "GET", 0.10, "paid"),
    B("https://stabletravel.dev/api/flightaware/airports/KJFK/delays", "GET", 0.02, "paid"),
    B("https://stabletravel.dev/api/flightaware/airports/KJFK/weather/observations", "GET", 0.004, "paid"),
    B("https://stabletravel.dev/api/flightaware/airports/KJFK/weather/forecast", "GET", 0.004, "paid"),
    B("https://stabletravel.dev/api/flightaware/airports/KJFK/flights/scheduled-departures", "GET", 0.01, "paid"),
    B("https://stabletravel.dev/api/flightaware/airports/KJFK/flights/scheduled-arrivals", "GET", 0.01, "paid"),
    // FlightAware disruption
    B("https://stabletravel.dev/api/flightaware/disruption-counts/airline", "GET", 0.01, "paid"),
  ]],
  // ===== StableTravel: Hotels & Booking (extend) =====
  ["scheduling-booking.json", "StableTravel Hotels & Booking", [
    B("https://stabletravel.dev/api/hotels/list/by-geocode", "GET", 0.03, "paid"),
    B("https://stabletravel.dev/api/hotels/autocomplete", "GET", 0.005, "paid"),
    B("https://stabletravel.dev/api/hotels/ratings", "GET", 0.05, "paid"),
    B("https://stabletravel.dev/api/hotels/book", "POST", 0.002, "irreversible"),
  ]],
  // ===== StableEmail (extend the single StableEmail entry) =====
  ["email.json", "StableEmail", [
    B("https://stableemail.dev/api/send", "POST", 0.02, "paid-outward"),
    B("https://stableemail.dev/api/subdomain/buy", "POST", 5.0, "irreversible"),
    B("https://stableemail.dev/api/subdomain/inbox/create", "POST", 0.25, "needs-parent"),
    B("https://stableemail.dev/api/subdomain/inbox/messages", "POST", 0.001, "needs-parent"),
    B("https://stableemail.dev/api/subdomain/inbox/messages/read", "POST", 0.001, "needs-parent"),
    B("https://stableemail.dev/api/inbox/buy", "POST", 1.0, "irreversible"),
    B("https://stableemail.dev/api/inbox/topup", "POST", 1.0, "needs-parent"),
    B("https://stableemail.dev/api/inbox/topup/quarter", "POST", 2.5, "needs-parent"),
    B("https://stableemail.dev/api/inbox/topup/year", "POST", 8.0, "needs-parent"),
    B("https://stableemail.dev/api/inbox/send", "POST", 0.005, "needs-parent"),
    B("https://stableemail.dev/api/inbox/messages", "POST", 0.001, "needs-parent"),
    B("https://stableemail.dev/api/inbox/messages/read", "POST", 0.001, "needs-parent"),
  ]],
  // ===== StablePhone: number provisioning (extend) =====
  ["sms-phone.json", "Phone Number Provisioning", [
    B("https://stablephone.dev/api/number/topup", "POST", 15.0, "over-cap-needs-parent"),
  ]],
  // ===== StableUpload (extend the single entry with site + bigger tiers) =====
  ["object-file-storage.json", "StableUpload", [
    B("https://stableupload.dev/api/site", "POST", 0.20, "paid-multistep"),
    B("https://stableupload.dev/api/site/renew", "POST", 0.20, "needs-parent"),
  ]],
];

// ----- NEW entries: [subcatFile, entryObject] -----
const mkEntry = (id, name, provider, providerId, subcatDesc, tags, backends, usage) => ({
  id, name, kind: "api", provider, providerId,
  description: subcatDesc, tags,
  modality: { input: ["text"], output: ["json"] },
  backends, usage, status: "active",
});

const NEW = [
  // ===== StableEnrich: Exa =====
  ["web-search-apis.json", mkEntry("exa-stableenrich", "Exa (StableEnrich)", "StableEnrich", "stableenrich",
    "Exa semantic web search, find-similar, content extraction, and AI answer — pay-per-call x402 (USDC on Base/Solana/Tempo), no API key.",
    ["web-search", "semantic-search", "exa", "enrichment", "x402"],
    [
      B("https://stableenrich.dev/api/exa/search", "POST", 0.01, "paid"),
      B("https://stableenrich.dev/api/exa/find-similar", "POST", 0.01, "paid"),
      B("https://stableenrich.dev/api/exa/contents", "POST", 0.002, "paid"),
      B("https://stableenrich.dev/api/exa/answer", "POST", 0.01, "paid"),
    ],
    U("POST https://stableenrich.dev/api/exa/{search|find-similar|contents|answer} with a JSON body (query/url/urls)", "$0.002–$0.01",
      { query: "best practices for building AI agents", numResults: 3 },
      { guide: "Exa via StableEnrich. /search {query,numResults,category?} ($0.01) ranked web results; /find-similar {url,numResults} ($0.01); /contents {urls[]} ($0.002) extract page text; /answer {query} ($0.01) AI answer with citations. Pay x402 (~$0.002–$0.01 USDC on Base). Synchronous JSON." })),
  ],
  // ===== StableEnrich: Minerva =====
  ["company-people-data.json", mkEntry("minerva-stableenrich", "Minerva (StableEnrich)", "StableEnrich", "stableenrich",
    "Minerva consumer identity graph — resolve a person to a Minerva PID + LinkedIn, enrich with demographics/contact/financial signals, validate emails. Pay-per-call x402, no API key.",
    ["identity", "enrichment", "people-data", "minerva", "x402"],
    [
      B("https://stableenrich.dev/api/minerva/resolve", "POST", 0.02, "paid"),
      B("https://stableenrich.dev/api/minerva/enrich", "POST", 0.05, "paid"),
      B("https://stableenrich.dev/api/minerva/validate-emails", "POST", 0.01, "paid"),
    ],
    U("POST https://stableenrich.dev/api/minerva/{resolve|enrich|validate-emails} with a JSON body of records[]", "$0.01–$0.05",
      { records: [{ record_id: "u1", first_name: "John", last_name: "Smith" }] },
      { guide: "Minerva via StableEnrich. /resolve records[] → Minerva PID + LinkedIn ($0.02); /enrich records[] (by pid/linkedin_url/name) → demographics, emails, phones, work, financial signals ($0.05); /validate-emails records[] (array of email strings) pre-screen ($0.01). Pay x402. Synchronous JSON. Use return_fields to trim enrich responses." })),
  ],
  // ===== StableEnrich: Clado =====
  ["company-people-data.json", mkEntry("clado-stableenrich", "Clado Contacts Enrich (StableEnrich)", "StableEnrich", "stableenrich",
    "Clado contact enrichment — get personal email/phone from a LinkedIn URL, email, or phone. Fallback when Apollo lacks personal contacts. Pay-per-call x402.",
    ["contact-enrichment", "email", "phone", "clado", "x402"],
    [B("https://stableenrich.dev/api/clado/contacts-enrich", "POST", 0.20, "paid")],
    U("POST https://stableenrich.dev/api/clado/contacts-enrich with exactly one of {linkedin_url|email|phone}", "$0.20",
      { linkedin_url: "https://www.linkedin.com/in/satyanadella" },
      { guide: "Clado via StableEnrich. POST {linkedin_url} OR {email} OR {phone} (exactly one) → enriched contacts. Pay x402 (~$0.20 USDC on Base). Synchronous JSON." })),
  ],
  // ===== StableEnrich: Whitepages =====
  ["company-people-data.json", mkEntry("whitepages-stableenrich", "Whitepages (StableEnrich)", "StableEnrich", "stableenrich",
    "Whitepages people & property search — find people by name/phone/address, or property ownership/resident details by address. Pay-per-call x402.",
    ["people-search", "property", "whitepages", "x402"],
    [
      B("https://stableenrich.dev/api/whitepages/person-search", "POST", 0.44, "paid"),
      B("https://stableenrich.dev/api/whitepages/property-search", "POST", 0.44, "paid"),
    ],
    U("POST https://stableenrich.dev/api/whitepages/{person-search|property-search}", "$0.44",
      { first_name: "John", last_name: "Smith", state_code: "CA" },
      { quirks: ["Property search uses field name `state_code` (two-letter), NOT `state` — `state` is silently ignored."], guide: "Whitepages via StableEnrich. /person-search {first_name,last_name,state_code?} or by phone/address; /property-search {street,city,state_code}. Pay x402 (~$0.44 USDC on Base). Use `state_code` not `state`." })),
  ],
  // ===== StableEnrich: Reddit =====
  ["social-media-data.json", mkEntry("reddit-stableenrich", "Reddit (StableEnrich)", "StableEnrich", "stableenrich",
    "Reddit search + full post/comments. Two-step: search returns truncated previews; post-comments returns untruncated selftext + all comments. Pay-per-call x402.",
    ["reddit", "social-media", "search", "x402"],
    [
      B("https://stableenrich.dev/api/reddit/search", "POST", 0.02, "paid"),
      B("https://stableenrich.dev/api/reddit/post-comments", "POST", 0.02, "paid"),
    ],
    U("POST https://stableenrich.dev/api/reddit/{search|post-comments}", "$0.02",
      { query: "AI agents", sort: "top", timeframe: "week", maxResults: 5 },
      { guide: "Reddit via StableEnrich. /search {query,sort,timeframe,maxResults} → truncated posts (selftext to 500 chars; selftextTruncated flag); /post-comments {url} → full selftext + comments. Pay x402 ($0.02 each). Synchronous JSON." })),
  ],
  // ===== StableEnrich: Cloudflare Crawl =====
  ["web-crawling.json", mkEntry("cloudflare-crawl-stableenrich", "Cloudflare Crawl (StableEnrich)", "StableEnrich", "stableenrich",
    "Cloudflare Browser Rendering website crawl (JS render optional). Async: POST returns a JWT token; poll the SIWX jobs endpoint (free) until complete. Pay-per-call x402.",
    ["web-crawling", "browser-render", "cloudflare", "x402"],
    [B("https://stableenrich.dev/api/cloudflare/crawl", "POST", 0.10, "paid-async")],
    U("POST https://stableenrich.dev/api/cloudflare/crawl {url,limit,depth,formats} → 202 {token}; poll GET /api/cloudflare/jobs?token=<jwt> (SIWX, free)", "$0.10",
      { url: "https://example.com", limit: 3, depth: 1, formats: ["markdown"] },
      { resultPull: "poll", auth: "siwx-poll", quirks: ["Async: paid POST returns 202 {token}; poll GET /api/cloudflare/jobs?token=<jwt> with SIWX (same wallet, free) every 3–5s. Done when finished+skipped>=total.", "limit max 25, depth max 3; render=true executes JS (slower)."], guide: "Cloudflare crawl via StableEnrich. POST /api/cloudflare/crawl {url,limit<=25,depth<=3,formats,render?} → pays $0.10, returns 202 {token}. Poll GET /api/cloudflare/jobs?token=<jwt> (SIWX free, same wallet) until finished+skipped>=total; read result.records[].markdown." })),
  ],
  // ===== StableTravel: Reference Data =====
  ["flight-aviation.json", mkEntry("stabletravel-reference", "StableTravel Reference Data", "StableTravel", "stabletravel",
    "Amadeus reference data — search airports/cities by keyword, nearby airports by lat/lng, airline lookup by IATA, and airline/airport route lists. Cheap pay-per-call x402 reads.",
    ["airports", "airlines", "cities", "reference", "x402"],
    [
      B("https://stabletravel.dev/api/reference/locations", "GET", 0.005, "paid"),
      B("https://stabletravel.dev/api/reference/airports", "GET", 0.005, "paid"),
      B("https://stabletravel.dev/api/reference/airlines", "GET", 0.005, "paid"),
      B("https://stabletravel.dev/api/reference/airline-routes", "GET", 0.005, "paid"),
      B("https://stabletravel.dev/api/reference/airport-routes", "GET", 0.005, "paid"),
      B("https://stabletravel.dev/api/reference/cities", "GET", 0.005, "paid"),
    ],
    U("GET https://stabletravel.dev/api/reference/{locations|airports|airlines|...}?<params>", "$0.005",
      { keyword: "New York", subType: "AIRPORT,CITY" },
      { guide: "StableTravel reference data (Amadeus). /locations?keyword&subType=AIRPORT,CITY; /airports?latitude&longitude; /airlines?airlineCode=AA; /airline-routes?airlineCode&max; /airport-routes?departureAirportCode&max; /cities?keyword. All GET, $0.005, pay x402, synchronous JSON." })),
  ],
  // ===== StableTravel: Google Flights =====
  ["flight-aviation.json", mkEntry("stabletravel-google-flights", "StableTravel Google Flights", "StableTravel", "stabletravel",
    "Google Flights cash-price discovery via SerpAPI — aggregated prices/schedules/booking links across airlines and OTAs, plus price insights. Pay-per-call x402.",
    ["flights", "google-flights", "prices", "x402"],
    [
      B("https://stabletravel.dev/api/google-flights/search", "GET", 0.02, "paid"),
      B("https://stabletravel.dev/api/google-flights/booking", "GET", 0.02, "needs-id"),
    ],
    U("GET https://stabletravel.dev/api/google-flights/search?departure_id&arrival_id&outbound_date&type", "$0.02",
      { departure_id: "JFK", arrival_id: "LAX", outbound_date: "2026-07-15", type: 2 },
      { quirks: ["/booking needs a departure_token from a prior /search result."], guide: "Google Flights via StableTravel. GET /search?departure_id&arrival_id&outbound_date(&return_date for round-trip)&type(1=RT,2=OW,3=multi)&travel_class&adults&stops&currency → best_flights/other_flights/price_insights ($0.02). GET /booking adds departure_token (from search) → booking_options ($0.02). Pay x402, synchronous." })),
  ],
  // ===== StableTravel: Award Seats (Seats.aero) =====
  ["flight-aviation.json", mkEntry("stabletravel-award-seats", "StableTravel Award Seats (Seats.aero)", "StableTravel", "stabletravel",
    "Seats.aero cached points-and-miles award availability — search award inventory, bulk availability by program, route coverage, and per-availability trip/booking details. Pay-per-call x402.",
    ["award-travel", "miles", "seats-aero", "flights", "x402"],
    [
      B("https://stabletravel.dev/api/seats-aero/search", "GET", 0.02, "paid"),
      B("https://stabletravel.dev/api/seats-aero/availability", "GET", 0.04, "paid"),
      B("https://stabletravel.dev/api/seats-aero/routes", "GET", 0.01, "paid"),
      B("https://stabletravel.dev/api/seats-aero/trips/AVAILABILITY_ID", "GET", 0.02, "needs-id"),
    ],
    U("GET https://stabletravel.dev/api/seats-aero/search?origin_airport&destination_airport&cabin", "$0.01–$0.04",
      { origin_airport: "SFO", destination_airport: "LHR", cabin: "business" },
      { quirks: ["/trips/{id} needs an availability ID from /search.", "take must be 10–1000 when paginating."], guide: "Seats.aero via StableTravel (award/miles only, not cash). /search?origin_airport&destination_airport&start_date&end_date&cabin&carriers ($0.02) → /trips/{availabilityId} for segments/mileage/booking ($0.02). Broad: /routes?source=united ($0.01) → /availability?source=united ($0.04). Pay x402, synchronous." })),
  ],
  // ===== StableTravel: Activities =====
  ["scheduling-booking.json", mkEntry("stabletravel-activities", "StableTravel Activities", "StableTravel", "stabletravel",
    "Amadeus tours & activities — search by lat/lng or geographic square, and get activity details by ID. Pay-per-call x402.",
    ["activities", "tours", "amadeus", "x402"],
    [
      B("https://stabletravel.dev/api/activities/search", "GET", 0.05, "paid"),
      B("https://stabletravel.dev/api/activities/by-square", "GET", 0.05, "paid"),
      B("https://stabletravel.dev/api/activities/details", "GET", 0.05, "needs-id"),
    ],
    U("GET https://stabletravel.dev/api/activities/search?latitude&longitude&radius&max", "$0.05",
      { latitude: 48.8566, longitude: 2.3522, radius: 1, max: 5 },
      { quirks: ["/details needs an activity ID from a search."], guide: "StableTravel activities (Amadeus). /search?latitude&longitude&radius&max; /by-square?north&south&east&west&max; /details?activityId. All GET, $0.05, pay x402, synchronous." })),
  ],
  // ===== StableTravel: Transfers =====
  ["scheduling-booking.json", mkEntry("stabletravel-transfers", "StableTravel Transfers", "StableTravel", "stabletravel",
    "Amadeus airport transfers — search transfer options, then book/cancel. Search is a cheap read; book/cancel are irreversible money-movers (defer). Pay-per-call x402.",
    ["transfers", "ground-transport", "amadeus", "x402"],
    [
      B("https://stabletravel.dev/api/transfers/search", "POST", 0.003, "paid"),
      B("https://stabletravel.dev/api/transfers/book", "POST", 0.002, "irreversible"),
      B("https://stabletravel.dev/api/transfers/cancel", "POST", 0.002, "irreversible"),
    ],
    U("POST https://stabletravel.dev/api/transfers/search {startLocationCode,endGeoCode,startDateTime,passengers}", "$0.002–$0.003",
      { startLocationCode: "CDG", endGeoCode: "48.8566,2.3522", transferType: "PRIVATE", startDateTime: "2026-07-15T10:00:00", passengers: 2 },
      { quirks: ["Drop-off needs full address (endAddressLine+endCityName+endCountryCode) or endGeoCode.", "book/cancel are real bookings — defer to explicit user OK."], guide: "StableTravel transfers (Amadeus). POST /search {startLocationCode, endGeoCode or endAddress*, transferType, startDateTime, passengers} ($0.003). /book and /cancel are real money-movers — only with explicit user approval. Pay x402." })),
  ],
  // ===== StablePhone: iMessage/FaceTime Lookup =====
  ["sms-phone.json", mkEntry("stablephone-lookup", "StablePhone iMessage/FaceTime Lookup", "StablePhone", "stablephone",
    "Check whether a phone number has iMessage/FaceTime, plus carrier and country. Async: pay → token → poll SIWX status. Pay-per-call x402 ($0.05), no API key.",
    ["imessage", "facetime", "phone-lookup", "carrier", "x402"],
    [
      B("https://stablephone.dev/api/lookup", "POST", 0.05, "paid-async"),
    ],
    U("POST https://stablephone.dev/api/lookup {phone_number} → 202 {token}; poll GET /api/lookup/status?token=<jwt> (SIWX free)", "$0.05",
      { phone_number: "+14155551234" },
      { resultPull: "poll", auth: "siwx-poll", quirks: ["Async (30–90s): paid POST returns 202 {token}; poll GET /api/lookup/status?token=<jwt> with SIWX (paying wallet) every 3–5s until status=complete.", "Token expires 60 min. Same number within ~1h reuses cached result (no extra charge).", "imessage/facetime values: available|unavailable|unknown (unknown ~ landline/VoIP)."], guide: "StablePhone lookup. POST /api/lookup {phone_number E.164} → pays $0.05, returns 202 {token}. Poll GET /api/lookup/status?token=<jwt> (SIWX, paying wallet, free) until status=complete; read imessage/facetime/carrier/country. Pay x402 USDC on Base." })),
  ],
  // ===== StableMerch =====
  ["storefront-commerce-apis.json", mkEntry("stablemerch", "StableMerch Custom Merch", "StableMerch", "stablemerch",
    "Create custom shirts/mugs from an image and ship them via Printify. Preview→prepare→commit flow: free SIWX draft + preview, then the single paid x402 commit produces a real shipped order (irreversible).",
    ["merch", "print-on-demand", "shirts", "mugs", "printify", "x402"],
    [
      B("https://stablemerch.dev/api/catalog", "GET", 0, "free"),
      B("https://stablemerch.dev/api/drafts", "POST", 0, "siwx"),
      B("https://stablemerch.dev/api/drafts/DRAFT_ID/prepare-order", "POST", 0, "siwx-needs-id"),
      B("https://stablemerch.dev/api/drafts/DRAFT_ID/commit", "POST", 0, "irreversible"),
    ],
    U("GET /api/catalog (free) → POST /api/drafts (SIWX) → preview → prepare-order (SIWX) → commit (x402, ships goods)", "commit = dynamic (product price)",
      { product_slug: "mug", image_url: "https://example.com/art.png", client_request_id: "demo-1" },
      { auth: "siwx", needsApproval: true, quirks: ["GET /api/catalog and POST /api/drafts are FREE (SIWX); show preview_urls before anything else.", "commit is the ONLY paid step and it SHIPS A PHYSICAL PRODUCT — irreversible. Requires explicit user OK + shipping address.", "Never collect shipping/contact or call commit before the user approves the preview."], guide: "StableMerch. 1) GET /api/catalog (free). 2) POST /api/drafts (SIWX) {client_request_id, product_slug, image_url, options} → preview_urls (render them). 3) POST /api/drafts/{id}/prepare-order (SIWX) {address_to} → order_ready. 4) POST /api/drafts/{id}/commit (x402) → ships. Only commit costs money and it's irreversible — defer to explicit user approval." })),
  ],
];

const affected = new Set();
let addedBackends = 0, newEntries = 0;

const slug = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// apply ADD
for (const [file, nameOrId, backends, usageIfEmpty] of ADD) {
  const p = path.join(CUR, file);
  const cur = JSON.parse(fs.readFileSync(p, "utf8"));
  const entry = cur.entries.find((e) => e.name === nameOrId || e.id === nameOrId || slug(e.name) === nameOrId);
  if (!entry) { console.warn(`  ! ${file}: entry "${nameOrId}" not found — skip`); continue; }
  entry.backends ||= [];
  const have = new Set(entry.backends.filter((b) => typeof b === "object" && b.url).map((b) => b.url));
  for (const b of backends) {
    if (have.has(b.url)) continue;
    entry.backends.push(b); addedBackends++; affected.add(file.replace(".json", ""));
    console.log(`  + ${entry.name}: ${b.method} ${b.url} ($${b.amount}) [${b.note}]`);
  }
  if (usageIfEmpty && (!entry.usage || entry.usage.status === "untested")) entry.usage = usageIfEmpty;
  fs.writeFileSync(p, JSON.stringify(cur, null, 2) + "\n");
}

// apply NEW
for (const [file, entry] of NEW) {
  const p = path.join(CUR, file);
  const cur = JSON.parse(fs.readFileSync(p, "utf8"));
  if (cur.entries.some((e) => e.id === entry.id || e.name === entry.name)) {
    console.log(`  = ${entry.name} already present — skip`);
    continue;
  }
  cur.entries.push(entry); newEntries++; affected.add(file.replace(".json", ""));
  console.log(`  + NEW entry [${file.replace(".json", "")}]: ${entry.name} (${entry.backends.length} backends)`);
  fs.writeFileSync(p, JSON.stringify(cur, null, 2) + "\n");
}

console.log(`\nAdded ${addedBackends} backend(s) + ${newEntries} new entr(ies).`);
console.log(`Rebuild: ${[...affected].map((s) => `node scripts/registry/curate.mjs --subcat=${s}`).join(" && ")}`);

*/
