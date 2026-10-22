// Minimal CDP (Chrome DevTools Protocol) helpers for the test scripts. No deps.

export async function cdpConnect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error("WebSocket failed to connect"));
  });
  let nextId = 1;
  const pending = new Map();
  const listeners = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    } else if (msg.method) {
      // An event, e.g. "Runtime.consoleAPICalled".
      const handlers = listeners.get(msg.method);
      if (handlers) for (const handler of handlers) handler(msg.params, msg.sessionId);
    }
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });
  // Subscribe to an event. Returns a function that unsubscribes.
  const on = (method, handler) => {
    if (!listeners.has(method)) listeners.set(method, []);
    listeners.get(method).push(handler);
    return () => {
      const handlers = listeners.get(method) || [];
      const index = handlers.indexOf(handler);
      if (index >= 0) handlers.splice(index, 1);
    };
  };
  return { send, on, close: () => ws.close() };
}

export async function evalInTarget(client, sessionId, expression, awaitPromise = true) {
  // Wrap so that "await" works at the top level of the expression.
  const wrapped = `(async () => (${expression}))()`;
  const r = await client.send("Runtime.evaluate", { expression: wrapped, awaitPromise, returnByValue: true }, sessionId);
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || "eval exception");
  }
  return r.result ? r.result.value : undefined;
}

export async function httpJson(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`${options?.method || "GET"} ${url} -> ${res.status}`);
  return res.json();
}

export async function waitFor(fn, timeoutMs = 20000, intervalMs = 300) {
  const start = Date.now();
  let lastErr;
  while (Date.now() - start < timeoutMs) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("waitFor timed out" + (lastErr ? ": " + lastErr.message : ""));
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
