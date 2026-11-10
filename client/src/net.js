// WebSocket-Verbindung zum JARVIS-Server mit automatischer Wiederverbindung.
export class Net {
  constructor(onMessage, onStatus) {
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.ws = null;
    this.retry = 0;
    this.connect();
  }
  connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.onStatus(true);
    };
    ws.onmessage = (e) => {
      try {
        this.onMessage(JSON.parse(e.data));
      } catch (err) {
        console.error(err);
      }
    };
    ws.onclose = () => {
      this.onStatus(false);
      setTimeout(() => this.connect(), Math.min(8000, 500 * 2 ** this.retry++));
    };
  }
  send(msg) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(msg));
  }
  sendBinary(buf) {
    if (this.ws?.readyState === 1 && this.ws.bufferedAmount < 512_000) this.ws.send(buf);
  }
}
