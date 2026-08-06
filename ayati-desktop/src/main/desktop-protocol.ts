import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { net, protocol } from "electron";

const DESKTOP_SCHEME = "ayati";
const DESKTOP_HOST = "app";

export function registerDesktopScheme(): void {
  protocol.registerSchemesAsPrivileged([{
    scheme: DESKTOP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      codeCache: true,
    },
  }]);
}

export async function registerDesktopProtocol(rendererRoot: string): Promise<void> {
  const canonicalRoot = await realpath(rendererRoot);
  await protocol.handle(DESKTOP_SCHEME, async (request) => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return response(400, "Invalid desktop URL.");
    }
    if (
      url.hostname !== DESKTOP_HOST
      || url.username !== ""
      || url.password !== ""
      || url.port !== ""
    ) {
      return response(404, "Desktop resource not found.");
    }

    let requestedPath: string;
    try {
      requestedPath = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
    } catch {
      return response(400, "Invalid desktop resource path.");
    }
    if (requestedPath.includes("\0")) {
      return response(400, "Invalid desktop resource path.");
    }

    const candidate = resolve(canonicalRoot, requestedPath);
    if (!isContained(canonicalRoot, candidate)) {
      return response(403, "Desktop resource path is outside the application bundle.");
    }
    try {
      const canonicalCandidate = await realpath(candidate);
      if (!isContained(canonicalRoot, canonicalCandidate)) {
        return response(403, "Desktop resource path is outside the application bundle.");
      }
      const metadata = await stat(canonicalCandidate);
      if (!metadata.isFile()) {
        return response(404, "Desktop resource not found.");
      }
      return await net.fetch(pathToFileURL(canonicalCandidate).toString());
    } catch {
      return response(404, "Desktop resource not found.");
    }
  });
}

export function desktopUrl(): string {
  return `${DESKTOP_SCHEME}://${DESKTOP_HOST}/index.html`;
}

export function isTrustedDesktopUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === `${DESKTOP_SCHEME}:`
      && url.hostname === DESKTOP_HOST
      && url.username === ""
      && url.password === ""
      && url.port === "";
  } catch {
    return false;
  }
}

function isContained(root: string, target: string): boolean {
  const child = relative(root, target);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function response(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
