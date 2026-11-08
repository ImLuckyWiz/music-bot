import net from "net";

/**
 * Finds an available local TCP port on loopback.
 */
export const getAvailablePort = (): Promise<number> => {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Unable to obtain local port")));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
};

/**
 * Sends a live volume adjustment command to FFmpeg's azmq filter using ZMTP 3.0.
 * @param port Loopback port where FFmpeg's azmq filter is bound
 * @param volumeFraction Audio volume multiplier (e.g. 0.0 to 1.0 or up to 2.0)
 * @param timeoutMs Timeout in milliseconds
 */
export const sendFfmpegVolumeCommand = (
  port: number,
  volumeFraction: number,
  timeoutMs = 1200,
): Promise<boolean> => {
  return new Promise((resolve) => {
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let sock: net.Socket | null = null;

    const cleanup = (success: boolean) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      if (sock) {
        try {
          sock.destroy();
        } catch {}
      }
      resolve(success);
    };

    timer = setTimeout(() => cleanup(false), timeoutMs);

    sock = net.createConnection({ host: "127.0.0.1", port }, () => {
      // 1. Send ZMTP 3.0 greeting (64 bytes)
      const greeting = Buffer.alloc(64);
      greeting[0] = 0xff;
      greeting[9] = 0x7f;
      greeting[10] = 3;
      greeting[11] = 0;
      greeting.write("NULL", 12, 4, "ascii");
      sock?.write(greeting);
    });

    let state: "greeting" | "ready" = "greeting";
    let recvBuf = Buffer.alloc(0);

    sock.on("data", (chunk: Buffer) => {
      recvBuf = Buffer.concat([recvBuf, chunk]);

      if (state === "greeting" && recvBuf.length >= 64) {
        recvBuf = recvBuf.slice(64);
        state = "ready";

        // 2. Send READY command frame for REQ socket
        const cmdName = Buffer.from("READY");
        const propName = Buffer.from("Socket-Type");
        const propVal = Buffer.from("REQ");
        const valLenBuf = Buffer.alloc(4);
        valLenBuf.writeUInt32BE(propVal.length, 0);

        const body = Buffer.concat([
          Buffer.from([cmdName.length]),
          cmdName,
          Buffer.from([propName.length]),
          propName,
          valLenBuf,
          propVal,
        ]);

        const readyFrame = Buffer.concat([
          Buffer.from([0x04, body.length]),
          body,
        ]);
        sock?.write(readyFrame);

        // 3. Send REQ message: empty delimiter + payload frame
        // Clamped between 0.0 and 2.0
        const safeFraction = Math.max(0, Math.min(2, volumeFraction)).toFixed(4);
        const msg = Buffer.from(`volume volume ${safeFraction}`);
        const delimFrame = Buffer.from([0x01, 0x00]);
        const msgFrame = Buffer.concat([
          Buffer.from([0x00, msg.length]),
          msg,
        ]);
        sock?.write(Buffer.concat([delimFrame, msgFrame]));
      } else if (state === "ready" && recvBuf.length > 0) {
        // Reply received from FFmpeg
        cleanup(true);
      }
    });

    sock.on("error", () => cleanup(false));
  });
};
