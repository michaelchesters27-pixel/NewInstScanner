const { runScan } = require('./lib/scanner-engine');

exports.handler = async function handler() {
  try {
    await runScan();
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true }),
    };
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ ok: false, error: error.message || 'Scheduled scan failed' }),
    };
  }
};

exports.config = {
  schedule: '*/15 * * * 1-5',
};
