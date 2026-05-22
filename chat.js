// netlify/functions/chat.js
// Proxies AI requests to OpenRouter — keeps the API key server-side only.
// Deploy this file at: netlify/functions/chat.js in your GitHub repo root.
// Add OPENROUTER_API_KEY as an environment variable in Netlify:
//   Site configuration → Environment variables → Add variable

exports.handler = async (event) => {
  // Only allow POST
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: { message: "OPENROUTER_API_KEY not set in Netlify environment variables" } })
    };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: { message: "Invalid JSON body" } }) };
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
      body: JSON.stringify(body)
    });

    const data = await response.json();

    return {
      statusCode: response.status,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data)
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: { message: "Proxy error: " + err.message } })
    };
  }
};
