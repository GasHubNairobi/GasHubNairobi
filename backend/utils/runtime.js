/* Where is the backend running?
   - Netlify Functions (serverless): no long-running process, so nothing may be kept in memory between requests,
     no timers can run, and nothing can keep working after the response has been sent.
   - Local / any normal Node server (npm start): behaves exactly as before.
   netlify/functions/*.js set GASHUB_SERVERLESS=1 before loading the backend. */
const isServerless = Boolean(
    process.env.GASHUB_SERVERLESS ||
    process.env.AWS_LAMBDA_FUNCTION_NAME ||
    process.env.LAMBDA_TASK_ROOT
);

module.exports = { isServerless };
