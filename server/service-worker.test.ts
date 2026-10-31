import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
const ORIGIN = "https://home.tail1234.ts.net";

const page = (build: string) =>
  `<html><head><script type="module" crossorigin src="/assets/index-${build}.js"></script><link rel="stylesheet" crossorigin href="/assets/index-${build}.css"></head></html>`;

type Handler = (event: any) => void;

class FakeRequest {
  readonly method = "GET";
  readonly url: string;
  readonly mode: string;

  constructor(url: string, mode: string) {
    this.url = url;
    this.mode = mode;
  }

  toString() {
    return this.url;
  }
}

function worker(serve: (path: string) => Response | Promise<Response>) {
  const handlers: Record<string, Handler> = {};
  const stores = new Map<string, Map<string, Response>>();
  const key = (input: string | FakeRequest) => new URL(String(input), ORIGIN).href;
  const fetch = async (input: string | FakeRequest) => serve(new URL(key(input)).pathname);
  const cache = (store: Map<string, Response>) => ({
    match: async (input: string) => store.get(key(input))?.clone(),
    put: async (input: string, response: Response) => void store.set(key(input), response),
    add: async (input: FakeRequest) => void store.set(key(input), await fetch(input)),
    addAll: async (inputs: string[]) => {
      const responses = await Promise.all(inputs.map(fetch));
      if (responses.some((response) => !response.ok)) throw new TypeError("addAll failed");
      responses.forEach((response, i) => store.set(key(inputs[i]), response));
    },
    keys: async () => [...store.keys()].map((url) => new FakeRequest(url, "same-origin")),
    delete: async (input: FakeRequest) => store.delete(key(input)),
  });
  const caches = {
    open: async (name: string) => {
      if (!stores.has(name)) stores.set(name, new Map());
      return cache(stores.get(name)!);
    },
    delete: async (name: string) => stores.delete(name),
    match: async (input: string) => [...stores.values()].find((store) => store.has(key(input)))?.get(key(input))?.clone(),
  };
  const self = {
    location: new URL(ORIGIN),
    registration: { navigationPreload: { enable: async () => {} } },
    skipWaiting: () => {},
    addEventListener: (type: string, handler: Handler) => (handlers[type] = handler),
  };
  new Function("self", "caches", "fetch", source)(self, caches, fetch);

  const dispatch = (type: string, request?: FakeRequest) => {
    let response: Promise<Response> | undefined;
    const waits: Promise<unknown>[] = [];
    handlers[type]?.({
      request,
      preloadResponse: Promise.resolve(undefined),
      respondWith: (value: Promise<Response>) => (response = value),
      waitUntil: (value: Promise<unknown>) => waits.push(value),
    });
    return { response, settled: () => Promise.all(waits) };
  };
  const shell = async () => (await (await caches.open("wink-shell-v1")).keys()).map((entry) => new URL(entry.url).pathname).sort();
  return {
    install: () => dispatch("install").settled(),
    navigate: (path: string) => dispatch("fetch", new FakeRequest(ORIGIN + path, "navigate")),
    get: (path: string) => dispatch("fetch", new FakeRequest(ORIGIN + path, "cors")),
    shell,
  };
}

function build(name: string) {
  return (path: string) => {
    if (path === "/") return new Response(page(name), { headers: { "content-type": "text/html" } });
    if (path === `/assets/index-${name}.js` || path === `/assets/index-${name}.css`) return new Response(`/* ${name} */`);
    return new Response("not found", { status: 404 });
  };
}

describe("service worker app shell", () => {
  it("answers an open the network leaves waiting with the saved page, then keeps the new build", async () => {
    let serve: (path: string) => Response | Promise<Response> = build("AAAA");
    const sw = worker((path) => serve(path));
    await sw.install();
    expect(await sw.shell()).toEqual(["/", "/assets/index-AAAA.css", "/assets/index-AAAA.js"]);

    let wake!: () => void;
    const asleep = new Promise<void>((resolve) => (wake = resolve));
    serve = async (path) => {
      if (path === "/") await asleep;
      return build("BBBB")(path);
    };
    const started = Date.now();
    const open = sw.navigate("/?bot=b1&thread=t1");
    expect(await (await open.response!).text()).toContain("index-AAAA.js");
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(await (await sw.get("/assets/index-AAAA.js").response!).text()).toBe("/* AAAA */");

    wake();
    await open.settled();
    expect(await sw.shell()).toEqual(["/", "/assets/index-BBBB.css", "/assets/index-BBBB.js"]);
    expect(await (await sw.navigate("/").response!).text()).toContain("index-BBBB.js");
  });

  it("keeps the old page when the new build's files cannot be stored", async () => {
    let serve = build("AAAA");
    const sw = worker((path) => serve(path));
    await sw.install();
    serve = (path) => (path === "/" ? build("BBBB")(path) : new Response("gone", { status: 404 }));
    const open = sw.navigate("/");
    expect(await (await open.response!).text()).toContain("index-BBBB.js");
    await open.settled();
    expect(await sw.shell()).toEqual(["/", "/assets/index-AAAA.css", "/assets/index-AAAA.js"]);
  });

  it("drops the saved page when the PC sends the phone to pairing", async () => {
    let serve = build("AAAA");
    const sw = worker((path) => serve(path));
    await sw.install();
    serve = () => Response.redirect(`${ORIGIN}/pair`, 302);
    await sw.navigate("/").settled();
    expect(await sw.shell()).toEqual([]);
  });

  it("leaves other pages and api calls to the network on a tailnet origin", () => {
    const sw = worker(build("AAAA"));
    expect(sw.navigate("/pair").response).toBeUndefined();
    expect(sw.navigate("/api/files/a.png").response).toBeUndefined();
    expect(sw.get("/api/bots").response).toBeUndefined();
  });
});
