// Local dev server: adapts plain HTTP requests to the Lambda Function URL event shape.
// node dev.mjs  →  http://localhost:8787
import http from 'node:http';
import { handler } from './src/handler.mjs';

const PORT = process.env.PORT || 8787;
http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const url = new URL(req.url, `http://${req.headers.host}`);
  const out = await handler({
    rawPath: url.pathname,
    queryStringParameters: Object.fromEntries(url.searchParams),
    headers: req.headers,
    requestContext: { http: { method: req.method } },
    body: Buffer.concat(chunks).toString('utf8'),
  });
  res.writeHead(out.statusCode, out.headers);
  res.end(out.isBase64Encoded ? Buffer.from(out.body, 'base64') : out.body);
}).listen(PORT, () => console.log(`http://localhost:${PORT}`));
