const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname);
const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};
const allowedFiles = new Set(["index.html", "styles.css", "app.js"]);

http.createServer((request, response) => {
  const pathname = new URL(request.url, "http://localhost").pathname;
  let relativePath;
  try {
    relativePath = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
  } catch {
    response.writeHead(400).end("Bad request");
    return;
  }
  if (!allowedFiles.has(relativePath)) {
    response.writeHead(404).end("Not found");
    return;
  }
  const filePath = path.resolve(root, relativePath);

  if (!filePath.startsWith(root + path.sep)) {
    response.writeHead(403).end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      response.writeHead(error.code === "ENOENT" ? 404 : 500).end("Not found");
      return;
    }

    response.writeHead(200, {
      "Content-Type": types[path.extname(filePath)] || "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer"
    });
    response.end(content);
  });
}).listen(process.env.PORT || 3000, () => {
  console.log(`Repo Analyzer is running at http://localhost:${process.env.PORT || 3000}`);
});
