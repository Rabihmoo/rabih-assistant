const axios = require('axios');

async function getNews(query, country) {
  var key = process.env.NEWSAPI_KEY;
  if (!key) return { error: 'NEWSAPI_KEY not configured. Add it to Railway env vars.' };

  try {
    var url, params;
    if (query) {
      url = 'https://newsapi.org/v2/everything';
      params = { q: query, sortBy: 'publishedAt', pageSize: 8, apiKey: key };
    } else {
      url = 'https://newsapi.org/v2/top-headlines';
      params = { country: country || 'us', pageSize: 8, apiKey: key };
    }
    var res = await axios.get(url, { params: params, timeout: 10000 });
    var articles = (res.data.articles || []).slice(0, 8);
    return {
      count: articles.length,
      articles: articles.map(function(a) {
        return {
          title: a.title,
          source: a.source && a.source.name,
          description: a.description ? a.description.substring(0, 200) : '',
          url: a.url,
          published: a.publishedAt
        };
      })
    };
  } catch (err) {
    return { error: 'News fetch failed: ' + err.message };
  }
}

async function getExchangeRate(fromCurrency, toCurrency) {
  try {
    var from = (fromCurrency || 'USD').toUpperCase();
    var to = (toCurrency || 'MZN').toUpperCase();
    var res = await axios.get('https://open.er-api.com/v6/latest/' + from, { timeout: 10000 });
    if (!res.data || !res.data.rates) return { error: 'Could not fetch exchange rates' };
    var rate = res.data.rates[to];
    if (!rate) return { error: 'Currency not found: ' + to };
    // Get a few common rates too
    var commonRates = {};
    var common = ['USD', 'EUR', 'MZN', 'LBP', 'GBP', 'ZAR', 'BRL'];
    for (var i = 0; i < common.length; i++) {
      if (res.data.rates[common[i]] && common[i] !== from) {
        commonRates[common[i]] = res.data.rates[common[i]];
      }
    }
    return {
      from: from,
      to: to,
      rate: rate,
      amount_example: '1 ' + from + ' = ' + rate.toFixed(4) + ' ' + to,
      updated: res.data.time_last_update_utc,
      other_rates: commonRates
    };
  } catch (err) {
    return { error: 'Exchange rate fetch failed: ' + err.message };
  }
}

var newsTools = [
  {
    name: 'get_news',
    description: 'Get latest news headlines. Search by topic or get top headlines by country. Use when Rabih asks what\'s happening, news about X, Lebanon news.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search topic e.g. "Lebanon", "Mozambique", "restaurants". Leave empty for top headlines.' },
        country: { type: 'string', description: 'Country code for top headlines: us, lb (Lebanon), za (South Africa). Default us.' }
      },
      required: []
    }
  },
  {
    name: 'get_exchange_rate',
    description: 'Get current exchange rate between currencies. Use when Rabih asks about USD to MZN, dollar rate, currency conversion.',
    input_schema: {
      type: 'object',
      properties: {
        from_currency: { type: 'string', description: 'Source currency code e.g. USD, EUR, MZN, LBP. Default USD.' },
        to_currency: { type: 'string', description: 'Target currency code. Default MZN.' }
      },
      required: []
    }
  }
];

async function handleNewsTool(toolName, toolInput) {
  try {
    switch (toolName) {
      case 'get_news': return await getNews(toolInput.query, toolInput.country);
      case 'get_exchange_rate': return await getExchangeRate(toolInput.from_currency, toolInput.to_currency);
      default: return { error: 'Unknown news tool: ' + toolName };
    }
  } catch (err) {
    console.error('News tool error:', err.message);
    return { error: err.message };
  }
}

module.exports = { newsTools: newsTools, handleNewsTool: handleNewsTool, getExchangeRate: getExchangeRate };
