
// api/chat.js
// Vercel serverless function — proxies AI requests to OpenRouter.
// Deploy this file at: api/chat.js in your GitHub repo root.
//
// Setup in Vercel:
//   1. Import your GitHub repo at vercel.com
//   2. Settings → Environment Variables → Add OPENROUTER_API_KEY = sk-or-v1-...
//   3. Deploy — the function is automatically available at /api/chat
//
// The HTML file calls /.netlify/functions/chat — update that URL to /api/chat
// (one search-and-replace in index.html)

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: { message: "OPENROUTER_API_KEY not set in Vercel environment variables" }
    });
  }

  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${apiKey}`,
        "HTTP-Referer":  "https://tmnus.netlify.app",
        "X-Title":       "T-Minus"
      },
      body: JSON.stringify(req.body)
    });

    const data = await response.json();
    return res.status(response.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: { message: "Proxy error: " + err.message } });
  }
}
