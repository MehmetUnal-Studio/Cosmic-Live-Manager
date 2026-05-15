const Max = require('max-api');
const path = require('path');
const dgram = require('dgram');

// Resolve ws relative to this script file, not Max's working directory
const WebSocket = require(path.join(__dirname, 'node_modules', 'ws'));

let ws = null;
let udpSocket = null;

Max.addHandler('register', async (ip, serverPort, udpPort) => {
    await closeAll();

    udpSocket = dgram.createSocket('udp4');

    udpSocket.on('listening', () => {
        const addr = udpSocket.address();
        Max.outlet('udp_listening', addr.port);
    });

    udpSocket.on('error', (err) => {
        Max.outlet('udp_error', err.message);
    });

    udpSocket.on('message', (buf) => {
        const msg = parseOSC(buf);
        if (msg) Max.outlet(msg.address, ...msg.args);
    });

    udpSocket.bind(udpPort, '0.0.0.0');

    ws = new WebSocket(`ws://${ip}:${serverPort}`);
    ws.binaryType = 'arraybuffer';

    ws.on('open', () => {
        ws.send(makeOscRegister(udpPort));
        Max.outlet('registered');
    });
    ws.on('error', e => Max.outlet('error', e.message));
    ws.on('close', () => Max.outlet('closed'));
});

Max.addHandler('unregister', async () => {
    await closeAll();
    Max.outlet('unregistered');
});

async function closeAll() {
    if (ws) {
        try { ws.close(); } catch (e) {}
        ws = null;
    }
    if (udpSocket) {
        await new Promise(res => {
            try { udpSocket.close(() => res()); }
            catch (e) { res(); }
        });
        udpSocket = null;
    }
}

function parseOSC(buf) {
    try {
        let offset = 0;
        const addrEnd = buf.indexOf(0, offset);
        const address = buf.slice(offset, addrEnd).toString('ascii');
        offset = Math.ceil((addrEnd + 1) / 4) * 4;

        const typeEnd = buf.indexOf(0, offset);
        const typeTag = buf.slice(offset, typeEnd).toString('ascii');
        offset = Math.ceil((typeEnd + 1) / 4) * 4;

        const args = [];
        for (let i = 1; i < typeTag.length; i++) {
            const t = typeTag[i];
            if (t === 'f') {
                args.push(buf.readFloatBE(offset));
                offset += 4;
            } else if (t === 'i') {
                args.push(buf.readInt32BE(offset));
                offset += 4;
            } else if (t === 'd') {
                args.push(buf.readDoubleBE(offset));
                offset += 8;
            } else if (t === 'h') {
                args.push(Number(buf.readBigInt64BE(offset)));
                offset += 8;
            } else if (t === 's' || t === 'S') {
                const sEnd = buf.indexOf(0, offset);
                args.push(buf.slice(offset, sEnd).toString('ascii'));
                offset = Math.ceil((sEnd + 1) / 4) * 4;
            } else if (t === 'T') {
                args.push(1);
            } else if (t === 'F') {
                args.push(0);
            }
        }
        return { address, args };
    } catch (e) {
        return null;
    }
}

function makeOscRegister(port) {
    const addr = '/udp/register';
    const addrLen = Math.ceil((addr.length + 1) / 4) * 4;
    const buf = Buffer.alloc(addrLen + 4 + 4);
    buf.write(addr, 0, 'ascii');
    buf.write(',i\0\0', addrLen, 'ascii');
    buf.writeInt32BE(port, addrLen + 4);
    return buf;
}

function cleanup() {
    if (ws) { try { ws.close(); } catch (e) {} }
    if (udpSocket) { try { udpSocket.close(); } catch (e) {} }
    process.exit(0);
}

process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);
