const { loadDashboardState } = require('./lib/scanner-engine');

exports.handler = async function handler() {
  try {
    const result = await loadDashboardState();
    return {
      statusCode: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      },
      body: JSON.stringify(result),
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ ok: false, error: error.message || 'Unknown state error' }),
    };
  }
};
