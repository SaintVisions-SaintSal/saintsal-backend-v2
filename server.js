require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 10000;

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'] }));

// Raw body for Stripe webhook
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '10mb' }));

// Request logging
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ─── SAL System Prompt ────────────────────────────────────────────────────────
const SAL_SYSTEM_PROMPT = `You are SAL — SaintSal™'s intelligent AI assistant, powered by HACP™ (Human AI Connection Protocol) technology, developed by Saint Vision Technologies. You are direct, helpful, knowledgeable, and capable. You assist with business strategy, creativity, research, coding, and anything else users need. Always be concise but thorough. Powered by US Patent #10,290,222.`;

// ─── Model Routing ────────────────────────────────────────────────────────────
function getProvider(model) {
  if (!model) return 'gemini';
  const m = model.toLowerCase();
  if (m.includes('gpt') || m.includes('openai') || m === 'openai') return 'openai';
  if (m.includes('claude') || m.includes('anthropic')) return 'anthropic';
  if (m.includes('grok') || m.includes('xai')) return 'grok';
  if (m.includes('gemini') || m === 'gemini') return 'gemini';
  return 'gemini'; // default
}

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    message: 'SaintApp Backend Server is running',
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/status', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    version: '2.0.0',
    models: ['gemini-2.0-flash', 'claude-sonnet-4', 'gpt-4o', 'grok-2'],
    timestamp: new Date().toISOString(),
  });
});

// ─── SAL Chat ─────────────────────────────────────────────────────────────────
app.post('/api/sal/chat', async (req, res) => {
  const { message, model, stream = true, conversationHistory = [] } = req.body;

  if (!message) {
    return res.status(400).json({ success: false, error: 'message is required' });
  }

  const provider = getProvider(model);
  console.log(`[Chat] provider=${provider} model=${model || 'default'} stream=${stream}`);

  try {
    if (provider === 'gemini') {
      await handleGeminiChat(req, res, message, model, stream, conversationHistory);
    } else if (provider === 'anthropic') {
      await handleAnthropicChat(req, res, message, model, stream, conversationHistory);
    } else if (provider === 'openai') {
      await handleOpenAIChat(req, res, message, model, stream, conversationHistory);
    } else if (provider === 'grok') {
      await handleGrokChat(req, res, message, model, stream, conversationHistory);
    } else {
      await handleGeminiChat(req, res, message, model, stream, conversationHistory);
    }
  } catch (err) {
    console.error('[Chat Error]', err.message);
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: err.message });
    }
  }
});

// ─── Gemini Handler ───────────────────────────────────────────────────────────
async function handleGeminiChat(req, res, message, model, stream, history) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ success: false, error: 'GEMINI_API_KEY not configured' });

  const { GoogleGenerativeAI } = require('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(key);
  // Map old/generic/deprecated model names to current available models
  const geminiModelMap = {
    'gemini-2.0-flash': 'gemini-2.5-flash',
    'gemini-2.0': 'gemini-2.5-flash',
    'gemini-flash': 'gemini-2.5-flash',
    'gemini-pro': 'gemini-2.5-pro',
    'gemini': 'gemini-2.5-flash',
    'gemini-1.5-flash': 'gemini-2.5-flash',
    'gemini-1.5-pro': 'gemini-2.5-pro',
  };
  const rawModel = (model && model.toLowerCase().includes('gemini')) ? model.toLowerCase() : 'gemini';
  const modelName = geminiModelMap[rawModel] || (rawModel.startsWith('gemini-2.5') ? rawModel : 'gemini-2.5-flash');
  const geminiModel = genAI.getGenerativeModel({ model: modelName, systemInstruction: SAL_SYSTEM_PROMPT });

  // Build chat history
  const geminiHistory = history.map(h => ({
    role: h.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: h.content }],
  }));

  const chat = geminiModel.startChat({ history: geminiHistory });

  if (!stream) {
    const result = await chat.sendMessage(message);
    const text = result.response.text();
    return res.json({ success: true, content: text });
  }

  // Streaming
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const result = await chat.sendMessageStream(message);
  for await (const chunk of result.stream) {
    const text = chunk.text();
    if (text) {
      res.write(`data: ${JSON.stringify({ content: text })}\n\n`);
    }
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

// ─── Anthropic Handler ────────────────────────────────────────────────────────
async function handleAnthropicChat(req, res, message, model, stream, history) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ success: false, error: 'ANTHROPIC_API_KEY not configured' });

  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic.default({ apiKey: key });

  const claudeModelMap = {
    'claude': 'claude-sonnet-4-5',
    'claude-3': 'claude-3-5-sonnet-20241022',
    'claude-sonnet': 'claude-sonnet-4-5',
    'claude-opus': 'claude-opus-4-5',
    'claude-haiku': 'claude-haiku-3-5',
    'anthropic': 'claude-sonnet-4-5',
  };
  const rawClaudeModel = model ? model.toLowerCase() : 'claude';
  const modelName = claudeModelMap[rawClaudeModel] || (rawClaudeModel.startsWith('claude-') && rawClaudeModel.length > 10 ? rawClaudeModel : 'claude-sonnet-4-5');

  const messages = [
    ...history.map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: message },
  ];

  if (!stream) {
    const resp = await client.messages.create({
      model: modelName,
      max_tokens: 4096,
      system: SAL_SYSTEM_PROMPT,
      messages,
    });
    return res.json({ success: true, content: resp.content[0].text });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const streamResp = client.messages.stream({
    model: modelName,
    max_tokens: 4096,
    system: SAL_SYSTEM_PROMPT,
    messages,
  });

  streamResp.on('text', (text) => {
    res.write(`data: ${JSON.stringify({ content: text })}\n\n`);
  });

  await streamResp.finalMessage();
  res.write('data: [DONE]\n\n');
  res.end();
}

// ─── OpenAI Handler ───────────────────────────────────────────────────────────
async function handleOpenAIChat(req, res, message, model, stream, history) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return res.status(500).json({ success: false, error: 'OPENAI_API_KEY not configured' });

  const OpenAI = require('openai');
  const client = new OpenAI.default({ apiKey: key });

  const modelName = (model && (model.toLowerCase().startsWith('gpt') || model.toLowerCase().startsWith('o'))) ? model : 'gpt-4o';

  const messages = [
    { role: 'system', content: SAL_SYSTEM_PROMPT },
    ...history.map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: message },
  ];

  if (!stream) {
    const completion = await client.chat.completions.create({ model: modelName, messages });
    return res.json({ success: true, content: completion.choices[0].message.content });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const streamResp = await client.chat.completions.create({ model: modelName, messages, stream: true });

  for await (const chunk of streamResp) {
    const text = chunk.choices[0]?.delta?.content || '';
    if (text) {
      res.write(`data: ${JSON.stringify({ content: text })}\n\n`);
    }
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

// ─── Grok Handler ─────────────────────────────────────────────────────────────
async function handleGrokChat(req, res, message, model, stream, history) {
  const key = process.env.XAI_API_KEY || process.env.GROK_API_KEY;
  if (!key) return res.status(500).json({ success: false, error: 'XAI_API_KEY not configured' });

  const OpenAI = require('openai');
  const client = new OpenAI.default({
    apiKey: key,
    baseURL: 'https://api.x.ai/v1',
  });

  const modelName = 'grok-2-latest';
  const messages = [
    { role: 'system', content: SAL_SYSTEM_PROMPT },
    ...history.map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: message },
  ];

  if (!stream) {
    const completion = await client.chat.completions.create({ model: modelName, messages });
    return res.json({ success: true, content: completion.choices[0].message.content });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const streamResp = await client.chat.completions.create({ model: modelName, messages, stream: true });

  for await (const chunk of streamResp) {
    const text = chunk.choices[0]?.delta?.content || '';
    if (text) {
      res.write(`data: ${JSON.stringify({ content: text })}\n\n`);
    }
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

// ─── Website Builder ──────────────────────────────────────────────────────────
app.post('/api/builder/generate', async (req, res) => {
  const { prompt, projectName = 'My Project', type = 'website' } = req.body;

  if (!prompt) return res.status(400).json({ success: false, error: 'prompt is required' });

  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ success: false, error: 'GEMINI_API_KEY not configured' });

  try {
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(key);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    const builderPrompt = `You are an expert web developer. Build a complete, beautiful, modern website based on this description:

"${prompt}"

Project Name: ${projectName}

Requirements:
- Create a complete, standalone HTML file with embedded CSS and JavaScript
- Make it visually stunning with modern design (dark theme preferred)
- Use CSS animations and transitions
- Make it fully responsive
- Include all content specified
- Use professional typography and color schemes
- The design should be clean, modern, and production-ready

Return ONLY the complete HTML file content. No explanations, no markdown code blocks, just the raw HTML starting with <!DOCTYPE html>.`;

    const result = await model.generateContent(builderPrompt);
    const html = result.response.text().replace(/^```html\n?/, '').replace(/\n?```$/, '').trim();

    res.json({
      success: true,
      projectName,
      preview: html,
      html,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[Builder Error]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/builder/projects', (req, res) => {
  res.json({ success: true, projects: [] });
});

// ─── Stripe Webhook ───────────────────────────────────────────────────────────
app.post('/api/stripe/webhook', async (req, res) => {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) return res.status(500).json({ error: 'Stripe not configured' });

  try {
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    const sig = req.headers['stripe-signature'];
    const event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);

    console.log(`[Stripe] Event: ${event.type}`);

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      console.log(`[Stripe] Payment completed: ${session.id}`);
    }

    res.json({ received: true });
  } catch (err) {
    console.error('[Stripe Webhook Error]', err.message);
    res.status(400).json({ error: err.message });
  }
});

// ─── Tavily Search ────────────────────────────────────────────────────────────
app.post('/api/search', async (req, res) => {
  const { query, max_results = 5, search_depth = 'basic', include_answer = true } = req.body;

  if (!query) return res.status(400).json({ success: false, error: 'query is required' });

  const key = process.env.TAVILY_API_KEY;
  if (!key) return res.status(500).json({ success: false, error: 'TAVILY_API_KEY not configured' });

  try {
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: key,
        query,
        max_results,
        search_depth,
        include_answer,
        include_images: false,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(response.status).json({ success: false, error: err });
    }

    const data = await response.json();
    res.json({
      success: true,
      query,
      answer: data.answer || null,
      results: data.results || [],
      response_time: data.response_time,
    });
  } catch (err) {
    console.error('[Tavily Error]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// SAL Chat with Web Search (Tavily + AI)
app.post('/api/sal/search-chat', async (req, res) => {
  const { message, model, stream = false } = req.body;
  if (!message) return res.status(400).json({ success: false, error: 'message is required' });

  const tavilyKey = process.env.TAVILY_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;
  if (!tavilyKey) return res.status(500).json({ success: false, error: 'TAVILY_API_KEY not configured' });
  if (!geminiKey) return res.status(500).json({ success: false, error: 'GEMINI_API_KEY not configured' });

  try {
    // Step 1: Search the web
    const searchResp = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: tavilyKey,
        query: message,
        max_results: 5,
        search_depth: 'basic',
        include_answer: true,
      }),
    });
    const searchData = await searchResp.json();

    // Step 2: Build context from search results
    const searchContext = searchData.results
      ? searchData.results.slice(0, 5).map((r, i) => `[${i+1}] ${r.title}\n${r.content}\nSource: ${r.url}`).join('\n\n')
      : '';
    const searchAnswer = searchData.answer || '';

    // Step 3: Ask AI with context
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(geminiKey);
    const aiModel = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      systemInstruction: `${SAL_SYSTEM_PROMPT}\n\nYou have access to real-time web search results. Use them to provide accurate, up-to-date answers. Always cite your sources.`,
    });

    const prompt = `User question: ${message}\n\nWeb search results:\n${searchAnswer ? `Quick answer: ${searchAnswer}\n\n` : ''}${searchContext}\n\nProvide a comprehensive answer based on these search results.`;

    const result = await aiModel.generateContent(prompt);
    const content = result.response.text();

    res.json({
      success: true,
      content,
      sources: searchData.results ? searchData.results.slice(0, 5).map(r => ({ title: r.title, url: r.url })) : [],
      searchAnswer,
    });
  } catch (err) {
    console.error('[Search-Chat Error]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── 404 Handler ──────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, error: 'Endpoint not found', path: req.path });
});

// ─── Start Server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n⚡ SaintSal™ Backend v2.0 running on port ${PORT}`);
  console.log(`🌐 Health: http://localhost:${PORT}/health`);
  console.log(`💬 Chat:   http://localhost:${PORT}/api/sal/chat`);
  console.log(`🔨 Builder: http://localhost:${PORT}/api/builder/generate`);
  console.log(`\nProviders: Gemini ✓ | OpenAI | Anthropic | Grok`);
});
