// WebSocket client for FlowState Radio

class FlowStateWS {
  constructor() {
    this.ws = null;
    this.listeners = new Map();
    this.reconnectTimer = null;
    this.reconnectDelay = 2000;
  }

  connect() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${window.location.host}/stream`;

    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      console.log('[WS] Connected');
      this.reconnectDelay = 2000;
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        const handlers = this.listeners.get(data.type) || [];
        handlers.forEach((handler) => handler(data.data));
      } catch (err) {
        console.error('[WS] Parse error:', err);
      }
    };

    this.ws.onclose = () => {
      console.log('[WS] Disconnected, reconnecting...');
      this.scheduleReconnect();
    };

    this.ws.onerror = (err) => {
      console.error('[WS] Error:', err);
      this.ws.close();
    };
  }

  scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);
    // Exponential backoff (max 30s)
    this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, 30000);
  }

  on(eventType, handler) {
    if (!this.listeners.has(eventType)) {
      this.listeners.set(eventType, []);
    }
    this.listeners.get(eventType).push(handler);
  }

  off(eventType, handler) {
    const handlers = this.listeners.get(eventType);
    if (handlers) {
      const index = handlers.indexOf(handler);
      if (index > -1) handlers.splice(index, 1);
    }
  }

  disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

// Singleton instance
const wsClient = new FlowStateWS();
export default wsClient;
