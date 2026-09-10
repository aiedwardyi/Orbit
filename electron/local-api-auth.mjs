export function readAppToken(message) {
  return message?.type === "orbit:api-token" && /^[a-f0-9]{48}$/.test(message.token)
    ? message.token
    : null;
}

export function createAppAuthorization() {
  let binding = null;
  const issued = new Set();
  return {
    bind(origin, token) {
      binding = token ? { origin: new URL(origin).origin, token } : null;
      if (token) issued.add(`Bearer ${token}`);
    },
    headers(details, webContents) {
      const headers = { ...details.requestHeaders };
      for (const name of Object.keys(headers)) {
        if (name.toLowerCase() === "authorization" && issued.has(headers[name])) delete headers[name];
      }
      if (!binding || !webContents || webContents.isDestroyed() || details.webContentsId !== webContents.id) return headers;
      const url = new URL(details.url);
      if (url.origin !== binding.origin || !url.pathname.startsWith("/api/")) return headers;
      if (originOf(webContents.getURL()) !== binding.origin) return headers;
      if (!details.frame || originOf(details.frame.url) !== binding.origin) return headers;
      for (const name of Object.keys(headers)) {
        if (name.toLowerCase() === "authorization") delete headers[name];
      }
      headers.Authorization = `Bearer ${binding.token}`;
      return headers;
    },
  };
}

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export function waitForAppToken(child, timeoutMs) {
  return new Promise((resolve) => {
    const finish = (token) => {
      clearTimeout(timer);
      child.removeListener("message", onMessage);
      child.removeListener("exit", onExit);
      resolve(token);
    };
    const onMessage = (message) => {
      const token = readAppToken(message);
      if (token) finish(token);
    };
    const onExit = () => finish(null);
    const timer = setTimeout(() => finish(null), timeoutMs);
    child.on("message", onMessage);
    child.once("exit", onExit);
  });
}
