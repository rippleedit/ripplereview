import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = here;
const port = Number(process.env.PORT || 8091);

const mime = new Map([
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".mp4", "video/mp4"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webm", "video/webm"],
]);

function sendText(response, status, message) {
  response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  response.end(message);
}

createServer(async (request, response) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendText(response, 405, "Method not allowed");
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
  } catch {
    sendText(response, 400, "Bad request");
    return;
  }


  let filePath = path.resolve(root, `.${pathname}`);
  if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
    sendText(response, 403, "Forbidden");
    return;
  }

  try {
    let fileStat = await stat(filePath);
    if (fileStat.isDirectory()) {
      filePath = path.join(filePath, "index.html");
      fileStat = await stat(filePath);
    }
    if (!fileStat.isFile()) throw new Error("Not a file");

    const contentType = mime.get(path.extname(filePath).toLowerCase()) || "application/octet-stream";
    const baseHeaders = {
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",   // a dev server should never serve yesterday's file
      "Content-Type": contentType,
    };
    const range = request.headers.range;

    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match) {
        response.writeHead(416, { ...baseHeaders, "Content-Range": `bytes */${fileStat.size}` });
        response.end();
        return;
      }

      const start = match[1] ? Number(match[1]) : Math.max(0, fileStat.size - Number(match[2] || 0));
      const end = match[2] ? Math.min(Number(match[2]), fileStat.size - 1) : fileStat.size - 1;
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= fileStat.size) {
        response.writeHead(416, { ...baseHeaders, "Content-Range": `bytes */${fileStat.size}` });
        response.end();
        return;
      }

      response.writeHead(206, {
        ...baseHeaders,
        "Content-Length": end - start + 1,
        "Content-Range": `bytes ${start}-${end}/${fileStat.size}`,
      });
      if (request.method === "HEAD") response.end();
      else createReadStream(filePath, { start, end }).pipe(response);
      return;
    }

    response.writeHead(200, { ...baseHeaders, "Content-Length": fileStat.size });
    if (request.method === "HEAD") response.end();
    else createReadStream(filePath).pipe(response);
  } catch {
    sendText(response, 404, "Not found");
  }
}).listen(port, "0.0.0.0", () => {
  console.log(`RippleReview ready at http://localhost:${port}/`);
});
