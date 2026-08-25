// Known multi-model / multi-service x402 gateways.
// Keyword search (/api/search) misses most of their endpoints — you MUST enumerate each with
// agentcash discover_api_endpoints(origin), then check_endpoint_schema(url) on any `model`-enum
// endpoint, and decompose into one model entry per model (gateway = a modelParam backend).
//
// `spans` = which subcategories each gateway feeds, so whoever curates that subcategory checks it.
export const GATEWAYS = [
  { origin: "https://blockrun.ai", name: "BlockRun AI Gateway",
    spans: ["llm-chat-apis", "image-generation", "video-generation", "music-generation", "web-search-apis",
            "ai-semantic-search", "sandbox-environments", "video-voice-calls", "sms-phone",
            "stocks-financial-data", "crypto-blockchain-data", "news-media"],
    note: "~90 endpoints: /chat/completions, /messages, /images/generations, /videos/generations (sora-2, grok-imagine-video, seedance-1.5-pro/2.0-fast/2.0), /audio/generations, /voice/call, /phone/*, /modal/sandbox/*, /exa/*, /surf/*, /defillama/*, /pm/* prediction markets, /crypto|fx|commodity|usstock/*." },

  { origin: "https://api.xona-agent.com", name: "Xona Agent",
    spans: ["image-generation", "video-generation", "voice-tts", "speech-to-text", "music-generation",
            "crypto-blockchain-data", "social-media-data"],
    note: "image: nano-banana/-pro/-2, gpt-image-2, flux-2-pro/-max/-flex, qwen-image, seedream-4.5; video: short-generation (Grok), seedance-generation (Seedance 2.0); audio: elevenlabs-music, x-text-to-speech, speech-to-text; token analytics + X persona/news." },

  { origin: "https://x402.orth.sh", name: "Orthogonal",
    spans: ["image-generation", "video-generation", "voice-tts", "speech-to-text", "music-generation",
            "sound-effects-audio", "translation", "llm-chat-apis", "avatars-digital-humans", "social-media-data"],
    note: "Proxies many upstreams: nano-banana (gemini 2.5/3-pro/3.1-flash), zai (cogview/cogvideox), elevenlabs (tts/music/sound/scribe/dubbing), openai (transcriptions/translations), tavus, fiber, nyne, etc. Pricing via check_endpoint_schema (search reports 'Varies')." },

  { origin: "https://stablestudio.dev", name: "StableStudio",
    spans: ["image-generation", "video-generation"],
    note: "gpt-image-1.5/2, veo-3.1/-fast, seedance/-fast (t2v/i2v), wan; x402+mpp. Sibling: stablestudio.io." },

  { origin: "https://x402helper.xyz", name: "x402 Helper",
    spans: ["image-generation", "speech-to-text", "voice-tts", "music-generation"],
    note: "Aggregator: ideogram-v3, imagen-3, hidream-e1, whisper/-large, melotts, etc." },

  { origin: "https://api.imgzen.dev", name: "imgzen",
    spans: ["image-generation"],
    note: "gpt-image-1/1.5, gemini 2.5/3-pro/3.1-flash image variants." },

  { origin: "https://gg402.vercel.app", name: "gg402",
    spans: ["music-generation", "voice-tts"],
    note: "Platform-hosted (needs-review): many music/voice composer endpoints." },
];
