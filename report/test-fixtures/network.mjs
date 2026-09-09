const originalFetch = globalThis.fetch;
const base = new URL(process.env.TEST_API_URL);
globalThis.fetch = (input, options) => {
  const url = new URL(input);
  if (url.origin === "https://api.notion.com") {
    url.host = base.host;
    url.protocol = base.protocol;
  }
  if (url.origin !== base.origin) throw new Error(`Test blocked external request: ${url.origin}`);
  return originalFetch(url, options);
};
