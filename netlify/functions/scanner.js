const { runScan } = require("./lib/scanner-engine");
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

exports.handler = async () => {
  try {
    // 🔥 FORCE a real scan (no schedule restriction)
    const result = await runScan();

    // 🔥 Save latest state
    await supabase.from("scanner_state").upsert({
      id: 1,
      data: result,
      updated_at: new Date().toISOString()
    });

    return {
      statusCode: 200,
      body: JSON.stringify(result)
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    };
  }
};
