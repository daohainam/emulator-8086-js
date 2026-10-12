import { IODevice } from './IODevice.js';

const OUTPUT_QUEUE_MAX = 16;
const STATUS_OUTPUT_FULL = 0x01;  // port 0x64 bit 0: a byte is waiting at port 0x60
const STATUS_SYSTEM_OK = 0x04;    // bit 2: self-test passed
const STATUS_KBD_ENABLED = 0x10;  // bit 4: keyboard not inhibited

/**
 * PC keyboard controller (8042-style).
 *
 *   0x60  read  : next scan code (set 1): make code on key press, make|0x80 on release
 *   0x64  read  : status (bit 0 = output buffer full)
 *
 * The host translates browser key events to (ASCII, scan code). The scan codes go through this
 * device so programs that install their own IRQ1 handler see real hardware behaviour; the
 * ASCII/scan pairs in `buffer` only feed the keyboard panel in the UI.
 */
class KeyboardDevice extends IODevice {
    constructor() {
        super('Keyboard');
        this.buffer = [];     // display only. Each entry: { char: number, scan: number }
        this.scanQueue = [];  // scan codes waiting to be read from port 0x60
        this.lastScan = 0;
    }

    getPortRange() {
        return [0x60, 0x64];
    }

    /** Record a key for the UI panel (max 16 entries). */
    enqueue(charCode, scanCode) {
        if (this.buffer.length < OUTPUT_QUEUE_MAX) {
            this.buffer.push({ char: charCode & 0xFF, scan: scanCode & 0xFF });
        }
    }

    /** Remove and return the front display entry, or null if empty. */
    dequeue() {
        return this.buffer.length > 0 ? this.buffer.shift() : null;
    }

    /** Peek at the front display entry without consuming it, or null if empty. */
    peek() {
        return this.buffer.length > 0 ? this.buffer[0] : null;
    }

    /** Queue a scan code for port 0x60. Returns false when the controller buffer is full. */
    pushScancode(code) {
        if (this.scanQueue.length >= OUTPUT_QUEUE_MAX) return false;
        this.scanQueue.push(code & 0xFF);
        return true;
    }

    onRead(port, _bus) {
        if (port === 0x60) {
            if (this.scanQueue.length > 0) this.lastScan = this.scanQueue.shift();
            return this.lastScan; // an empty controller keeps presenting the last byte
        }
        if (port === 0x64) {
            return STATUS_SYSTEM_OK | STATUS_KBD_ENABLED | (this.scanQueue.length > 0 ? STATUS_OUTPUT_FULL : 0);
        }
        return undefined;
    }

    onWrite(_port, _val, _bus) {
        // Controller commands and keyboard LED/typematic bytes are accepted and ignored.
    }

    reset(_bus) {
        this.buffer = [];
        this.scanQueue = [];
        this.lastScan = 0;
    }
}

export { KeyboardDevice };
