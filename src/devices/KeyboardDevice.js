import { IODevice } from './IODevice.js';

class KeyboardDevice extends IODevice {
    constructor() {
        super('Keyboard');
        this.buffer = []; // Each entry: { char: number, scan: number }
    }

    getPortRange() {
        return [0x60];
    }

    /** Push a key into the buffer (max 16 entries). */
    enqueue(charCode, scanCode) {
        if (this.buffer.length < 16) {
            this.buffer.push({ char: charCode & 0xFF, scan: scanCode & 0xFF });
        }
    }

    /** Remove and return the front entry, or null if empty. */
    dequeue() {
        return this.buffer.length > 0 ? this.buffer.shift() : null;
    }

    /** Peek at the front entry without consuming it, or null if empty. */
    peek() {
        return this.buffer.length > 0 ? this.buffer[0] : null;
    }

    /** Called by IOBus when the CPU executes IN AL, 0x60 */
    onRead(port, _bus) {
        if (port === 0x60) {
            const entry = this.dequeue();
            return entry ? entry.char : 0;
        }
    }

    onWrite(_port, _val, _bus) {
    }

    reset(_bus) {
        this.buffer = [];
    }
}

export { KeyboardDevice };
